import { fail } from './auth.mjs';
import { safeText } from './security.mjs';

export function fields(body, kind, existing) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_input', '请求必须是 JSON 对象');
  const defaults = { name: '', notes: '', enabled: true, whitelist: [], ...(kind === 'upstreams' ? { priority: 0, load_factor: 1, max_concurrency: 2 } : { expires_at: null }) };
  const result = { ...defaults, ...existing };
  for (const key of Object.keys(defaults)) if (Object.hasOwn(body, key)) result[key] = body[key];
  for (const [key, max] of [['name', 100], ['notes', 2000]]) {
    if (typeof result[key] !== 'string' || result[key].length > max || safeText(result[key]) !== result[key]) fail(400, 'invalid_input', '名称和备注长度无效，或包含不应公开的凭据');
    result[key] = result[key].trim();
  }
  if (!result.name || typeof result.enabled !== 'boolean') fail(400, 'invalid_input', '名称不能为空，启用状态必须为布尔值');
  if (!Array.isArray(result.whitelist) || result.whitelist.length > 1000 || result.whitelist.some(m => typeof m !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./:@+-]*\*?$/.test(m) || m.length > 200 || safeText(m) !== m)) fail(400, 'invalid_input', '白名单支持精确模型名和尾部 * 前缀匹配');
  result.whitelist = [...new Set(result.whitelist)];
  if (kind === 'upstreams') {
    for (const [key, min, max] of [['priority', 0, 1000], ['load_factor', 1, 1000], ['max_concurrency', 1, 128]]) {
      if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) fail(400, 'invalid_input', `${key} 必须在 ${min}–${max} 之间`);
    }
    if (!existing || Object.hasOwn(body, 'credential')) {
      if (typeof body.credential !== 'string' || !/^user_[A-Za-z0-9_-]{8,256}$/.test(body.credential)) fail(400, 'invalid_input', '请输入有效的 user_ 上游凭据');
    }
  } else if (result.expires_at !== null && (!Number.isSafeInteger(result.expires_at) || result.expires_at <= Date.now())) fail(400, 'invalid_input', '过期时间必须是未来时间');
  return result;
}

export function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
export async function bodyJSON(req, limit = 64 * 1024) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'invalid_content_type', '请使用 application/json');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let settled = false; let drained = 0;
    req.on('data', chunk => {
      if (settled) { drained += chunk.length; if (drained > 1024 * 1024) req.destroy(); return; }
      size += chunk.length;
      if (size > limit) { settled = true; chunks.length = 0; reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'body_too_large' })); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return; settled = true;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(Object.assign(new Error('无效 JSON 对象'), { status: 400, code: 'invalid_json' })); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('请求已取消'), { status: 400, code: 'aborted' })));
  });
}
