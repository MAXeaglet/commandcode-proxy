import { digest, equal, hashPassword, verifyPassword, token } from './security.mjs';

export class HttpError extends Error {
  constructor(status, code, message, retryAfter) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
export const fail = (status, code, message, retryAfter) => { throw new HttpError(status, code, message, retryAfter); };
const cookie = (name, value, age) => `${name}=${value}; Max-Age=${age}; Path=/command; Secure; HttpOnly; SameSite=Strict`;
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=')));
const SESSION_AGE = 12 * 60 * 60;

export class Auth {
  constructor(repo, origin) { this.repo = repo; this.origin = origin; this.pending = new Map(); }
  session(req) {
    const value = cookies(req).cc_session;
    if (!value || value.length > 128) return null;
    return this.repo.db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(digest(value), Date.now()) || null;
  }
  require(req) {
    const session = this.session(req);
    if (!session) fail(401, 'unauthenticated', '请先登录管理控制台');
    return session;
  }
  csrf(req, session) {
    if (req.headers.origin !== this.origin || req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'csrf_invalid', '请求来源验证失败');
    const expected = session?.csrf || cookies(req).cc_login;
    if (!expected || expected.length < 32 || !equal(req.headers['x-csrf-token'], expected)) fail(403, 'csrf_invalid', '安全令牌失效，请刷新页面');
  }
  describe(req, res) {
    const session = this.session(req);
    if (session) return { status: 200, body: { email: this.repo.admin().email, csrf: session.csrf, expires_at: session.expires } };
    const csrf = token();
    res.setHeader('Set-Cookie', cookie('cc_login', csrf, 900));
    return { status: 401, body: { error: { code: 'unauthenticated', message: '请先登录' }, csrf } };
  }
  async login(req, res, body, ip) {
    this.csrf(req);
    if (typeof body.email !== 'string' || body.email.length > 254 || typeof body.password !== 'string' || body.password.length > 1024) fail(400, 'invalid_input', '请输入有效的邮箱和密码');
    const email = body.email.trim().toLowerCase();
    // Hash bucket names: never persist attempted passwords or attacker-controlled account text.
    const buckets = [`ip:${digest(ip)}`, `account:${digest(email)}`];
    const now = Date.now();
    for (const bucket of buckets) {
      const row = this.repo.db.prepare('SELECT * FROM login_limits WHERE bucket=?').get(bucket);
      if (row?.locked_until > now) fail(429, 'login_locked', '连续登录失败，请在 15 分钟后重试', Math.ceil((row.locked_until - now) / 1000));
      if ((this.pending.get(bucket) || 0) >= 5) fail(429, 'login_locked', '登录尝试过于频繁，请稍后重试', 60);
    }
    for (const bucket of buckets) this.pending.set(bucket, (this.pending.get(bucket) || 0) + 1);
    try {
      const admin = this.repo.admin();
      const valid = await verifyPassword(body.password, admin.password);
      if (!valid || email !== admin.email) {
        let locked = false;
        for (const bucket of buckets) {
          const row = this.repo.db.prepare('SELECT * FROM login_limits WHERE bucket=?').get(bucket);
          const failures = row && now - row.updated < 15 * 60_000 && row.locked_until <= now ? row.failures + 1 : 1;
          const until = row?.locked_until > now ? row.locked_until : failures >= 5 ? Date.now() + 15 * 60_000 : 0;
          locked ||= until > now;
          this.repo.db.prepare('INSERT OR REPLACE INTO login_limits VALUES(?,?,?,?)').run(bucket, failures, until, Date.now());
        }
        this.repo.audit('auth.login', '', 'failure', ip);
        fail(locked ? 429 : 401, locked ? 'login_locked' : 'invalid_credentials', locked ? '连续失败 5 次，已锁定 15 分钟' : '邮箱或密码不正确', locked ? 900 : undefined);
      }
      // A lock established by another in-flight attempt also applies to this attempt.
      for (const bucket of buckets) {
        const row = this.repo.db.prepare('SELECT locked_until FROM login_limits WHERE bucket=?').get(bucket);
        if (row?.locked_until > Date.now()) fail(429, 'login_locked', '账号暂时锁定', Math.ceil((row.locked_until - Date.now()) / 1000));
        this.repo.db.prepare('DELETE FROM login_limits WHERE bucket=?').run(bucket);
      }
      this.repo.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
      this.repo.db.prepare('DELETE FROM login_limits WHERE updated<? AND locked_until<?').run(now - 86400_000, now);
      const value = token(); const csrf = token(); const expires = Date.now() + SESSION_AGE * 1000;
      this.repo.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(value), csrf, expires);
      res.setHeader('Set-Cookie', [cookie('cc_session', value, SESSION_AGE), cookie('cc_login', '', 0)]);
      this.repo.audit('auth.login', '', 'success', ip);
      return { email: admin.email, csrf, expires_at: expires };
    } finally {
      for (const bucket of buckets) { const n = this.pending.get(bucket) - 1; if (n) this.pending.set(bucket, n); else this.pending.delete(bucket); }
    }
  }
  logout(res, session, ip) {
    this.repo.db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash);
    res.setHeader('Set-Cookie', cookie('cc_session', '', 0));
    this.repo.audit('auth.logout', '', 'success', ip);
  }
  revokeOthers(session, ip) {
    this.repo.db.prepare('DELETE FROM sessions WHERE hash<>?').run(session.hash);
    this.repo.audit('auth.revoke_others', '', 'success', ip);
  }
  async changePassword(session, body, ip) {
    if (typeof body.current_password !== 'string' || body.current_password.length > 1024 || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) fail(400, 'invalid_input', '新密码须为 12–128 个字符');
    const old = this.repo.admin();
    if (!await verifyPassword(body.current_password, old.password)) fail(403, 'invalid_credentials', '当前密码不正确');
    const password = await hashPassword(body.password);
    this.repo.transaction(() => {
      if (this.repo.admin().password !== old.password || !this.repo.db.prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?').get(session.hash, Date.now())) fail(401, 'session_changed', '会话已失效，请重新登录');
      this.repo.setAdmin(old.email, password);
      this.revokeOthers(session, ip);
      this.repo.audit('auth.password', '', 'success', ip);
    });
  }
}
