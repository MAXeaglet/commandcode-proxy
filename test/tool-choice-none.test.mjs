// #47：tool_choice: none 不能原样下发 —— CC 上游的 tool_choice 枚举只有 auto / any / tool，
// 传 { type: 'none' } 会被 400 拒绝。语义上等价于「本轮禁用工具」：下发空 tools 且不带 tool_choice。
// 对应上游 MAXeaglet/commandcode-proxy@40b338e。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

test('#47 tool_choice: none（OpenAI 格式）清空 tools 且不下发 tool_choice', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'none',
    }, { Authorization: 'Bearer user_test' });
    assert.equal(r.status, 200);
    await r.text();
    const params = s.mock.lastGenerate().body.params;
    assert.deepEqual(params.tools, [], 'none 语义为本轮禁用工具，下发空 tools 列表');
    assert.equal(params.tool_choice, undefined, 'CC 只有 auto/any/tool 枚举，不能下发 type=none');
  } finally { await s.close(); }
});

test('#47 tool_choice: { type: "none" }（Anthropic 格式）同样清空 tools 且不下发 tool_choice', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/messages', {
      model: 'm', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'none' },
    }, { 'x-api-key': 'user_test' });
    assert.equal(r.status, 200);
    await r.text();
    const params = s.mock.lastGenerate().body.params;
    assert.deepEqual(params.tools, []);
    assert.equal(params.tool_choice, undefined);
  } finally { await s.close(); }
});
