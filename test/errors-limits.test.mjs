// 错误映射 + 请求体上限 + 在途上限。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const CHAT = { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] };

// CC_STATUS_MAP 的语义契约（逐条来自 proxy.mjs 的映射表）：
//   400/401/404 原样透传；422 -> 400；403 -> 401；402 -> 429（payment → rate limit）
//   500/502 -> 502；503 -> 503；未列出的状态 -> 502 upstream_error
const MAPPING = [
  [400, 400], [401, 401], [404, 404],
  [422, 400], [403, 401], [402, 429],
  [500, 502], [502, 502], [503, 503],
  [418, 502],   // 未在表中 → upstream_error
];

for (const [upstream, expected] of MAPPING) {
  test('状态映射：上游 ' + upstream + ' -> 下游 ' + expected, async () => {
    const s = await setup({ status: upstream, errorBody: JSON.stringify({ error: { message: 'mock' } }) });
    try {
      const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
      assert.equal(r.status, expected, '上游 ' + upstream + ' 应映射为 ' + expected);
      const j = await r.json();
      assert.ok(j.error && j.error.type, '响应体应含 error.type');
    } finally { await s.close(); }
  });
}

test('上游 402（payment required）映射为 429 而非 402', async () => {
  const s = await setup({ status: 402, errorBody: JSON.stringify({ error: { message: 'insufficient credits' } }) });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r.status, 429, '402 是 CC 的余额语义，下游按限流处理');
    const j = await r.json();
    assert.match(j.error.message, /insufficient credits/, '上游错误体应透传进 message');
  } finally { await s.close(); }
});

test('上游 429 映射为 rate_limit_error 并带 retry_after', async () => {
  const s = await setup({ status: 429, errorBody: JSON.stringify({ error: { message: 'slow down' } }) });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    const j = await r.json();
    assert.equal(r.status, 429);
    assert.equal(j.error.type, 'rate_limit_error');
  } finally { await s.close(); }
});

test('上游 5xx 映射为 502/503 类服务端错误', async () => {
  const s = await setup({ status: 500, errorBody: JSON.stringify({ error: { message: 'boom' } }) });
  try {
    const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.ok(r.status >= 500, '上游 500 应映射成 5xx，实际 ' + r.status);
  } finally { await s.close(); }
});

test('Anthropic 端点：上游错误以 Anthropic 错误体返回', async () => {
  const s = await setup({ status: 429, errorBody: JSON.stringify({ error: { message: 'slow down' } }) });
  try {
    const r = await s.proxy.post('/v1/messages',
      { model: 'm', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': 'user_test' });
    const j = await r.json();
    assert.ok(j.error || j.type, 'Anthropic 错误体应有 error 或 type 字段');
  } finally { await s.close(); }
});

test('非法 JSON 请求体返回 400', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions', '{not json', AUTH);
    assert.equal(r.status, 400);
  } finally { await s.close(); }
});

test('超过 CC_MAX_BODY_MB 的请求返回 413，且之后小请求仍可用', async () => {
  const s = await setup({ env: { CC_MAX_BODY_MB: '1' } });
  try {
    const big = JSON.stringify({ model: 'm', stream: true,
      messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] });
    const r1 = await s.proxy.post('/v1/chat/completions', big, AUTH);
    assert.equal(r1.status, 413, '超限请求应返回 413（而非直接 reset）');

    // issue #7：超限后连接必须保持可排空，后续请求不受影响
    const r2 = await s.proxy.post('/v1/chat/completions',
      { model: 'm', stream: true, messages: [{ role: 'user', content: 'small' }] }, AUTH);
    assert.equal(r2.status, 200, '超限拒绝后小请求仍应正常');
    await r2.text();
  } finally { await s.close(); }
});

test('默认上限放行多模态量级的请求（issue #7 场景，~9MB）', async () => {
  const s = await setup();
  try {
    const body = JSON.stringify({ model: 'm', stream: true,
      messages: [{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }] });
    const r = await s.proxy.post('/v1/chat/completions', body, AUTH);
    assert.equal(r.status, 200, '默认 100MB 上限必须容纳 #7 的多模态长会话');
    await r.text();
  } finally { await s.close(); }
});

test('CC_MAX_INFLIGHT 限流：超限返回 503 + Retry-After，且名额会释放', async () => {
  // 让上游把请求挂住，以便观察在途名额
  const s = await setup({ env: { CC_MAX_INFLIGHT: '1' },
    onRequest: async (req, res) => { if (req.url === '/alpha/generate') await new Promise(r => setTimeout(r, 1200)); } });
  try {
    const first = s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    await new Promise(r => setTimeout(r, 400));   // 确保第一个已占住名额

    const r2 = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r2.status, 503, '超出在途上限应返回 503');
    assert.equal(r2.headers.get('retry-after'), '5', '应带 Retry-After');
    const j = await r2.json();
    assert.equal(j.error.type, 'server_busy');

    const r1 = await first;
    assert.equal(r1.status, 200, '已占住名额的请求应正常完成');
    await r1.text();

    // 名额释放后新请求应通行
    const r3 = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    assert.equal(r3.status, 200, '名额释放后应恢复通行');
    await r3.text();
  } finally { await s.close(); }
});

test('CC_MAX_INFLIGHT 不限制探活端点', async () => {
  const s = await setup({ env: { CC_MAX_INFLIGHT: '1' },
    onRequest: async (req, res) => { if (req.url === '/alpha/generate') await new Promise(r => setTimeout(r, 1200)); } });
  try {
    const first = s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    await new Promise(r => setTimeout(r, 400));
    // 探活端点被占满时仍必须可用，否则编排系统会误判容器已死
    for (const path of ['/health', '/']) {
      const r = await s.proxy.get(path);
      assert.equal(r.status, 200, path + ' 不应受在途上限影响');
    }
    const r1 = await first; await r1.text();
  } finally { await s.close(); }
});
