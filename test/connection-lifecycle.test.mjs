// 连接生命周期与错误可观测性。
// 这组用例来自一次真实线上故障的排查（间歇性反代 502 / 客户端 connection error）：
//   ① 上游 error 事件自带 statusCode，被丢掉后 429/503 一律塌成 502
//   ② 无内容事件的静默列表不全，Responses 非流式那条**根本没有**，日志被刷屏
//   ③ 流空闲超时用 res.destroy() 收尾，把"代理主动截断"变成"把客户端连接搞断"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, startProxy, allocPort, closeServer } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

// ── ① error 事件自带的 statusCode 必须被采纳 ──────────────────
// CLI 的 readStreamErrorEvent 读的就是 error.statusCode / error.isRetryable，
// 取值链是 parseEmbeddedErrorJSON(message)?.status ?? error.statusCode ?? null。
// 原实现只看 message 里的 "<NNN>" 前缀，statusCode 全被丢掉 → 一律塌成 502。

test('error 事件带 statusCode=429 → 回 429 且带 retry_after（不是 502）', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"partial"}',
    '{"type":"error","error":{"message":"providers are currently at capacity","statusCode":429}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    const j = await r.json();
    assert.equal(r.status, 429, 'statusCode 是上游给的，不能抹成 502「服务端错误」');
    assert.equal(j.error.type, 'rate_limit_error');
    assert.equal(j.retry_after, 30, '429 要带退避提示，否则客户端不知道等多久');
  } finally { await s.close(); }
});

test('error 事件带 statusCode=503 → 回 503', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"error","error":{"message":"service unavailable","statusCode":503}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r.status, 503);
  } finally { await s.close(); }
});

test('error 事件没有 statusCode → 回落 502（保持原行为）', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"error","error":{"message":"something broke"}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r.status, 502);
  } finally { await s.close(); }
});

test('message 里的 "<NNN>" 前缀优先于 statusCode（对齐 CLI 的取值链）', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"error","error":{"message":"<400> bad request","statusCode":503}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r.status, 400, '<NNN> 前缀是最优先的取值来源');
  } finally { await s.close(); }
});

// ── ② 无内容事件不应产生 Unknown CC event type 警告 ────────────
// 上游每个响应都会发一串不携带内容的事件（text-start / text-end / start /
// start-step / reasoning-start / reasoning-end / provider-metadata /
// tool-input-start|delta|end / tool-error）。Responses 非流式那条路径原先
// 一个静默列表都没有，每个响应刷十来条 warn，真正的错误被淹没。

test('标准 NDJSON 序列不产生任何 Unknown CC event type 警告（三协议 × 流式/非流式）', async () => {
  const s = await setup();
  try {
    const msg = { model: 'm', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] };
    await (await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH)).text();
    await (await s.proxy.post('/v1/chat/completions', CHAT, AUTH)).text();
    await (await s.proxy.post('/v1/messages', { ...msg, stream: true }, { 'x-api-key': 'user_test' })).text();
    await (await s.proxy.post('/v1/messages', msg, { 'x-api-key': 'user_test' })).text();
    await (await s.proxy.post('/v1/responses', { model: 'm', stream: true, input: 'hi' }, AUTH)).text();
    await (await s.proxy.post('/v1/responses', { model: 'm', input: 'hi' }, AUTH)).text();

    const logs = s.proxy.logs();
    assert.ok(!logs.includes('Unknown CC event type'),
      '不应出现 Unknown CC event type 警告，实际命中：\n' +
      logs.split('\n').filter(l => l.includes('Unknown CC')).join('\n'));
  } finally { await s.close(); }
});

// ── ③ 流空闲超时必须用 end() 收尾，不能 destroy() ──────────────
// 原实现是 res.write(errEvent) 紧跟 res.destroy()：write 是异步的，destroy 会把
// 尚未刷出的缓冲丢掉并发 RST。反代侧看到的就是 "upstream prematurely closed
// connection" —— 响应头未转发时回 502，已转发时客户端看到 connection error。
//
// 判别方式：客户端必须能**完整读到**已产生的 delta 与超时错误事件。
// destroy 会让这条读挂掉（ECONNRESET / terminated），end 则正常收束。

/** 一个只在 /alpha/generate 上"发一半就挂住"的上游；其余路由正常应答。 */
async function startStallingUpstream() {
  const port = await allocPort();
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url !== '/alpha/generate') {
        // 预请求（fingerprint / lifecycle）必须正常应答，否则代理会卡在初始化上
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('{"type":"text-start"}\n');
      res.write('{"type":"text-delta","text":"partial-content"}\n');
      // 之后不再写任何数据 → 触发代理的流空闲超时
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port, close: () => closeServer(server) };
}

test('流空闲超时以 end() 收尾：已产生内容 + 错误事件都能完整送达', async () => {
  const upstream = await startStallingUpstream();
  const proxy = await startProxy({ upstreamPort: upstream.port, env: { CC_STREAM_IDLE_MS: '300' } });
  try {
    const r = await proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('partial-content'),
      '已发出的内容不能因为收尾方式而丢失（destroy 会丢缓冲 + RST）');
    assert.ok(text.includes('rate_limit_error'),
      '超时错误事件必须完整送进流里，下游 SDK 才能按可重试错误处理');
  } finally { await proxy.kill(); await upstream.close(); }
});


// ── ④ keep-alive 时序必须在启动横幅里可见 ──────────────────────
// 反代的 upstream keepalive_timeout 必须小于后端的 keepAliveTimeout，否则反代会
// 复用一条后端已关闭的连接，写请求体时吃 EPIPE（POST 非幂等、nginx 默认不重试
// → 客户端直接 502）。Node 默认 5s 与反代常见的 4s 只差 1 秒，太薄。
test('启动横幅打出 keepAliveTimeout，便于与反代配置对齐', async () => {
  const s = await setup();
  try {
    const logs = s.proxy.logs();
    assert.ok(/keepAliveTimeout[":\s]+65000ms/.test(logs),
      '启动横幅必须打出 keepAliveTimeout。实际：\n' +
      logs.split('\n').filter(l => l.includes('CC Proxy started')).join('\n'));
    assert.ok(logs.includes('反代侧 keepalive_timeout 必须小于它'),
      '必须提示反代侧的对应设置，否则这个值没有可操作性');
  } finally { await s.close(); }
});

