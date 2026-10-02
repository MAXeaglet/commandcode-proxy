// 信封与请求头契约：断言 /alpha/generate 的**键序**与 header 集合。
// 依据官方 CLI 源码（command-code@1.54.0 dist/cli.mjs，未混淆）：
//   buildCommandAuthHeaders(e) → { 'Content-Type', 'User-Agent': "cli", [CLI_VERSION],
//     [CLI_ENVIRONMENT], [PROJECT_SLUG], [TASTE_LEARNING], [SESSION_ID], Authorization, ... }
//   常量表 Sy 共 10 项，**没有 x-co-flag**。
//   信封键序：config, memory, taste, skills, permissionMode, threadId, mode, params。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

async function generate(proxy, mock, path, body, headers = AUTH) {
  const r = await proxy.post(path, body, headers);
  await r.text();
  const g = mock.lastGenerate();
  assert.ok(g, '应至少产生一条 /alpha/generate');
  return { status: r.status, raw: g.raw, body: g.body, headers: g.headers };
}

test('信封键序与 CLI 一致：config…permissionMode, threadId, mode, params', async () => {
  const s = await setup();
  try {
    const { body } = await generate(s.proxy, s.mock, '/v1/chat/completions',
      { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { ...AUTH, 'x-session-id': UUID });
    assert.deepEqual(Object.keys(body),
      ['config', 'memory', 'taste', 'skills', 'permissionMode', 'threadId', 'mode', 'params']);
    assert.equal(body.threadId, UUID, 'threadId 必须与 x-session-id 同值');
  } finally { await s.close(); }
});

test('session 非 UUID 时 threadId 整键省略，键序仍为 CLI 顺序', async () => {
  const s = await setup();
  try {
    const { body } = await generate(s.proxy, s.mock, '/v1/chat/completions',
      { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { ...AUTH, 'x-session-id': 'my-cache-key-001' });
    assert.ok(!('threadId' in body), '非 UUID 不得下发 threadId');
    assert.deepEqual(Object.keys(body),
      ['config', 'memory', 'taste', 'skills', 'permissionMode', 'mode', 'params']);
  } finally { await s.close(); }
});

test('skills 是 null（CLI 发字面 null，不是空串）', async () => {
  const s = await setup();
  try {
    const { body } = await generate(s.proxy, s.mock, '/v1/chat/completions',
      { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(body.skills, null);
    assert.equal(body.memory, null);
    assert.equal(body.taste, null);
    assert.equal(body.mode, 'agent', '信封 mode 默认 agent');
  } finally { await s.close(); }
});

test('请求头集合与 CLI 的 buildCommandAuthHeaders 一致（无 x-co-flag）', async () => {
  const s = await setup();
  try {
    const { headers } = await generate(s.proxy, s.mock, '/v1/chat/completions',
      { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(headers['user-agent'], 'cli');
    assert.ok(!('x-co-flag' in headers), 'CLI 常量表 Sy 里没有 x-co-flag，不得发送');
    assert.equal(headers['x-cli-environment'], 'production');
    assert.equal(headers['x-taste-learning'], 'false', 'toString() 的字符串，不是布尔');
    assert.equal(headers['x-project-slug'], 'c-users-dev-projects-app',
      'x-project-slug = slugify(workingDir)，盘符保留（@sindresorhus/slugify 的结果）');
    assert.ok(headers['x-command-code-version']);
    assert.ok(headers.traceparent);
  } finally { await s.close(); }
});

test('config.workingDir 与 x-project-slug 同源，且不泄露宿主 cwd', async () => {
  const s = await setup();
  try {
    const { body, headers } = await generate(s.proxy, s.mock, '/v1/chat/completions',
      { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const slugify = p => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
    assert.equal(headers['x-project-slug'], slugify(body.config.workingDir),
      'slug 必须等于 slugify(workingDir)，否则两者自相矛盾');
    assert.ok(!body.config.workingDir.includes(process.cwd()),
      '不得把宿主机真实 cwd 交给上游');
    assert.equal(body.config.environment, 'win32', 'environment 是平台词，不是 "win32-x64, Node.js v…"');
  } finally { await s.close(); }
});

test('tools 总是下发：无工具时是空数组而非缺键（对齐 CLU 的 toWireTools）', async () => {
  const s = await setup();
  try {
    const { body } = await generate(s.proxy, s.mock, '/v1/chat/completions',
      { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(Array.isArray(body.params.tools), 'params.tools 必须存在');
    assert.equal(body.params.tools.length, 0);
  } finally { await s.close(); }
});

test('tools 形态：只有 name/description/input_schema，没有 type 字段', async () => {
  const s = await setup();
  try {
    const { body } = await generate(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } }],
    });
    assert.deepEqual(Object.keys(body.params.tools[0]), ['name', 'description', 'input_schema']);
    assert.equal(body.params.tools[0].name, 'get_weather');
  } finally { await s.close(); }
});

test('多模态 image_url 转成 CC image 块并带 mimeType', async () => {
  const s = await setup();
  try {
    const { body } = await generate(s.proxy, s.mock, '/v1/chat/completions', {
      model: 'm', stream: true,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ] }],
    });
    const img = body.params.messages[0].content.find(p => p.type === 'image');
    assert.ok(img, '应产出 image 块');
    assert.equal(img.mimeType, 'image/png', 'CLI 的 toWireMessages 会补 mimeType');
    assert.equal(img.image, 'data:image/png;base64,iVBORw0KGgo=');
  } finally { await s.close(); }
});

test('lifecycle metadata 的 mode 用另一个枚举（CC_CLI_SESSION_MODE）', async () => {
  const s = await setup({ env: { CC_CLI_SESSION_MODE: 'non-interactive', CC_CLI_MODE: 'compact' } });
  try {
    const r = await s.proxy.post('/v1/chat/completions',
      { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }, AUTH);
    await r.text();
    const lc = s.mock.seen.find(x => x.url === '/alpha/lifecycle-events');
    assert.equal(JSON.parse(lc.raw).metadata.mode, 'non-interactive');
    assert.equal(s.mock.lastGenerate().body.mode, 'compact',
      '信封 mode 与 lifecycle mode 是两个独立配置项');
  } finally { await s.close(); }
});
