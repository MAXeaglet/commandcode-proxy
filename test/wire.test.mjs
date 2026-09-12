// wire 协议契约：断言发往 CC 上游 /alpha/generate 的请求体形状。
// 这类断言是挡住「静默丢消息 / 静默改语义」回归的关键 —— 只看 HTTP 状态码看不出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

/** 取本次请求发往上游的 params.messages */
async function wireMessages(proxy, mock, path, body, headers = AUTH) {
  const r = await proxy.post(path, body, headers);
  await r.text();
  const g = mock.lastGenerate();
  assert.ok(g, '应至少产生一条 /alpha/generate（实际: ' + mock.seen.map(s => s.url).join(',') + '）');
  return { status: r.status, params: g.body.params, config: g.body.config, headers: g.headers };
}

test('chat：system 提升到 params.system，且必须是字符串', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'deepseek/deepseek-v4-flash', stream: true,
      messages: [{ role: 'system', content: 'you are terse' }, { role: 'user', content: 'hi' }],
    });
    assert.equal(typeof params.system, 'string', 'CC 上游要求 params.system 恒为字符串，传数组会被拒绝');
    assert.equal(params.system, 'you are terse');
    assert.equal(params.messages.length, 1, 'system 不应留在 messages 里');
    assert.equal(params.messages[0].role, 'user');
  } finally { await s.close(); }
});

test('chat：user 内容包成 [{type:text}] 结构', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'hello' }],
    });
    assert.deepEqual(params.messages[0], { role: 'user', content: [{ type: 'text', text: 'hello' }] });
  } finally { await s.close(); }
});

test('chat：assistant 历史按 [reasoning, text, tool-call] 次序回传', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true, messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', reasoning_content: 'thinking', content: 'answer',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    });
    const asst = params.messages.find(m => m.role === 'assistant');
    assert.deepEqual(asst.content.map(p => p.type), ['reasoning', 'text', 'tool-call'],
      'CC 校验历史中的 reasoning，且次序必须与 CLI 一致');
    assert.equal(asst.content[0].text, 'thinking');
  } finally { await s.close(); }
});

test('chat：多模态 image_url 转成 CC image 结构', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ] }],
    });
    const parts = params.messages[0].content;
    assert.equal(parts.find(p => p.type === 'image').image, 'data:image/png;base64,AAA');
  } finally { await s.close(); }
});

test('messages：Anthropic thinking block 回传为 reasoning_content', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/messages', {
      model: 'm', max_tokens: 100, stream: true, messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'pondering' },
          { type: 'text', text: 'answer' },
        ] },
        { role: 'user', content: 'again' },
      ],
    }, { 'x-api-key': 'user_test' });
    const asst = params.messages.find(m => m.role === 'assistant');
    assert.deepEqual(asst.content.map(p => p.type), ['reasoning', 'text'],
      'Anthropic 的 thinking 必须转成 reasoning 回传，否则 CC 拒绝多轮');
    assert.equal(asst.content[0].text, 'pondering');
  } finally { await s.close(); }
});

test('responses：带 type 的 input item 正常转换', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/responses', {
      model: 'm', stream: true,
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    });
    assert.deepEqual(params.messages[0], { role: 'user', content: [{ type: 'text', text: 'hello' }] });
  } finally { await s.close(); }
});

test('responses：input 为字符串时等价于单条 user 消息', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/responses', {
      model: 'm', stream: true, input: 'hello',
    });
    assert.deepEqual(params.messages[0], { role: 'user', content: [{ type: 'text', text: 'hello' }] });
  } finally { await s.close(); }
});

test('responses：function_call_output 映射成 tool 消息', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/responses', {
      model: 'm', stream: true, input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'out' },
      ],
    });
    assert.ok(params.messages.some(m => m.role === 'tool'), 'function_call_output 应产出 tool 消息');
  } finally { await s.close(); }
});
