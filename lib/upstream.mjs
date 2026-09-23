import { once } from 'node:events';
import { fail } from './auth.mjs';
import { supports } from './scheduler.mjs';
import { safeText } from './security.mjs';
import { buildCcRequest, forwardToCC, runProtocol, upstreamFetch } from '../protocols.mjs';

export class UpstreamService {
  constructor(repo, scheduler, apiBase) { this.repo = repo; this.scheduler = scheduler; this.apiBase = apiBase; }
  async refresh(id, signal) {
    const started = Date.now();
    const credential = this.repo.credential(id);
    const proxy = this.repo.proxy(id);
    let status = 0; let retryAfter;
    try {
      const response = await upstreamFetch(`${this.apiBase}/provider/v1/models`, {
        headers: { Authorization: `Bearer ${credential}`, 'x-cli-environment': 'production' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)].filter(Boolean)),
      }, proxy);
      status = response.status; retryAfter = response.headers.get('retry-after');
      if (!response.ok) { await response.body?.cancel(); fail(502, 'upstream_error', `模型目录请求失败（HTTP ${status}）`); }
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2 * 1024 * 1024) throw new Error('model_catalog_too_large'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!Array.isArray(body.data) || body.data.some(m => !m || typeof m.id !== 'string' || m.id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_./:@+-]*$/.test(m.id) || safeText(m.id) !== m.id)) throw new Error('invalid_catalog');
      const current = this.repo.get('upstreams', id);
      if (!current || this.repo.credential(id) !== credential || this.repo.proxy(id) !== proxy) fail(409, 'account_changed', '账号已更改，请重新测试');
      current.models = [...new Set(body.data.map(m => m.id))].map(id => ({ id }));
      current.models_refreshed_at = Date.now(); current.models_error = null;
      this.repo.save('upstreams', current);
      this.scheduler.result(id, { status: 200, latency: Date.now() - started, manual: true, count: false });
      return this.scheduler.view(this.repo.get('upstreams', id));
    } catch (error) {
      if (error.status === 409) throw error;
      const current = this.repo.get('upstreams', id);
      if (current && this.repo.credential(id) === credential && this.repo.proxy(id) === proxy) {
        current.models_error = status >= 400 ? `模型目录请求失败（HTTP ${status}）` : '模型目录网络异常或格式无效';
        this.repo.save('upstreams', current);
        this.scheduler.result(id, { status: status >= 400 ? status : 0, retryAfter, latency: Date.now() - started, manual: true, count: false });
      }
      fail(502, 'upstream_error', status >= 400 ? `模型目录请求失败（HTTP ${status}）` : '模型目录网络异常或格式无效');
    }
  }
  async test(req, res, id, body) {
    if (typeof body.model !== 'string' || body.model.length > 200 || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000) fail(400, 'invalid_input', '请选择模型，并输入不超过 4000 字的提示词');
    const account = this.repo.get('upstreams', id);
    if (!supports(account, body.model)) fail(403, 'model_not_allowed', '测试模型不在账号目录与白名单中');
    const lease = this.scheduler.reserve(account);
    const abort = new AbortController(); const started = Date.now();
    const close = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', close);
    const context = { apiBase: this.apiBase, status: 0, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]), proxyUrl: this.repo.proxy(id) };
    const credential = this.repo.credential(id);
    let reader; let complete = false; let first = true; let bytes = 0;
    const emit = async (event, data) => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) await once(res, 'drain', { signal: context.signal });
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    await emit('connecting', { elapsed_ms: 0 });
    try {
      await runProtocol(context, async () => {
        const response = await forwardToCC(buildCcRequest({ model: body.model, messages: [{ role: 'user', content: body.prompt }], max_tokens: 64, stream: true }), credential, {}, context.signal);
        await emit('connected', { elapsed_ms: Date.now() - started, status: response.status });
        if (!response.ok) { await response.body?.cancel(); throw new Error('upstream_status'); }
        reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        const processLine = async line => {
          if (!line.trim()) return;
          const event = JSON.parse(line);
          if (event.type === 'error') {
            const match = String(event.error?.message || event.message || '').match(/^<(\d{3})>/);
            const reported = match ? Number(match[1]) : event.error?.statusCode;
            context.status = Number.isInteger(reported) && reported >= 400 && reported <= 599 ? reported : 502;
            throw new Error('upstream_event');
          }
          if (event.type === 'text-delta' || event.type === 'reasoning-delta') await emit('text', { text: safeText(event.text ?? event.delta ?? event.textDelta ?? ''), kind: event.type });
          if (event.type === 'finish') complete = true;
        };
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > 1024 * 1024) throw new Error('test_output_limit');
          if (first) { first = false; await emit('first_byte', { elapsed_ms: Date.now() - started }); }
          buffer += decoder.decode(value, { stream: true });
          let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); await processLine(line); }
        }
        buffer += decoder.decode(); if (buffer.trim()) await processLine(buffer);
        if (!complete) throw new Error('incomplete_generation');
      });
      await emit('done', { success: true, elapsed_ms: Date.now() - started });
    } catch {
      if (!(context.status >= 400)) context.status = 0;
      await emit('done', { success: false, elapsed_ms: Date.now() - started, error: context.status >= 400 ? `上游请求失败（HTTP ${context.status}）` : '生成中断、超时或响应无效' }).catch(() => {});
    } finally {
      if (reader) await reader.cancel().catch(() => {});
      abort.abort(); lease.release();
      if (this.repo.get('upstreams', id) && this.repo.credential(id) === credential && this.repo.proxy(id) === context.proxyUrl) this.scheduler.result(id, { status: context.status, retryAfter: context.retryAfter, latency: Date.now() - started, manual: true });
      res.removeListener('close', close); res.end();
    }
    return context.status >= 200 && context.status < 300;
  }
}
