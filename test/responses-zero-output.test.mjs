// issue #56：#54（2eccdbf）把流式 /v1/responses 改成「上游一 200 就先发 response.created」，
// translator.started（= createdSent）自此恒为 true，零输出防护
//   translator.outputTokens === 0 && !translator.started
// 成了死代码 —— 空响应会经 finish() 包装成 response.completed 谎报成功
//（旧版 cce214d 是 HTTP 429 + rate_limit_error）。
// 修复口径：判据换成「是否真的产出过 output item」（hasOutput）；
// 响应头已按 200 提交后状态码改不回 429（再调 sendResponsesError 会抛
// ERR_HTTP_HEADERS_SENT），按本文件既有失败口径走 response.failed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

// 与 issue 里复现用的同一组上游输出：start + finish(outputTokens=0)，中间零内容
const EMPTY_STREAM = [
  '{"type":"start"}',
  '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":0,"cachedInputTokens":0}}',
];

test('#56 流式：空响应必须报 response.failed，不能再谎报 response.completed', async () => {
  const s = await setup({ ndjson: EMPTY_STREAM });
  try {
    const r = await s.proxy.post('/v1/responses', { model: 'm', stream: true, input: 'hi' }, AUTH);
    assert.equal(r.status, 200, 'created 已先行发出，HTTP 状态只能停在 200');
    const text = await r.text();   // 能正常读完 = 流有收尾；漏 res.end() 这里会挂起
    assert.ok(text.includes('event: response.failed'), '必须显式发 response.failed');
    assert.ok(text.includes('"status":"failed"'), 'response.status 必须是 failed');
    assert.ok(text.includes('"code":"upstream_error"'), '错误码按本文件既有失败口径取 upstream_error');
    assert.ok(text.includes('Empty response from upstream (zero output tokens)'), '错误消息要说明是空响应');
    assert.ok(!text.includes('response.completed'),
      '零输出绝不能发 response.completed —— 那是把空响应谎报成功（#38/#39 同类问题）');
    assert.ok(!text.includes('Cannot write headers after they are sent'),
      '响应头已提交后不能再走 sendResponsesError（issue 里实测的 ERR_HTTP_HEADERS_SENT 惨案）');
  } finally { await s.close(); }
});

test('#56 流式：有真实输出时行为不变（response.completed 正常发出）', async () => {
  const s = await setup();   // 默认 ndjson：hello + outputTokens 3
  try {
    const r = await s.proxy.post('/v1/responses', { model: 'm', stream: true, input: 'hi' }, AUTH);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('event: response.completed'), '正常输出必须照常 completed');
    assert.ok(text.includes('"status":"completed"'));
    assert.ok(!text.includes('response.failed'), '不能误伤正常响应');
  } finally { await s.close(); }
});

test('#56 非流式：空响应仍是 HTTP 429（该路径守卫未被 #54 波及）', async () => {
  const s = await setup({ ndjson: EMPTY_STREAM });
  try {
    const r = await s.proxy.post('/v1/responses', { model: 'm', input: 'hi' }, AUTH);
    assert.equal(r.status, 429, '非流式没有提前发响应头，旧语义（429）应原样保留');
    const json = await r.json();
    assert.equal(json.error.type, 'rate_limit_error');
    assert.equal(json.error.message, 'Empty response from upstream (zero output tokens)');
  } finally { await s.close(); }
});
