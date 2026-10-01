// Anthropic 服务端工具 web_search_20250305 由本 proxy 代执行（CC_WEB_SEARCH=1）：
// 模型 tool-call → /alpha/web-search → server_tool_use + web_search_tool_result 块
// → 以 tool_calls / tool 消息追加历史重发上游 → 模型续写。全部走 mock 上游，不需要真 key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
const READ_TOOL = { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };
const AD_URL = 'https://duckduckgo.com/y.js?ad_domain=x.com&ad_provider=bingv7aa&ad_type=txad&u3=https%3A%2F%2Fbing.com';

const nd = (...lines) => lines.map(l => JSON.stringify(l));

// 第 1 轮：模型先想、先说一句，然后调 web_search
const ROUND1 = nd(
  { type: 'start' }, { type: 'start-step' },
  { type: 'reasoning-start' }, { type: 'reasoning-delta', text: 'need fresh info' }, { type: 'reasoning-end' },
  { type: 'text-start' }, { type: 'text-delta', text: 'Let me search.' }, { type: 'text-end' },
  { type: 'tool-call', toolCallId: 'call_1', toolName: 'web_search', input: { query: 'deepseek v4 flash' } },
  { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 7, cachedInputTokens: 0 } },
  { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 100, outputTokens: 7, cachedInputTokens: 0 } },
);
// 第 2 轮：拿到结果后正常作答
const ROUND2 = nd(
  { type: 'start' }, { type: 'start-step' },
  { type: 'text-start' }, { type: 'text-delta', text: 'DeepSeek V4 Flash has a 1M context.' }, { type: 'text-end' },
  { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 150, outputTokens: 11, cachedInputTokens: 0 } },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 150, outputTokens: 11, cachedInputTokens: 0 } },
);
// 普通客户端工具调用（不该被搜索循环拦截）
const ROUND_READ = nd(
  { type: 'start' }, { type: 'start-step' },
  { type: 'tool-call', toolCallId: 'call_r', toolName: 'Read', input: { path: 'a.py' } },
  { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 50, outputTokens: 5, cachedInputTokens: 0 } },
  { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 50, outputTokens: 5, cachedInputTokens: 0 } },
);

// 真实 /alpha/web-search 的形状（DDG 后端，含一条赞助结果）
const SEARCH_RESPONSE = {
  query: 'deepseek v4 flash',
  results: [
    { title: 'Ad - buy now', url: AD_URL, snippet: 'sponsored' },
    { title: 'DeepSeek | Into the Unknown', url: 'https://deepseek.com/en/index.html', snippet: 'We develop DeepSeek-V4.' },
    { title: 'DeepSeek V4 Flash - Command Code', url: 'https://commandcode.ai/models/deepseek-v4-flash', snippet: '1M context.' },
  ],
  formatted: 'ignored by proxy',
};

function sse(res, lines) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const l of lines) res.write(l + '\n');
  res.end();
}
function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// 按 /alpha/generate 的调用序号回放不同脚本；/alpha/web-search 返回固定结果（或自定义 handler）
function scriptedUpstream(rounds, search = SEARCH_RESPONSE, env = {}) {
  let gen = 0;
  return {
    env: { CC_WEB_SEARCH: '1', ...env },
    onRequest(req, res) {
      if (req.url === '/alpha/generate') {
        sse(res, rounds[Math.min(gen++, rounds.length - 1)]);
      } else if (req.url === '/alpha/web-search') {
        if (typeof search === 'function') search(req, res); else json(res, search);
      }
      // 其余（fingerprint / lifecycle）落到 helpers 默认 200
    },
  };
}

const sseEvents = (text) => text.split('\n\n').filter(Boolean).map(chunk => {
  const m = chunk.match(/^event: (\S+)\ndata: (.*)$/s);
  return m ? { event: m[1], data: JSON.parse(m[2]) } : null;
}).filter(Boolean);

async function messagesStream(s, body) {
  const r = await s.proxy.post('/v1/messages',
    { model: 'm', max_tokens: 200, stream: true, ...body },
    { 'x-api-key': 'user_test' });
  const text = await r.text();
  return { status: r.status, text, events: sseEvents(text) };
}

const blockStarts = (events) => events.filter(e => e.event === 'content_block_start').map(e => e.data);
const count = (events, name) => events.filter(e => e.event === name).length;

// ── 主流程 ────────────────────────────────────────────────

test('web_search：模型调用 → 代执行 → server_tool_use + web_search_tool_result → 续写 → 恰好一次 message_stop', async () => {
  const s = await setup(scriptedUpstream([ROUND1, ROUND2]));
  try {
    const { status, text, events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'what is deepseek v4 flash' }],
      tools: [WEB_SEARCH_TOOL, READ_TOOL],
    });
    assert.equal(status, 200);
    assert.equal(count(events, 'message_start'), 1, '只能有一个 message_start（第 2 轮要抑制）');
    assert.equal(count(events, 'message_stop'), 1, '只能有一个 message_stop');

    const starts = blockStarts(events);
    const srv = starts.find(d => d.content_block.type === 'server_tool_use');
    assert.ok(srv, '必须发 server_tool_use 块');
    assert.equal(srv.content_block.name, 'web_search');
    assert.ok(srv.content_block.id.startsWith('srvtoolu_'));
    assert.ok(!starts.some(d => d.content_block.type === 'tool_use'), '服务端工具不能泄漏成客户端 tool_use');

    const inputDelta = events.find(e => e.event === 'content_block_delta'
      && e.data.index === srv.index && e.data.delta.type === 'input_json_delta');
    assert.ok(inputDelta && inputDelta.data.delta.partial_json.includes('deepseek v4 flash'));

    const result = starts.find(d => d.content_block.type === 'web_search_tool_result');
    assert.ok(result, '必须发 web_search_tool_result 块');
    assert.equal(result.content_block.tool_use_id, srv.content_block.id);
    assert.equal(result.content_block.content.length, 2, '赞助结果必须被剥掉');
    assert.ok(result.content_block.content.every(r =>
      r.type === 'web_search_result' && !r.url.includes('duckduckgo.com/y.js') && r.encrypted_content));
    assert.ok(result.index > srv.index, '结果块在调用块之后');

    assert.ok(text.includes('DeepSeek V4 Flash has a 1M context.'), '第 2 轮正文要到客户端');

    const idx = starts.map(d => d.index);
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), '块索引递增');
    assert.equal(new Set(idx).size, idx.length, '块索引不能重复（第 2 轮翻译器必须接着编号）');

    const delta = events.find(e => e.event === 'message_delta').data;
    assert.equal(delta.delta.stop_reason, 'end_turn');
    assert.equal(delta.usage.output_tokens, 7 + 11, '两轮 output 汇总');
    assert.equal(delta.usage.input_tokens, 100 + 150, '两轮 input 汇总');
    assert.deepEqual(delta.usage.server_tool_use, { web_search_requests: 1 });

    // 上游侧：第 2 轮请求要带回 assistant{reasoning + 已发文本 + tool-call} → tool-result
    assert.equal(s.mock.generateCount(), 2);
    const second = s.mock.lastGenerate().body;
    const wire = JSON.stringify(second.params.messages);
    assert.ok(wire.includes('"toolCallId":"call_1"') && wire.includes('"toolName":"web_search"'));
    assert.ok(wire.includes('need fresh info'), 'reasoning 必须随历史回传（CC thinking 模式校验）');
    assert.ok(wire.includes('Let me search.'), '本轮已发文本要进历史');
    assert.ok(wire.includes('tool-result') && wire.includes('DeepSeek | Into the Unknown'));
    assert.ok(!wire.includes('duckduckgo.com/y.js'), '广告不能喂给模型');
    const wsTool = second.params.tools.find(t => t.name === 'web_search');
    assert.ok(wsTool && wsTool.input_schema.properties.query, 'web_search 要有真实 schema');
    assert.ok(second.params.tools.some(t => t.name === 'Read'), '普通工具照常');

    const searchReqs = s.mock.seen.filter(x => x.url === '/alpha/web-search');
    assert.equal(searchReqs.length, 1);
    const sb = JSON.parse(searchReqs[0].raw);
    assert.equal(sb.query, 'deepseek v4 flash');
    assert.ok(sb.numResults >= 5 && sb.numResults <= 10, '多要几条抵消广告，但不超上限');
    assert.equal(searchReqs[0].headers['authorization'], 'Bearer user_test', '用同一把 key');
    assert.equal(searchReqs[0].headers['x-cli-environment'], 'production');
  } finally { await s.close(); }
});

// ── 开关 / 降级 ────────────────────────────────────────────

test('web_search：未开 CC_WEB_SEARCH 时服务端工具被剥掉，不再变成无 schema 的坏工具', async () => {
  const s = await setup({ ndjson: ROUND2 });
  try {
    const { status, events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEB_SEARCH_TOOL, READ_TOOL, { type: 'web_fetch_20250910', name: 'web_fetch' }],
    });
    assert.equal(status, 200);
    const tools = s.mock.lastGenerate().body.params.tools;
    assert.ok(!tools.some(t => t.name === 'web_search' || t.name === 'web_fetch'));
    assert.ok(tools.some(t => t.name === 'Read'));
    assert.equal(count(events, 'message_stop'), 1);
  } finally { await s.close(); }
});

test('web_search：非流式 /v1/messages 不走循环，服务端工具被剥掉', async () => {
  const s = await setup({ ndjson: ROUND2, env: { CC_WEB_SEARCH: '1' } });
  try {
    const r = await s.proxy.post('/v1/messages',
      { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], tools: [WEB_SEARCH_TOOL, READ_TOOL] },
      { 'x-api-key': 'user_test' });
    assert.equal(r.status, 200);
    const tools = s.mock.lastGenerate().body.params.tools;
    assert.ok(!tools.some(t => t.name === 'web_search'));
    assert.ok(tools.some(t => t.name === 'Read'));
  } finally { await s.close(); }
});

test('web_search：开启后普通客户端工具照常 tool_use / stop_reason=tool_use，不误拦、不循环', async () => {
  const s = await setup({ ndjson: ROUND_READ, env: { CC_WEB_SEARCH: '1' } });
  try {
    const { events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'read a.py' }],
      tools: [WEB_SEARCH_TOOL, READ_TOOL],
    });
    const tu = blockStarts(events).find(d => d.content_block.type === 'tool_use');
    assert.ok(tu && tu.content_block.name === 'Read');
    assert.ok(!blockStarts(events).some(d => d.content_block.type === 'server_tool_use'));
    assert.equal(events.find(e => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
    assert.equal(s.mock.generateCount(), 1, '没有搜索就不该多打上游');
    assert.equal(count(events, 'message_stop'), 1);
  } finally { await s.close(); }
});

// ── 额度 / 失败 ────────────────────────────────────────────

test('web_search：超过 max_uses → max_uses_exceeded 错误块、不再打 /alpha/web-search、末轮禁工具、流正常收尾', async () => {
  const ROUND1b = ROUND1.map(l => l.replace('"call_1"', '"call_2"'));
  const s = await setup(scriptedUpstream([ROUND1, ROUND1b, ROUND2]));
  try {
    const { events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ ...WEB_SEARCH_TOOL, max_uses: 1 }],
    });
    const results = blockStarts(events)
      .filter(d => d.content_block.type === 'web_search_tool_result').map(d => d.content_block);
    assert.equal(results.length, 2);
    assert.ok(Array.isArray(results[0].content), '第一次是真结果');
    assert.deepEqual(results[1].content, { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' });
    assert.equal(s.mock.seen.filter(x => x.url === '/alpha/web-search').length, 1, '超额不再打搜索端点');
    assert.equal(count(events, 'message_stop'), 1);
    const delta = events.find(e => e.event === 'message_delta').data;
    assert.deepEqual(delta.usage.server_tool_use, { web_search_requests: 1 });

    const gens = s.mock.seen.filter(x => x.url === '/alpha/generate');
    assert.equal(gens.length, 3);
    // CC 的 tool_choice 没有 none（真机 400：expected "auto"|"any"|"tool"），额度用完靠把工具移出定义
    const secondReq = JSON.parse(gens[1].raw).params;
    assert.ok(!(secondReq.tools || []).some(t => t.name === 'web_search'), '额度用完后 web_search 要从工具定义里移除');
    assert.equal(secondReq.tool_choice, undefined, '工具全被移除时不能再带 tool_choice');
    assert.ok(JSON.parse(gens[2].raw).params.messages.some(m => JSON.stringify(m).includes('Search failed: max_uses_exceeded')));
  } finally { await s.close(); }
});

test('web_search：工具已移出定义模型仍持续调用 → 本地补错误块并收尾，不无限循环', async () => {
  // 每轮都发 tool-call，永不收尾
  const s = await setup(scriptedUpstream([ROUND1]));
  try {
    const { events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ ...WEB_SEARCH_TOOL, max_uses: 1 }],
    });
    assert.equal(count(events, 'message_stop'), 1, '必须有且只有一次终结');
    assert.equal(count(events, 'message_delta'), 1);
    assert.ok(s.mock.generateCount() <= 3, `上游调用应被封顶，实际 ${s.mock.generateCount()}`);
    const results = blockStarts(events).filter(d => d.content_block.type === 'web_search_tool_result');
    // 每个 server_tool_use 都要有配对的结果块（否则客户端会卡在悬空的调用块上）
    const calls = blockStarts(events).filter(d => d.content_block.type === 'server_tool_use');
    assert.equal(results.length, calls.length);
  } finally { await s.close(); }
});

test('web_search：/alpha/web-search 返回 5xx → unavailable 错误块，模型仍能拿到错误并收尾', async () => {
  const s = await setup(scriptedUpstream([ROUND1, ROUND2], (req, res) => json(res, { error: 'boom' }, 500)));
  try {
    const { events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'x' }],
      tools: [WEB_SEARCH_TOOL],
    });
    const result = blockStarts(events).find(d => d.content_block.type === 'web_search_tool_result');
    assert.deepEqual(result.content_block.content, { type: 'web_search_tool_result_error', error_code: 'unavailable' });
    assert.equal(count(events, 'message_stop'), 1);
    const second = s.mock.lastGenerate().body;
    assert.ok(JSON.stringify(second.params.messages).includes('Search failed: unavailable'));
    // 失败不计入 web_search_requests? —— 计入：请求已发出、配额已消耗
    assert.deepEqual(events.find(e => e.event === 'message_delta').data.usage.server_tool_use, { web_search_requests: 1 });
  } finally { await s.close(); }
});

// ── 历史回放 ──────────────────────────────────────────────

test('web_search：回放含 server_tool_use / web_search_tool_result 的历史 → tool-call → tool-result → 后续 assistant 文本', async () => {
  const s = await setup({ ndjson: ROUND2, env: { CC_WEB_SEARCH: '1' } });
  try {
    const enc = Buffer.from(JSON.stringify({ s: 'We develop DeepSeek-V4.' })).toString('base64');
    const { status } = await messagesStream(s, {
      tools: [WEB_SEARCH_TOOL],
      messages: [
        { role: 'user', content: 'what is deepseek v4' },
        { role: 'assistant', content: [
          { type: 'text', text: 'Let me search.' },
          { type: 'server_tool_use', id: 'srvtoolu_abc', name: 'web_search', input: { query: 'deepseek v4' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_abc', content: [
            { type: 'web_search_result', url: 'https://deepseek.com/', title: 'DeepSeek', encrypted_content: enc, page_age: null },
          ] },
          { type: 'text', text: 'DeepSeek V4 is a model family.' },
        ] },
        { role: 'user', content: 'and the flash variant?' },
      ],
    });
    assert.equal(status, 200);
    const msgs = s.mock.lastGenerate().body.params.messages;
    const has = (m, str) => JSON.stringify(m).includes(str);
    const iCall = msgs.findIndex(m => m.role === 'assistant' && has(m, '"toolCallId":"srvtoolu_abc"'));
    const iResult = msgs.findIndex(m => m.role === 'tool' && has(m, '"toolCallId":"srvtoolu_abc"'));
    const iText = msgs.findIndex(m => m.role === 'assistant' && has(m, 'DeepSeek V4 is a model family.'));
    assert.ok(iCall >= 0 && iResult >= 0 && iText >= 0, `缺消息：call=${iCall} result=${iResult} text=${iText}`);
    assert.ok(iCall < iResult && iResult < iText, '顺序必须是 assistant{tool-call} → tool → assistant{text}');
    assert.ok(has(msgs[iResult], 'We develop DeepSeek-V4.'), 'encrypted_content 要被解回摘要');
    assert.ok(has(msgs[iCall], 'Let me search.'), '调用前的文本要留在调用那条 assistant 里');
    assert.equal(msgs[msgs.length - 1].role, 'user');
    assert.ok(!msgs.some(m => m.role === 'assistant' && m.content === null && !has(m, 'tool-call')),
      '不能在 tool 消息后多推一条空 assistant');
  } finally { await s.close(); }
});

test('web_search：回放 web_search_tool_result_error → tool-result 写入错误文本', async () => {
  const s = await setup({ ndjson: ROUND2, env: { CC_WEB_SEARCH: '1' } });
  try {
    await messagesStream(s, {
      tools: [WEB_SEARCH_TOOL],
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [
          { type: 'server_tool_use', id: 'srvtoolu_err', name: 'web_search', input: { query: 'q' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_err', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
          { type: 'text', text: 'I could not search.' },
        ] },
        { role: 'user', content: 'ok' },
      ],
    });
    const msgs = s.mock.lastGenerate().body.params.messages;
    const tool = msgs.find(m => m.role === 'tool' && JSON.stringify(m).includes('srvtoolu_err'));
    assert.ok(tool && JSON.stringify(tool).includes('Search failed: max_uses_exceeded'));
  } finally { await s.close(); }
});

// ── 并行调用（真机观察：DS 一轮会同时发多个 web_search）────────

test('web_search：一轮并行两次调用 → 两次都执行、两个结果块配对、web_search_requests=2、工具仍保留', async () => {
  const ROUND_PAR = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'tool-call', toolCallId: 'call_a', toolName: 'web_search', input: { query: 'q1' } },
    { type: 'tool-call', toolCallId: 'call_b', toolName: 'web_search', input: { query: 'q2' } },
    { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 9, cachedInputTokens: 0 } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 100, outputTokens: 9, cachedInputTokens: 0 } },
  );
  const s = await setup(scriptedUpstream([ROUND_PAR, ROUND2]));
  try {
    const { events } = await messagesStream(s, { messages: [{ role: 'user', content: 'x' }], tools: [WEB_SEARCH_TOOL] });
    const calls = blockStarts(events).filter(d => d.content_block.type === 'server_tool_use');
    const results = blockStarts(events).filter(d => d.content_block.type === 'web_search_tool_result');
    assert.equal(calls.length, 2);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(r => r.content_block.tool_use_id).sort(), calls.map(c => c.content_block.id).sort(), '结果块与调用块一一配对');
    assert.equal(s.mock.seen.filter(x => x.url === '/alpha/web-search').length, 2);
    assert.deepEqual(events.find(e => e.event === 'message_delta').data.usage.server_tool_use, { web_search_requests: 2 });
    assert.equal(count(events, 'message_stop'), 1);
    const second = s.mock.lastGenerate().body;
    const wire = JSON.stringify(second.params.messages);
    assert.ok(wire.includes('"toolCallId":"call_a"') && wire.includes('"toolCallId":"call_b"'), '两次调用都进历史');
    assert.ok(second.params.tools.some(t => t.name === 'web_search'), 'max_uses 3 用了 2，工具还在');
  } finally { await s.close(); }
});

test('web_search：并行调用一次吃光额度（max_uses=2）→ 下一轮工具被移除，客户端工具保留', async () => {
  const ROUND_PAR = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'tool-call', toolCallId: 'call_a', toolName: 'web_search', input: { query: 'q1' } },
    { type: 'tool-call', toolCallId: 'call_b', toolName: 'web_search', input: { query: 'q2' } },
    { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 9, cachedInputTokens: 0 } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 100, outputTokens: 9, cachedInputTokens: 0 } },
  );
  const s = await setup(scriptedUpstream([ROUND_PAR, ROUND2]));
  try {
    const { events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ ...WEB_SEARCH_TOOL, max_uses: 2 }, READ_TOOL],
    });
    assert.equal(count(events, 'message_stop'), 1);
    const second = s.mock.lastGenerate().body.params;
    assert.ok(!second.tools.some(t => t.name === 'web_search'), '额度吃光 → web_search 移出定义');
    assert.ok(second.tools.some(t => t.name === 'Read'), '客户端工具不受影响');
    assert.equal(s.mock.seen.filter(x => x.url === '/alpha/web-search').length, 2);
  } finally { await s.close(); }
});
