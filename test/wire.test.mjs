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

// params.system 的形态是 **块数组**，不是字符串 —— 对齐 CLI 的 toWireSystem：
//   toWireSystem(e) { const t = e.length - 1;
//     return e.map((e, n) => ({ type: 'text', text: n < t ? e.text + '\n' : e.text,
//                               ...(e.cache ? { cache_control: { type: 'ephemeral' } } : {}) })); }
// 早先「数组会被上游拒绝」的判断源自一次误诊（真因是 content 为字符串时整条 user 消息
// 丢失，见 convertAnthropicToOpenAI 的注释），已更正。
test('chat：system 提升到 params.system，形态为 CLI 的块数组', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'deepseek/deepseek-v4-flash', stream: true,
      messages: [{ role: 'system', content: 'you are terse' }, { role: 'user', content: 'hi' }],
    });
    assert.deepEqual(params.system, [{ type: 'text', text: 'you are terse' }],
      '单个 system 段应序列化为一个文本块（末块不加 \\n）');
    assert.equal(params.messages.length, 1, 'system 不应留在 messages 里');
    assert.equal(params.messages[0].role, 'user');
  } finally { await s.close(); }
});

test('chat：多个 system 段时非末块补 \\n（对齐 toWireSystem）', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [
        { role: 'system', content: 'first' },
        { role: 'system', content: 'second' },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.deepEqual(params.system, [
      { type: 'text', text: 'first\n' },
      { type: 'text', text: 'second' },
    ]);
  } finally { await s.close(); }
});

test('chat：system 块上的 cache_control 原样下发（CLI 的 systemSections[].cache）', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'cached prefix', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.deepEqual(params.system, [
      { type: 'text', text: 'cached prefix', cache_control: { type: 'ephemeral' } },
    ]);
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

// ── 工具名完全不重命名（issue #36 / #37） ──────────────
// wire 协议里没有工具重命名这回事。CLI 的 toWireToolName 只服务于「重放自家退役
// 工具名的旧会话」（tool_search 在 CLI 里 visible:()=>false，从不进声明）；反代没有
// catalog、没有退役名，因此声明与消息都必须原样透传 —— 只要有一处改名，下游就会按
// 自己声明的名字派发不到工具。
test('tools 声明不做名字重写（CLI 的 toWireTools 是原样 map）', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'q' }],
      tools: ['bash_output', 'read_multiple_files', 'tool_search'].map(n => ({
        type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } },
      })),
    });
    assert.deepEqual(params.tools.map(t => t.name), ['bash_output', 'read_multiple_files', 'tool_search'],
      '客户端声明的名字必须原样下发，否则客户端按自己的声明找不到工具');
  } finally { await s.close(); }
});

test('tool_search 在 tool-call 里也**不**被重写（不套用 CLI 自家的退役名归一化）', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true, messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool_search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'r' },
      ],
      tools: [{ type: 'function', function: { name: 'tool_search', parameters: { type: 'object', properties: {} } } }],
    });
    const call = params.messages.find(m => m.role === 'assistant').content.find(p => p.type === 'tool-call');
    assert.equal(call.toolName, 'tool_search',
      '客户端声明的就是 tool_search，消息里必须还是它；改成 search_tools 下游就派发不到');
    assert.equal(params.tools[0].name, 'tool_search', '声明与消息必须同名');
  } finally { await s.close(); }
});

test('tool-result 的 toolName 与 tool-call 一致（CLI 用同一张 map）', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true, messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool_search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'tool_search', content: 'r' },
      ],
    });
    const call = params.messages.find(m => m.role === 'assistant').content.find(p => p.type === 'tool-call');
    const res = params.messages.find(m => m.role === 'tool').content[0];
    assert.equal(res.toolName, call.toolName,
      '调用名与结果名对不上会被上游判为无效的工具结果');
    assert.equal(res.toolName, 'tool_search');
  } finally { await s.close(); }
});

test('普通工具名在 tools 声明与 messages 里都不动', async () => {
  const s = await setup();
  try {
    const { params } = await wireMessages(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true, messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'r' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
    });
    assert.equal(params.tools[0].name, 'get_weather');
    assert.equal(params.messages.find(m => m.role === 'assistant').content.find(p => p.type === 'tool-call').toolName, 'get_weather');
    assert.equal(params.messages.find(m => m.role === 'tool').content[0].toolName, 'get_weather');
  } finally { await s.close(); }
});

