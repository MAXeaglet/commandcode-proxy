// deepseek-harness（dsh）的 web_search 请求形状回归。
// 来源：deepseek-ai/deepseek-harness @ ce7073d5，packages/web/web-search-deepseek/src/provider.ts：
//   - POST `${baseURL}/messages`，硬编码非流式（fetch 后直接 response.json()，body 不带 stream）
//   - headers：x-api-key 与 Authorization: Bearer 同时发、anthropic-version、accept: application/json、
//     user-agent: deepseek-harness/0.0.1
//   - body：单条 user 文本 "Perform a web search for the query: …"，
//     tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses }]，thinking: { type: 'disabled' }
//   - 解析：只认 content[] 里的 web_search_tool_result 块，没有就抛
//     "DeepSeek returned no web_search_tool_result blocks"；snippet 取自 text 块的 citations[]。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const nd = (...lines) => lines.map(l => JSON.stringify(l));

// 第 1 轮：模型调 web_search（thinking 关闭，所以没有 reasoning 事件）
const ROUND_SEARCH = nd(
  { type: 'start' }, { type: 'start-step' },
  { type: 'tool-call', toolCallId: 'call_dsh', toolName: 'web_search', input: { query: 'deepseek harness release' } },
  { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 80, outputTokens: 6, cachedInputTokens: 0 } },
  { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 80, outputTokens: 6, cachedInputTokens: 0 } },
);
// 第 2 轮：拿到结果后总结
const ROUND_ANSWER = nd(
  { type: 'start' }, { type: 'start-step' },
  { type: 'text-start' }, { type: 'text-delta', text: 'Here is what I found.' }, { type: 'text-end' },
  { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 300, outputTokens: 9, cachedInputTokens: 0 } },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 300, outputTokens: 9, cachedInputTokens: 0 } },
);
// 模型不搜直接作答
const ROUND_NO_SEARCH = nd(
  { type: 'start' }, { type: 'start-step' },
  { type: 'text-start' }, { type: 'text-delta', text: 'I already know this.' }, { type: 'text-end' },
  { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 80, outputTokens: 5, cachedInputTokens: 0 } },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 80, outputTokens: 5, cachedInputTokens: 0 } },
);

const SEARCH_RESPONSE = {
  query: 'deepseek harness release',
  results: [
    { title: 'deepseek-ai/deepseek-harness', url: 'https://github.com/deepseek-ai/deepseek-harness', snippet: 'Agent harness.' },
    { title: 'DeepSeek Harness docs', url: 'https://api-docs.deepseek.com/guides/harness', snippet: 'Getting started.' },
  ],
};

function scriptedUpstream(rounds) {
  let gen = 0;
  return {
    env: { CC_WEB_SEARCH: '1' },
    onRequest(req, res) {
      if (req.url === '/alpha/generate') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const l of rounds[Math.min(gen++, rounds.length - 1)]) res.write(l + '\n');
        res.end();
      } else if (req.url === '/alpha/web-search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(SEARCH_RESPONSE));
      }
    },
  };
}

// ── 以下两个函数逐行移植自 dsh 的 provider.ts，用来验证"dsh 拿到我们的响应后会怎么解析" ──

class WebError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function citationSnippets(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text);
      }
    }
  }
  return map;
}

function mapAnthropicResponse(response) {
  const blocks = response.content ?? [];
  const resultBlocks = blocks.filter(block => block.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) {
    throw new WebError(
      'DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search',
      'WEB_PROVIDER_ERROR',
    );
  }
  const snippets = citationSnippets(blocks);
  const seen = new Set();
  const sources = [];
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue;
      seen.add(item.url);
      const snippet = snippets.get(item.url);
      sources.push({
        url: item.url,
        ...item.title != null && item.title.length > 0 ? { title: item.title } : {},
        ...snippet != null && snippet.length > 0 ? { snippet } : {},
        ...item.page_age != null && item.page_age.length > 0 ? { publishedAt: item.page_age } : {},
      });
    }
  }
  return { sources, truncated: false };
}

// dsh 的 search()：baseURL 以 /v1 结尾，再拼 /messages；两种鉴权头同时发
async function dshSearch(s, query, { maxUses = 5, model = 'deepseek-v4-flash' } = {}) {
  const body = {
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    thinking: { type: 'disabled' },
  };
  const r = await s.proxy.post('/v1/messages', body, {
    'x-api-key': 'user_test',
    'authorization': 'Bearer user_test',
    'anthropic-version': '2023-06-01',
    'accept': 'application/json',
    'user-agent': 'deepseek-harness/0.0.1',
  });
  return { status: r.status, body: await r.json() };
}

test('dsh 形状：非流式搜索请求 → 200，content 里有 web_search_tool_result，dsh 的解析得到两条来源', async () => {
  const s = await setup(scriptedUpstream([ROUND_SEARCH, ROUND_ANSWER]));
  try {
    const { status, body } = await dshSearch(s, 'deepseek harness release');
    assert.equal(status, 200);
    assert.equal(body.type, 'message');
    assert.equal(body.stop_reason, 'end_turn');
    assert.deepEqual(body.content.map(b => b.type), ['server_tool_use', 'web_search_tool_result', 'text']);

    // dsh 侧解析（移植自 provider.ts）：不抛错，来源按 url 去重
    const mapped = mapAnthropicResponse(body);
    assert.deepEqual(mapped.sources.map(x => x.url), [
      'https://github.com/deepseek-ai/deepseek-harness',
      'https://api-docs.deepseek.com/guides/harness',
    ]);
    assert.deepEqual(mapped.sources.map(x => x.title), ['deepseek-ai/deepseek-harness', 'DeepSeek Harness docs']);
    // 已知差异：snippet 来自 text 块的 citations[]，DeepSeek 不产出结构化引用，所以 dsh 拿到的来源没有 snippet
    assert.ok(mapped.sources.every(x => x.snippet === undefined));
    assert.ok(mapped.sources.every(x => x.publishedAt === undefined), 'page_age 为 null 时 dsh 不填 publishedAt');

    assert.deepEqual(body.usage.server_tool_use, { web_search_requests: 1 });
    assert.equal(body.usage.input_tokens, 80 + 300);
    assert.equal(body.usage.output_tokens, 6 + 9);

    // 上游侧：两轮 generate，第 1 轮带真实 schema 的 web_search，第 2 轮带 tool-call → tool-result
    assert.equal(s.mock.generateCount(), 2);
    const gens = s.mock.seen.filter(x => x.url === '/alpha/generate');
    const first = JSON.parse(gens[0].raw).params;
    assert.ok(first.tools.some(t => t.name === 'web_search' && t.input_schema?.properties?.query));
    const second = JSON.stringify(JSON.parse(gens[1].raw).params.messages);
    assert.ok(second.includes('"toolCallId":"call_dsh"') && second.includes('tool-result') && second.includes('deepseek-ai/deepseek-harness'));

    const searchReqs = s.mock.seen.filter(x => x.url === '/alpha/web-search');
    assert.equal(searchReqs.length, 1);
    assert.equal(JSON.parse(searchReqs[0].raw).query, 'deepseek harness release');
    assert.equal(searchReqs[0].headers['authorization'], 'Bearer user_test');
  } finally { await s.close(); }
});

test('dsh 形状：max_uses=1 且模型两轮都要搜 → 第二次是 max_uses_exceeded 错误块，dsh 仍能解析出第一次的来源', async () => {
  const ROUND_SEARCH_2 = ROUND_SEARCH.map(l => l.replace('"call_dsh"', '"call_dsh2"'));
  const s = await setup(scriptedUpstream([ROUND_SEARCH, ROUND_SEARCH_2, ROUND_ANSWER]));
  try {
    const { status, body } = await dshSearch(s, 'deepseek harness release', { maxUses: 1 });
    assert.equal(status, 200);
    const results = body.content.filter(b => b.type === 'web_search_tool_result');
    assert.equal(results.length, 2);
    assert.deepEqual(results[1].content, { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' });
    // dsh 的 mapAnthropicResponse 对错误块做 `for (const item of block.content ?? [])`，而错误块的
    // content 是对象不是数组，这里会抛 TypeError。Anthropic 官方的 web_search_tool_result_error 也是
    // 同样的对象形态，所以这是 dsh 自己的解析缺口，不是代理该兜的；记录下来便于日后对照。
    assert.throws(() => mapAnthropicResponse(body), TypeError);
    assert.equal(s.mock.seen.filter(x => x.url === '/alpha/web-search').length, 1);
  } finally { await s.close(); }
});

test('dsh 形状：模型不搜直接作答 → 200 且只有 text，dsh 侧按它自己的约定抛 no web_search_tool_result blocks（非代理问题）', async () => {
  const s = await setup(scriptedUpstream([ROUND_NO_SEARCH]));
  try {
    const { status, body } = await dshSearch(s, 'what is 2+2');
    assert.equal(status, 200);
    assert.deepEqual(body.content.map(b => b.type), ['text']);
    assert.throws(() => mapAnthropicResponse(body), /no web_search_tool_result blocks/);
    assert.equal(s.mock.generateCount(), 1, '模型没调工具就不该多打上游');
    // 工具确实下发给了模型（之前非流式会剥掉，模型根本没有搜的机会）
    assert.ok(s.mock.lastGenerate().body.params.tools.some(t => t.name === 'web_search'));
  } finally { await s.close(); }
});
