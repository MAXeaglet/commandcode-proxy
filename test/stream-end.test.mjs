// issue #38：上游「没有正常走完」的四种情形都必须如实上报，不能谎报成功。
// 对齐 CLI（command-code@1.54.0 dist/cli.mjs）：
//   normalizeStopReason2 把 max_output_tokens / model_context_window_exceeded 归到 max_tokens
//   isNetworkFailureFinish 把 network/connection/upstream-error 当成可重试的 502
//   没有 finish 事件 → "Stream ended unexpectedly before completion (no finish event)"
//   pause_turn → CLI 靠自动续写吸收掉，代理不续写就必须原样透出
//   finishReason=error（provider 空响应）→ 非 OpenAI 值，不能透出；按可重试 502 上报
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

// ── ⑦ provider 空响应：finishReason='error' 不能落进 OpenAI finish_reason ──
// Command Code 在 provider 返回空响应时会发 finish + finishReason:"error"。
// 该值不在 OpenAI 枚举里，原样透出会让严格客户端整条流反序列化失败
// （GrokZen: unknown variant `error`），并且把可重试的 502 变成非重试错误。

test('chat 流式：finishReason=error + error 事件 → 无非法 finish_reason，上游错误可重试透出', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"partial"}',
    '{"type":"finish-step","finishReason":"error","usage":{"inputTokens":9,"outputTokens":0}}',
    '{"type":"finish","finishReason":"error","totalUsage":{"inputTokens":9,"outputTokens":0}}',
    '{"type":"error","error":{"message":"Provider returned an empty response"}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!text.includes('"finish_reason":"error"'), '非法 finish_reason 不能进入 SSE');
    assert.ok(!text.includes('"finish_reason":"upstream_error"'), '内部规范化值也不能落进 OpenAI finish_reason');
    assert.ok(!text.includes('[DONE]'), '错误流不能以 [DONE] 谎报正常结束');
    assert.ok(text.includes('Provider returned an empty response'), '上游错误消息要透出，便于定位');
  } finally { await s.close(); }
});

test('chat 流式：只有 finish(error) 没有 error 事件 → 仍按可重试 502 上报', async () => {
  const s = await setup({ ndjson: withFinish('error') });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const text = await r.text();
    assert.ok(!text.includes('"finish_reason":"error"'), '非法 finish_reason 不能进入 SSE');
    assert.ok(text.includes('upstream_error'), '要给出可重试的上游错误');
    assert.ok(!text.includes('[DONE]'), '错误流不能以 [DONE] 谎报正常结束');
  } finally { await s.close(); }
});

test('chat 非流式：finishReason=error → 502 可重试（不再是非重试的反序列化错误）', async () => {
  const s = await setup({ ndjson: withFinish('error') });
  try {
    const { status, json } = await openaiNonStream(s);
    assert.equal(status, 502);
    assert.equal(json.error.type, 'upstream_error');
    assert.equal(json.retry_after, 10);
  } finally { await s.close(); }
});

test('messages 非流式：finishReason=error → 502，不谎报 end_turn', async () => {
  const s = await setup({ ndjson: withFinish('error') });
  try {
    const { status, json } = await anthropicNonStream(s);
    assert.equal(status, 502);
    assert.equal(json.error.type, 'upstream_error');
  } finally { await s.close(); }
});

// ── ⑧ 不认识的结束原因：一轮结束了，只是原因不在标准词汇表里 ──────────
// AI SDK 把不认识的 finish_reason 归成 other，而「一个完成信号都没收到」归成
// error —— 两者不是一回事。实测 other 只出现 1 次（会话 01a0d884，09-25），
// 当时 chat 路径把它折成可重试 502 并声称 response was truncated：描述不实
// （上游确实发过 finish），而且白丢一轮已经结束的回答。provider 若对同一输入
// 稳定返回 other（Google 的 FinishReason.OTHER 就会这样），会重试到上限后整轮失败。
// /v1/messages（mapAnthropicStopReason 默认 end_turn）与 /v1/responses
// （status=completed）本来就当正常结束，三条面必须一致。
//
// 例外：什么都不折的前提是「上游连接失败族」仍走可重试 502（下面配了负控），
// 而且透出的值必须是合法枚举 —— 原样写 other 会让 GrokZen 的严格
// FinishReason 反序列化失败，那是 error 那个坑的翻版。

test('chat 流式：finishReason=other → finish_reason=stop，不报截断、不丢 [DONE]', async () => {
  const s = await setup({ ndjson: withFinish('other') });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('"finish_reason":"stop"'), 'other 对外必须表现为正常结束');
    assert.ok(!text.includes('"finish_reason":"other"'), '非法枚举不能进 SSE');
    assert.ok(!text.includes('response was truncated'), '上游发过 finish，不能说被截断');
    assert.ok(!text.includes('upstream_error'), '不能给可重试错误');
    assert.ok(text.includes('[DONE]'), '正常结束要发 [DONE]');
    // 折掉不等于抹掉：原始值必须留在日志里，否则这条信息就彻底消失了。
    for (let i = 0; i < 20 && !s.proxy.logs().includes('Unrecognized upstream finish reason'); i++) {
      await new Promise(r2 => setTimeout(r2, 25));
    }
    assert.ok(s.proxy.logs().includes('Unrecognized upstream finish reason'),
      '折成 stop 后原始 reason 仍要留痕');
  } finally { await s.close(); }
});

test('chat 非流式：finishReason=other → 200 + finish_reason=stop（不透出非法值）', async () => {
  const s = await setup({ ndjson: withFinish('other') });
  try {
    const { status, json } = await openaiNonStream(s);
    assert.equal(status, 200);
    assert.equal(json.choices[0].finish_reason, 'stop');
  } finally { await s.close(); }
});

test('messages 流式：finishReason=other → 正常 message_stop，不发 event: error', async () => {
  const s = await setup({ ndjson: withFinish('other') });
  try {
    const r = await s.proxy.post('/v1/messages',
      { model: 'm', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': 'user_test' });
    const text = await r.text();
    assert.ok(text.includes('event: message_stop'), '结束原因不认识也是正常收尾');
    assert.ok(!text.includes('event: error'), '不能报错');
  } finally { await s.close(); }
});

test('responses 非流式：finishReason=other → status=completed', async () => {
  const s = await setup({ ndjson: withFinish('other') });
  try {
    const { json } = await responsesNonStream(s);
    assert.equal(json.status, 'completed');
    assert.equal(json.incomplete_details, null);
  } finally { await s.close(); }
});

test('负控：network-error 流式仍 502 可重试（折 stop 不能把故障族一起折掉）', async () => {
  const s = await setup({ ndjson: withFinish('network-error') });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { ...CHAT, stream: true }, AUTH);
    const text = await r.text();
    assert.ok(text.includes('upstream_error'), '连接失败族仍要透出可重试错误');
    assert.ok(!text.includes('[DONE]'), '错误流不能以 [DONE] 谎报正常结束');
  } finally { await s.close(); }
});
