// 连接生命周期与错误可观测性。
// 这组用例来自一次真实线上故障的排查（间歇性反代 502 / 客户端 connection error）：
//   ① 上游 error 事件自带 statusCode，被丢掉后 429/503 一律塌成 502
//   ② 无内容事件的静默列表不全，Response 非流式那条**根本没有**，日志被刷屏
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

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
