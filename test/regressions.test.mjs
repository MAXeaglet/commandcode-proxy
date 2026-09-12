// 回归护栏：为已修复的 issue 各留一条断言，防止再次退化。
// 每条都注明来源 issue —— 删掉某条前请先读对应的 issue。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

async function wire(s, path, body, headers = AUTH) {
  const r = await s.proxy.post(path, body, headers);
  await r.text();
  const g = s.mock.lastGenerate();
  return { status: r.status, params: g ? g.body.params : null };
}

// issue #17：无 system prompt 时发空格占位，阻止 CC 上游注入 ~7.5K token 默认提示词
test('#17 chat：无 system prompt 时 params.system 为占位串而非空/缺省', async () => {
  const s = await setup();
  try {
    const { params } = await wire(s, '/v1/chat/completions',
      { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(typeof params.system, 'string', 'params.system 必须是字符串');
    assert.notEqual(params.system, '', '空 system 会触发上游注入默认提示词（#17）');
  } finally { await s.close(); }
});

// issue #7：超限必须走 413 + 排空，而不是直接 reset（客户端会看到 Connection error）
test('#7 超限请求返回 413 且连接可继续使用（不 reset）', async () => {
  const s = await setup({ env: { CC_MAX_BODY_MB: '1' } });
  try {
    const big = JSON.stringify({ model: 'm', stream: true,
      messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] });
    const r = await s.proxy.post('/v1/chat/completions', big, AUTH);
    assert.equal(r.status, 413, '必须是 HTTP 413 响应，而不是连接被 reset');
    const j = await r.json();
    assert.ok(j.error, '应为结构化错误体，便于客户端识别');
  } finally { await s.close(); }
});

// issue #25：Anthropic input_tokens 只计非缓存部分（与 cache_read 相加 = 总输入）
test('#25 messages：Anthropic usage 的 input_tokens 不含缓存部分', async () => {
  const s = await setup({ ndjson: [
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"hi"}',
    '{"type":"text-end"}',
    // inputTokens 是总数（含缓存），cacheRead 是其子集
    '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":1000,"outputTokens":10,"cachedInputTokens":800,"inputTokenDetails":{"noCacheTokens":200,"cacheReadTokens":800,"cacheWriteTokens":0}}}',
  ] });
  try {
    const r = await s.proxy.post('/v1/messages',
      { model: 'm', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': 'user_test' });
    const text = await r.text();
    // SSE 事件格式：event: <name>\ndata: <json>\n\n —— 按行取，不能用非贪婪 \{.*?\}（会在首个 } 截断）
    const deltas = text.split('\n\n')
      .map(block => {
        const ev = /^event: (\S+)/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev !== 'message_delta' || !data) return null;
        try { return JSON.parse(data); } catch { return null; }
      })
      .filter(Boolean);
    const usage = deltas.find(d => d.usage)?.usage;
    assert.ok(usage, 'message_delta 应携带 usage');
    assert.equal(usage.input_tokens, 200,
      'input_tokens 只能是非缓存部分（200），不能是总数（1000）—— 否则下游相加会约两倍');
    assert.equal(usage.cache_read_input_tokens, 800);
  } finally { await s.close(); }
});
