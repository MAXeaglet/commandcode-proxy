// issue #38：上游「没有正常走完」的四种情形都必须如实上报，不能谎报成功。
// 对齐 CLI（command-code@1.54.0 dist/cli.mjs）：
//   normalizeStopReason2 把 max_output_tokens / model_context_window_exceeded 归到 max_tokens
//   isNetworkFailureFinish 把 network/connection/upstream-error 当成可重试的 502
//   没有 finish 事件 → "Stream ended unexpectedly before completion (no finish event)"
//   pause_turn → CLI 靠自动续写吸收掉，代理不续写就必须原样透出
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

/** 造一段以给定 finishReason 收尾的 CC NDJSON */
const withFinish = (reason) => [
  '{"type":"text-start"}',
  '{"type":"text-delta","text":"partial"}',
  '{"type":"text-end"}',
  `{"type":"finish","finishReason":"${reason}","totalUsage":{"inputTokens":9,"outputTokens":3}}`,
];

/** 造一段**没有 finish 事件**就结束的 CC NDJSON（模拟上游中途被切断） */
const NO_FINISH = [
  '{"type":"text-start"}',
  '{"type":"text-delta","text":"partial"}',
  '{"type":"text-end"}',
];

async function openaiNonStream(s, body = CHAT) {
  const r = await s.proxy.post('/v1/chat/completions', body, AUTH);
  return { status: r.status, json: await r.json() };
}
async function anthropicNonStream(s) {
  const r = await s.proxy.post('/v1/messages',
    { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': 'user_test' });
  return { status: r.status, json: await r.json() };
}
async function responsesNonStream(s) {
  const r = await s.proxy.post('/v1/responses', { model: 'm', input: 'hi' }, AUTH);
  return { status: r.status, json: await r.json() };
}

// ── ① 截断类 finishReason 必须报成「截断」 ────────────────

test('#38 chat：max_output_tokens 报 finish_reason=length（原实现透出非法值）', async () => {
  const s = await setup({ ndjson: withFinish('max_output_tokens') });
  try {
    const { json } = await openaiNonStream(s);
    assert.equal(json.choices[0].finish_reason, 'length',
      'max_output_tokens 是「输出被截断」，必须归到 length，不能原样透出');
  } finally { await s.close(); }
});

test('#38 messages：model_context_window_exceeded 报 stop_reason=max_tokens（原先谎报 end_turn）', async () => {
  const s = await setup({ ndjson: withFinish('model_context_window_exceeded') });
  try {
    const { json } = await anthropicNonStream(s);
    assert.equal(json.stop_reason, 'max_tokens',
      '上下文撑爆意味着回答没写完，报 end_turn 会让下游以为模型自己说完了');
  } finally { await s.close(); }
});

test('#38 responses：max_output_tokens 报 status=incomplete', async () => {
  const s = await setup({ ndjson: withFinish('max_output_tokens') });
  try {
    const { json } = await responsesNonStream(s);
    assert.equal(json.status, 'incomplete');
    assert.deepEqual(json.incomplete_details, { reason: 'max_output_tokens' });
  } finally { await s.close(); }
});

// ── ② pause_turn 不能被吞掉 ──────────────────────────────

test('#38 messages：pause_turn 原样透出（Anthropic 原生枚举，表示后面还有内容）', async () => {
  const s = await setup({ ndjson: withFinish('pause_turn') });
  try {
    const { json } = await anthropicNonStream(s);
    assert.equal(json.stop_reason, 'pause_turn',
      'pause_turn 折成 end_turn 就是把半截回答谎报成完整的');
  } finally { await s.close(); }
});

test('#38 chat：pause_turn 折成 length（OpenAI 没有对应枚举，但不能折成 stop）', async () => {
  const s = await setup({ ndjson: withFinish('pause_turn') });
  try {
    const { json } = await openaiNonStream(s);
    assert.equal(json.choices[0].finish_reason, 'length',
      'OpenAI 的 finish_reason 只有 stop|length|tool_calls|content_filter|function_call；' +
      '折成 length 至少有「输出不完整」的含义，折成 stop 是谎报完成');
  } finally { await s.close(); }
});

test('#38 responses：pause_turn 报 status=incomplete', async () => {
  const s = await setup({ ndjson: withFinish('pause_turn') });
  try {
    const { json } = await responsesNonStream(s);
    assert.equal(json.status, 'incomplete');
    assert.deepEqual(json.incomplete_details, { reason: 'pause_turn' });
  } finally { await s.close(); }
});

// ── ③ provider 报连接失败 ────────────────────────────────

test('#38 chat：network-error 报 502 可重试（对齐 isNetworkFailureFinish）', async () => {
  const s = await setup({ ndjson: withFinish('network-error') });
  try {
    const { status, json } = await openaiNonStream(s);
    assert.equal(status, 502, 'CLI 对这一族一律抛可重试的 502');
    assert.equal(json.error.type, 'upstream_error');
    assert.equal(json.retry_after, 10);
  } finally { await s.close(); }
});

test('#38 messages：connection-error 报 502 可重试', async () => {
  const s = await setup({ ndjson: withFinish('connection_error') });
  try {
    const { status, json } = await anthropicNonStream(s);
    assert.equal(status, 502);
    assert.equal(json.error.type, 'upstream_error');
  } finally { await s.close(); }
});

// ── ④ 根本没有 finish 事件 ───────────────────────────────

test('#38 chat：无 finish 事件 → 502（而不是 200 + 一个沉默的短回答）', async () => {
  const s = await setup({ ndjson: NO_FINISH });
  try {
    const { status, json } = await openaiNonStream(s);
    assert.equal(status, 502, '流被切断时 CLI 抛 "no finish event" 的可重试 502');
    assert.equal(json.error.type, 'upstream_error');
    assert.match(json.error.message, /no finish event/);
  } finally { await s.close(); }
});

test('#38 messages：无 finish 事件 → 502', async () => {
  const s = await setup({ ndjson: NO_FINISH });
  try {
    const { status, json } = await anthropicNonStream(s);
    assert.equal(status, 502);
    assert.equal(json.error.type, 'upstream_error');
  } finally { await s.close(); }
});

test('#38 responses：无 finish 事件 → 502', async () => {
  const s = await setup({ ndjson: NO_FINISH });
  try {
    const { status } = await responsesNonStream(s);
    assert.equal(status, 502);
  } finally { await s.close(); }
});

// ── ⑤ 流式路径同样不能补一个假的结束时 ────────────────────

test('#38 messages 流式：无 finish 事件 → 发 event: error，且不发 message_stop', async () => {
  const s = await setup({ ndjson: NO_FINISH });
  try {
    const r = await s.proxy.post('/v1/messages',
      { model: 'm', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': 'user_test' });
    const text = await r.text();
    assert.ok(text.includes('event: error'), '必须显式报错');
    assert.ok(!text.includes('event: message_stop'),
      '不能补 message_stop —— 那等于告诉下游「这一轮正常结束了」');
  } finally { await s.close(); }
});

test('#38 chat 流式：无 finish 事件 → 发 error 对象，且不发 [DONE]', async () => {
  const s = await setup({ ndjson: NO_FINISH });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const text = await r.text();
    assert.ok(text.includes('upstream_error'), '必须显式报错');
    assert.ok(!text.includes('[DONE]'), '发了 [DONE] 就等于谎报流正常结束');
  } finally { await s.close(); }
});

// ── ⑥ 正常结束不能被误伤 ─────────────────────────────────

test('#38 回归：正常 finish 仍照常完成（三种协议）', async () => {
  const s = await setup({ ndjson: withFinish('stop') });
  try {
    const o = await openaiNonStream(s);
    assert.equal(o.status, 200);
    assert.equal(o.json.choices[0].finish_reason, 'stop');

    const a = await anthropicNonStream(s);
    assert.equal(a.status, 200);
    assert.equal(a.json.stop_reason, 'end_turn');

    const resp = await responsesNonStream(s);
    assert.equal(resp.status, 200);
    assert.equal(resp.json.status, 'completed');
  } finally { await s.close(); }
});

test('#38 回归：tool-calls 仍报 tool_use / tool_calls', async () => {
  const s = await setup({ ndjson: withFinish('tool-calls') });
  try {
    const o = await openaiNonStream(s);
    assert.equal(o.json.choices[0].finish_reason, 'tool_calls');
    const a = await anthropicNonStream(s);
    assert.equal(a.json.stop_reason, 'tool_use');
  } finally { await s.close(); }
});

// 回归：#38 排查期间发现的日志噪音。上游每个响应都会发一串无内容事件
// （text-start / text-end / start / start-step / reasoning-start / reasoning-end /
//  provider-metadata / tool-input-* / tool-error）。三条非流式路径原先缺少静默列表，
// 全部掉进 default 打成 'Unknown CC event type'，线上刷屏并把真正的错误淹掉。
test('标准 NDJSON 序列不产生任何 Unknown CC event type 警告（三协议 × 流式/非流式）', async () => {
  const s = await setup();
  try {
    const chat = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const msg = { model: 'm', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] };
    await (await s.proxy.post('/v1/chat/completions', { ...chat, stream: true }, AUTH)).text();
    await (await s.proxy.post('/v1/chat/completions', chat, AUTH)).text();
    await (await s.proxy.post('/v1/messages', { ...msg, stream: true }, { 'x-api-key': 'user_test' })).text();
    await (await s.proxy.post('/v1/messages', msg, { 'x-api-key': 'user_test' })).text();
    await (await s.proxy.post('/v1/responses', { model: 'm', stream: true, input: 'hi' }, AUTH)).text();
    await (await s.proxy.post('/v1/responses', { model: 'm', input: 'hi' }, AUTH)).text();

    const logs = s.proxy.logs();
    assert.ok(!logs.includes('Unknown CC event type'),
      '不应出现 Unknown CC event type 警告，实际日志片段：\n' +
      logs.split('\n').filter(l => l.includes('Unknown CC')).join('\n'));
  } finally { await s.close(); }
});


// 上游 error 事件自带 statusCode 时必须用它 —— CLI 的 readStreamErrorEvent 读的就是这个字段，
// 取值链是 parseEmbeddedErrorJSON(message)?.status ?? error.statusCode ?? null。
// 原实现只看 message 里的 "<NNN>" 前缀，statusCode 全被丢掉 → 429/503 塌成 502。
test('#38 error 事件带 statusCode 时按其映射（429 而非 502）', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"partial"}',
    '{"type":"error","error":{"message":"providers are currently at capacity","statusCode":429}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    const j = await r.json();
    assert.equal(r.status, 429, 'statusCode 是上游给的，不能抹成 502');
    assert.equal(j.error.type, 'rate_limit_error');
    assert.equal(j.retry_after, 30, '429 要带退避提示，否则客户端不知道等多久');
  } finally { await s.close(); }
});

test('#38 error 事件带 statusCode 时按其映射（503 而非 502）', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"error","error":{"message":"service unavailable","statusCode":503}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r.status, 503);
  } finally { await s.close(); }
});

test('#38 error 事件没有 statusCode 时仍回落 502（保持原行为）', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"error","error":{"message":"something broke"}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r.status, 502);
  } finally { await s.close(); }
});

test('#38 message 里的 "<NNN>" 前缀优先于 statusCode（对齐 CLI 的取值链）', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"error","error":{"message":"<400> bad request","statusCode":503}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r.status, 400, '<NNN> 前缀是最优先的取值来源');
  } finally { await s.close(); }
});


// 流空闲超时后必须以 end() 收尾。原先走的是 res.write(err) 紧跟 res.destroy()：
// write 是异步的，destroy 会把未刷出的缓冲丢掉并发 RST，反向代理那里就是
// "upstream prematurely closed connection" → 502，或者客户端看到 connection error。
// 断言方式：客户端必须能**完整读到**已产生的 delta 与超时错误事件 —— destroy 会让
// 这条读挂掉（ECONNRESET / 截断），end 则正常收束。
test('流空闲超时：已产生的内容 + 错误事件都能完整送达（不能 destroy 客户端 socket）', async () => {
  const s = await setup({
    env: { CC_STREAM_IDLE_MS: '300' },
    onRequest: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('{"type":"text-start"}\n');
      res.write('{"type":"text-delta","text":"partial-content"}\n');
      return true;   // 接管后挂住：不再发任何数据 → 触发空闲超时
    },
  });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('partial-content'), '已发出的内容不能因为收尾方式而丢失');
    assert.ok(text.includes('rate_limit_error'), '超时错误事件必须完整送进流里');
  } finally { await s.close(); }
});


// 反代场景的 keep-alive 时序：Node 的 keepAliveTimeout 必须**大于**反代的
// upstream keepalive_timeout。否则反代会复用后端已关闭的连接，写请求体时吃 EPIPE，
// 而 POST 是非幂等、nginx 默认不重试 → 客户端直接 502。
test('启动时显式设置 keepAliveTimeout 并打出（反代 keepalive_timeout 必须小于它）', async () => {
  const s = await setup();
  try {
    const logs = s.proxy.logs();
    assert.ok(/keepAliveTimeout[":\s]+65000ms/.test(logs),
      '启动横幅必须打出 keepAliveTimeout，便于和反代配置对齐。实际：\n' +
      logs.split('\n').filter(l => l.includes('CC Proxy started')).join('\n'));
    assert.ok(logs.includes('keepalive_timeout'), '横幅里要提示反代侧的对应设置');
  } finally { await s.close(); }
});

