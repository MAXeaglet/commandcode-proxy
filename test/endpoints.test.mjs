// 端点契约：四个路由在正常路径下的行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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

test('GET /v1/models 走 /provider/v1/models?view=client', async () => {
  const s = await setup({ env: { CC_USE_PROVIDER_MODELS: 'true' }, onRequest: (req, res) => {
    const u = new URL(req.url, 'http://mock');
    if (u.pathname === '/provider/v1/models' && u.searchParams.get('view') === 'client') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        schemaVersion: 1,
        catalogVersion: 'catalog-2026-10-30.1',
        refreshAfterSeconds: 60,
        roles: {},
        data: [{ id: 'test/model-1', name: 'Test Model One', object: 'model' }],
      }));
    }
  }});
  try {
    const r = await s.proxy.get('/v1/models', { headers: { Authorization: 'Bearer user_test' } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.data));
    assert.equal(j.data[0].id, 'test/model-1');

    // 目录刷新对齐 1.88.2 CLI 的可观测形状：匿名（无 Authorization / 无版本头 / 无伪造 UA），
    // 只带 accept；已有 catalogVersion 后才追加 if-none-match。
    const hit = s.mock.seen.find(x => x.url.startsWith('/provider/v1/models'));
    assert.ok(hit, '应请求 /provider/v1/models');
    assert.equal(new URL(hit.url, 'http://mock').searchParams.get('view'), 'client');
    assert.equal(hit.headers.accept, 'application/json');
    assert.equal(hit.headers.authorization, undefined, '目录刷新是匿名请求，不带 Authorization');
    assert.equal(hit.headers['x-command-code-version'], undefined, '不附带版本头');
    assert.notEqual(hit.headers['user-agent'], 'cli',
      '目录刷新不伪造 CLI UA（裸 fetch 与真机 CLI 一样只带运行时默认值）');
  } finally { await s.close(); }
});

test('GET /v1/models 第二次刷新带 if-none-match，304 复用缓存', async () => {
  // 把刷新间隔压到 1ms（config.json 覆盖默认值），让第二次请求真的触发一次条件拉取。
  const dir = mkdtempSync(join(tmpdir(), 'ccp-models-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ modelRefreshIntervalMs: 1 }));
  const catalogReqs = [];
  const s = await setup({ cwd: dir, env: { CC_USE_PROVIDER_MODELS: 'true' }, onRequest: (req, res) => {
    const u = new URL(req.url, 'http://mock');
    if (u.pathname !== '/provider/v1/models') return;
    catalogReqs.push(req.headers);
    if (req.headers['if-none-match'] === '"catalog-2026-10-30.1"') {
      res.writeHead(304);          // 版本未变：CLI 的 fetchOnce 会沿用缓存
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      schemaVersion: 1,
      catalogVersion: 'catalog-2026-10-30.1',
      refreshAfterSeconds: 60,
      roles: {},
      data: [{ id: 'test/model-1', name: 'Test Model One', object: 'model' }],
    }));
  }});
  try {
    const first = await (await s.proxy.get('/v1/models', { headers: { Authorization: 'Bearer user_test' } })).json();
    assert.equal(first.data[0].id, 'test/model-1');

    await sleep(15);   // 越过 1ms 刷新窗口
    const second = await (await s.proxy.get('/v1/models', { headers: { Authorization: 'Bearer user_test' } })).json();
    assert.equal(second.data[0].id, 'test/model-1', '304 后继续服务缓存列表');

    assert.equal(catalogReqs.length, 2, '应发生第二次目录请求');
    assert.equal(catalogReqs[1]['if-none-match'], '"catalog-2026-10-30.1"',
      '第二次请求带引号包裹的 catalogVersion');
    assert.equal(catalogReqs[1].authorization, undefined, '条件请求同样匿名');
    assert.ok(!s.proxy.logs().includes('Provider models fetch failed'),
      '304 不应触发硬编码回退告警');
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
