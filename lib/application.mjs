import { createReadStream, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { Repository } from './repository.mjs';
import { Auth, fail } from './auth.mjs';
import { hashPassword } from './security.mjs';
import { Scheduler } from './scheduler.mjs';
import { UpstreamService } from './upstream.mjs';
import { BillingService } from './billing.mjs';
import { bodyJSON, fields, json } from './http.mjs';
import { handleChatCompletions, handleMessages, handleResponses, runProtocol } from '../protocols.mjs';
import { parseProxyUrl, proxyLabel } from './proxy.mjs';
import { probeProxy } from './proxy-probe.mjs';

const protocolHandlers = { '/v1/chat/completions': handleChatCompletions, '/v1/messages': handleMessages, '/v1/responses': handleResponses };
export async function createApplication({ databasePath = ':memory:', masterKey, initialPassword, initialAdminEmail = 'admin@example.com', origin = 'http://localhost:3050', internalBaseUrl = 'http://127.0.0.1:3051/v1', apiBase = 'https://api.commandcode.ai', assetsPath = resolve('frontend/dist'), maxInflight = 4, maxBodyBytes = 8 * 1024 * 1024, trustProxy = false } = {}) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new Error('A 32-byte master key is required');
  const repo = new Repository(databasePath, masterKey);
  if (!repo.admin()) {
    if (typeof initialPassword !== 'string' || initialPassword.length < 12) { repo.close(); throw new Error('Administrator initialization secret is required'); }
    repo.setAdmin(initialAdminEmail, await hashPassword(initialPassword));
  }
  const auth = new Auth(repo, origin); const scheduler = new Scheduler(repo); const upstream = new UpstreamService(repo, scheduler, apiBase);
  const billing = new BillingService(repo, apiBase);
  const upstreamView = row => { const proxy = repo.proxy(row.id); return { ...scheduler.view(row), proxy_label: proxy ? proxyLabel(proxy) : null }; };
  const submittedProxy = body => {
    if (!Object.hasOwn(body, 'proxy_url')) return undefined;
    if (body.proxy_url === null) return null;
    try { return parseProxyUrl(body.proxy_url).url; }
    catch (error) { fail(400, 'invalid_input', error.message); }
  };
  let active = 0;
  const ipOf = req => trustProxy ? String(req.headers['x-cc-client-ip'] || req.socket.remoteAddress || '').slice(0, 64) : req.socket.remoteAddress || '';
  const protect = handler => async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try { await handler(req, res, new URL(req.url, 'http://localhost')); }
    catch (error) {
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      if (!res.headersSent) json(res, error.status || 500, { error: { code: error.code || 'internal_error', type: error.code || 'internal_error', message: error.status ? error.message : '服务暂时不可用' } });
      else if (!res.writableEnded) res.end();
    }
  };
  const management = protect(async (req, res, url) => {
    const path = url.pathname; const method = req.method;
    if (path === '/health' && method === 'GET') return json(res, 200, { status: 'ok' });
    if (path === '/command' && method === 'GET') { res.writeHead(308, { Location: '/command/' }); return res.end(); }
    if (path.startsWith('/command/v1') || !path.startsWith('/command/')) fail(404, 'not_found', 'Not found');
    if (!path.startsWith('/command/api/')) {
      if (method !== 'GET' && method !== 'HEAD') fail(404, 'not_found', 'Not found');
      let file;
      if (path === '/command/' || path === '/command/index.html') file = resolve(assetsPath, 'index.html');
      else if (/^\/command\/assets\/[A-Za-z0-9_.-]+$/.test(path)) file = resolve(assetsPath, path.slice('/command/'.length));
      else fail(404, 'not_found', 'Not found');
      if (!file.startsWith(resolve(assetsPath) + sep) || !existsSync(file)) fail(404, 'not_found', 'Not found');
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable' });
      if (method === 'HEAD') return res.end();
      const stream = createReadStream(file); stream.on('error', () => res.destroy()); res.once('close', () => stream.destroy()); stream.pipe(res); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const ip = ipOf(req);
    if (path === '/command/api/auth/session' && method === 'GET') { const result = auth.describe(req, res); return json(res, result.status, result.body); }
    if (path === '/command/api/auth/login' && method === 'POST') return json(res, 200, await auth.login(req, res, await bodyJSON(req), ip));
    const session = auth.require(req);
    if (!['GET', 'HEAD'].includes(method)) auth.csrf(req, session);
    if (path === '/command/api/auth/session' && method === 'DELETE') { auth.logout(res, session, ip); return json(res, 200, { ok: true }); }
    if (path === '/command/api/auth/password' && method === 'PATCH') { await auth.changePassword(session, await bodyJSON(req), ip); return json(res, 200, { ok: true }); }
    if (path === '/command/api/auth/sessions/others' && method === 'DELETE') { auth.revokeOthers(session, ip); return json(res, 200, { ok: true }); }
    if (path === '/command/api/overview' && method === 'GET') {
      const accounts = repo.list('upstreams').map(a => scheduler.view(a));
      return json(res, 200, { accounts: accounts.length, healthy: accounts.filter(a => a.health === 'healthy' && scheduler.available(a)).length, models: scheduler.allowedModels({ whitelist: [] }).length, clients: repo.list('clients').length, inflight: [...scheduler.inflight.values()].reduce((n, a) => n + a, 0), requests: accounts.reduce((n, a) => n + a.requests, 0), successes: accounts.reduce((n, a) => n + a.successes, 0), errors: accounts.reduce((n, a) => n + a.errors, 0), recent_errors: accounts.filter(a => a.last_error).map(a => ({ id: a.id, name: a.name, error: a.last_error })), internal_base_url: internalBaseUrl });
    }
    if (path === '/command/api/audit' && method === 'GET') {
      const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) fail(400, 'invalid_input', '分页参数无效');
      return json(res, 200, { data: repo.audits(before) });
    }
    const match = path.match(/^\/command\/api\/(upstreams|clients)(?:\/([a-zA-Z0-9-]+))?(?:\/(test|models\/refresh|rotate|billing\/refresh|proxy\/check))?$/);
    if (!match) fail(404, 'not_found', 'Not found');
    const [, kind, id, action] = match;
    if (kind === 'upstreams' && id === 'batch' && method === 'POST') {
      const body = await bodyJSON(req);
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000 || body.ids.some(id => typeof id !== 'string') || typeof body.enabled !== 'boolean') fail(400, 'invalid_input', '请选择账号与启用状态');
      const rows = [...new Set(body.ids)].map(id => repo.get(kind, id));
      if (rows.some(row => !row)) fail(404, 'not_found', '账号不存在');
      repo.transaction(() => { for (const row of rows) { repo.save(kind, { ...row, enabled: body.enabled }); repo.audit('upstreams.update', row.id, 'success', ip); } });
      return json(res, 200, { ok: true });
    }
    if (!id) {
      if (method === 'GET') return json(res, 200, { data: repo.list(kind).map(a => kind === 'upstreams' ? upstreamView(a) : a) });
      if (method === 'POST') {
        const body = await bodyJSON(req); const value = fields(body, kind);
        const proxy = kind === 'upstreams' ? submittedProxy(body) : undefined;
        const result = kind === 'upstreams' ? repo.transaction(() => { const row = repo.createUpstream(value, body.credential); if (proxy) repo.setProxy(row.id, proxy); return row; }) : repo.createClient(value);
        repo.audit(`${kind}.create`, result.id, 'success', ip);
        return json(res, 201, kind === 'upstreams' ? upstreamView(result) : result);
      }
    }
    const row = repo.get(kind, id);
    if (!row) fail(404, 'not_found', '记录不存在');
    if (kind === 'upstreams' && action === 'proxy/check' && method === 'POST') {
      const proxy = repo.proxy(id);
      if (!proxy) fail(400, 'proxy_not_configured', '请先为此账号配置专属代理');
      if (active >= maxInflight) fail(503, 'server_busy', '服务繁忙，请稍后检测', 5);
      active++;
      const abort = new AbortController(); const close = () => { if (!res.writableEnded) abort.abort(); }; res.once('close', close);
      try {
        const result = await probeProxy(proxy, abort.signal);
        if (!repo.get('upstreams', id) || repo.proxy(id) !== proxy) fail(409, 'account_changed', '代理已改变，请重新检测');
        const latest = repo.save('upstreams', { ...repo.get('upstreams', id), proxy_probe: result });
        repo.audit('upstreams.proxy.check', id, result.success ? 'success' : 'failure', ip);
        return json(res, 200, upstreamView(latest));
      } finally { active--; res.removeListener('close', close); }
    }
    if (kind === 'upstreams' && action === 'billing/refresh' && method === 'POST') {
      if (active >= maxInflight) fail(503, 'server_busy', '服务繁忙，请稍后刷新', 5);
      active++;
      try { return json(res, 200, upstreamView(await billing.refresh(id))); }
      finally { active--; }
    }
    if (!action) {
      if (method === 'GET') return json(res, 200, kind === 'upstreams' ? upstreamView(row) : row);
      if (method === 'PATCH') {
        const body = await bodyJSON(req); let value = fields(body, kind, row);
        const proxy = kind === 'upstreams' ? submittedProxy(body) : undefined;
        repo.transaction(() => {
          repo.save(kind, value);
          if (kind === 'upstreams' && Object.hasOwn(body, 'credential')) value = repo.replaceCredential(id, body.credential);
          if (kind === 'upstreams' && proxy !== undefined) repo.setProxy(id, proxy);
          repo.audit(`${kind}.update`, id, 'success', ip);
        });
        return json(res, 200, kind === 'upstreams' ? upstreamView(repo.get(kind, id)) : value);
      }
      if (method === 'DELETE') { repo.remove(kind, id); scheduler.weights.delete(id); repo.audit(`${kind}.delete`, id, 'success', ip); return json(res, 200, { ok: true }); }
    }
    if (method === 'POST') {
      if (kind === 'clients' && action === 'rotate') {
        const body = await bodyJSON(req); const grace = body.grace_seconds ?? 0;
        if (!Number.isInteger(grace) || grace < 0 || grace > 3600) fail(400, 'invalid_input', '轮换并行窗口须为 0–3600 秒');
        const result = repo.rotateClient(id, grace); repo.audit('clients.rotate', id, 'success', ip); return json(res, 200, result);
      }
      if (kind === 'upstreams' && (action === 'models/refresh' || action === 'test')) {
        if (active >= maxInflight) fail(503, 'server_busy', '服务繁忙，请稍后测试', 5);
        active++;
        try {
          if (action === 'models/refresh') {
            const abort = new AbortController(); const close = () => { if (!res.writableEnded) abort.abort(); }; res.once('close', close);
            try { const result = await upstream.refresh(id, abort.signal); repo.audit('upstreams.models', id, 'success', ip); return json(res, 200, upstreamView(result)); }
            finally { res.removeListener('close', close); }
          }
          const body = await bodyJSON(req); const success = await upstream.test(req, res, id, body);
          repo.audit('upstreams.test', id, success ? 'success' : 'failure', ip); return;
        } catch (error) { repo.audit(action === 'test' ? 'upstreams.test' : 'upstreams.models', id, 'failure', ip); throw error; }
        finally { active--; }
      }
    }
    fail(404, 'not_found', 'Not found');
  });
  const inference = protect(async (req, res, url) => {
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
    const handler = protocolHandlers[url.pathname]; const isModels = url.pathname === '/v1/models' && req.method === 'GET';
    if (!isModels && (!handler || req.method !== 'POST')) fail(404, 'not_found', 'Not found');
    const bearer = String(req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const client = repo.authenticateClient(bearer) || repo.authenticateClient(req.headers['x-api-key']);
    if (!client) fail(401, 'authentication_error', 'Invalid API key');
    if (isModels) {
      const data = scheduler.allowedModels(client).map(id => ({ id, object: 'model', created: 0, owned_by: 'command-code' }));
      repo.countClient(client.id, true, Date.now()); return json(res, 200, { object: 'list', data });
    }
    if (active >= maxInflight) fail(503, 'server_busy', 'Too many concurrent requests', 5);
    active++;
    const abort = new AbortController(); const close = () => { if (!res.writableEnded) abort.abort(); }; res.once('close', close);
    let lease; let success = false; const started = Date.now(); const context = { apiBase, signal: abort.signal, status: null, dispatched: false, proxyUrl: null };
    try {
      const body = await bodyJSON(req, maxBodyBytes);
      if (typeof body.model !== 'string' || !body.model || body.model.length > 200) fail(400, 'invalid_input', 'A model is required');
      lease = scheduler.acquire(body.model, client);
      context.proxyUrl = repo.proxy(lease.account.id);
      req.parsedBody = body;
      const credential = repo.credential(lease.account.id);
      req.headers = { ...req.headers, authorization: `Bearer ${credential}` };
      delete req.headers['x-api-key']; delete req.headers.cookie;
      await runProtocol(context, () => handler(req, res));
      success = context.dispatched && context.status >= 200 && context.status < 300 && res.statusCode < 400 && !abort.signal.aborted && res.writableEnded;
    } finally {
      active--; lease?.release(); res.removeListener('close', close);
      if (lease && context.dispatched && repo.get('upstreams', lease.account.id) && repo.proxy(lease.account.id) === context.proxyUrl) scheduler.result(lease.account.id, { status: success ? 200 : context.status >= 400 ? context.status : res.statusCode >= 400 ? res.statusCode : 0, retryAfter: context.retryAfter, cancelled: abort.signal.aborted });
      repo.countClient(client.id, success, started); abort.abort();
      if (!res.writableEnded && !res.destroyed && context.dispatched) json(res, 502, { error: { code: 'upstream_error', message: 'Upstream response interrupted' } });
    }
  });
  return { management, inference, repo, scheduler, upstream, close: () => repo.close() };
}
