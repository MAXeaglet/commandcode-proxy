// 端点契约：四个路由在正常路径下的行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

test('POST /v1/chat/completions 流式：返回 OpenAI SSE 且内容正确', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { Authorization: 'Bearer user_test' });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /data: /);
    assert.ok(text.includes('hello'), 'SSE 应包含上游 text-delta 的内容');
    assert.match(text, /\[DONE\]/, '流应以 [DONE] 结束');
  } finally { await s.close(); }
});

test('POST /v1/chat/completions 非流式：返回 chat.completion 对象', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: 'Bearer user_test' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.object, 'chat.completion');
    assert.equal(j.choices[0].message.content, 'hello');
    assert.ok(j.usage, 'usage 必须存在');
  } finally { await s.close(); }
});

test('POST /v1/messages 流式：返回 Anthropic SSE 事件序列', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/messages',
      { model: 'deepseek/deepseek-v4-flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true },
      { 'x-api-key': 'user_test' });
    assert.equal(r.status, 200);
    const text = await r.text();
    for (const ev of ['message_start', 'content_block_start', 'message_stop']) {
      assert.ok(text.includes(ev), 'Anthropic SSE 应包含 ' + ev);
    }
  } finally { await s.close(); }
});

test('POST /v1/responses 流式：返回具名 SSE 事件', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/responses',
      { model: 'deepseek/deepseek-v4-flash', input: 'hi', stream: true },
      { Authorization: 'Bearer user_test' });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.includes('response.completed'), '应包含 response.completed');
    // 规范要求每个事件都带 sequence_number
    assert.ok(text.includes('sequence_number'), '每个事件都必须带 sequence_number');
  } finally { await s.close(); }
});

test('GET /v1/models 走 /provider/v1/models', async () => {
  const s = await setup({ env: { CC_USE_PROVIDER_MODELS: 'true' }, onRequest: (req, res) => {
    if (req.url === '/provider/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test/model-1', object: 'model' }] }));
    }
  }});
  try {
    const r = await s.proxy.get('/v1/models', { headers: { Authorization: 'Bearer user_test' } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.data));
    assert.equal(j.data[0].id, 'test/model-1');
  } finally { await s.close(); }
});

test('GET /health 与 / 返回存活状态', async () => {
  const s = await setup();
  try {
    for (const path of ['/health', '/']) {
      const r = await s.proxy.get(path);
      assert.equal(r.status, 200, path + ' 应返回 200');
    }
  } finally { await s.close(); }
});

test('未知路由返回 404', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.get('/nope');
    assert.equal(r.status, 404);
  } finally { await s.close(); }
});

test('缺少 API key 返回 401', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 401);
  } finally { await s.close(); }
});
