// /v1/responses：用户槽（input 里的 user 消息）的图必须活着走到上游。
// convertResponsesToChat 原先只取 responsesTextOf()，user 消息里的 input_image
// 被静默丢弃 —— 上游照样回 200，客户端侧只表现为"模型没看到图"，因此断言的是
// **发到 mock 上游的 CC 请求体**，而不是客户端拿到的响应。
// 工具槽的图由 splitToolOutput/trimToolImages 处理（见 responses-tool-image.test.mjs）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const img = { type: 'input_image', detail: 'auto', image_url: DATA_URL };
const txt = (text) => ({ type: 'input_text', text });
const userSlot = (...content) => ({ type: 'message', role: 'user', content });
const call = (id) => ({ type: 'function_call', call_id: id, name: 'read_file', arguments: '{"target_file":"a.png"}' });
const toolOut = (id, output) => ({ type: 'function_call_output', call_id: id, output });

const wire = (s) => s.mock.lastGenerate().body.params.messages;
const imagesOf = (msg) => (msg.content || []).filter(c => c && c.type === 'image');
const allImages = (msgs) => msgs.flatMap(imagesOf);

async function send(s, input) {
  const r = await s.proxy.post('/v1/responses', { model: 'm', input }, AUTH);
  assert.equal(r.status, 200);
  await r.text();
  return wire(s);
}

test('responses：用户槽的图保留成 CC 的 image 块（原实现直接丢弃）', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [userSlot(txt('这张图里是什么？'), img)]);
    const last = msgs.at(-1);
    assert.equal(last.role, 'user');
    assert.deepEqual(last.content, [
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image', image: DATA_URL, mimeType: 'image/png' },
    ]);
  } finally { await s.close(); }
});

test('responses：只有图没有文字时不塞空 text 部件', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [userSlot(img)]);
    assert.deepEqual(msgs.at(-1).content, [{ type: 'image', image: DATA_URL, mimeType: 'image/png' }]);
  } finally { await s.close(); }
});

test('responses：图在多个 user 消息里都保留，顺序不变', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [userSlot(txt('第一张'), img), userSlot(txt('第二张'), img)]);
    assert.deepEqual(msgs.map(m => m.role), ['user', 'user']);
    assert.deepEqual(msgs.map(m => imagesOf(m).length), [1, 1]);
    assert.deepEqual(allImages(msgs).map(c => c.image), [DATA_URL, DATA_URL]);
  } finally { await s.close(); }
});

test('responses：用户槽与工具槽的图共存（#54 的工具图通路不回归）', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [
      userSlot(txt('看这两张'), img),
      call('call_1'),
      toolOut('call_1', [txt('Read image file: b.png'), img]),
    ]);
    assert.equal(allImages(msgs).length, 2, '用户槽与工具槽的图各一张');
    assert.equal(imagesOf(msgs[0]).length, 1, '用户图留在原消息上');
    const iTool = msgs.findIndex(m => m.role === 'tool');
    assert.ok(!JSON.stringify(msgs[iTool]).includes('data:image'), '工具结果里不能残留 base64');
    assert.equal(imagesOf(msgs[iTool + 1]).length, 1, '工具图仍抬到 tool 之后的 user 消息');
  } finally { await s.close(); }
});

test('responses 回归：纯文本输入的字面量与改动前一致', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, 'hi');
    assert.deepEqual(msgs, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  } finally { await s.close(); }
});

test('responses 回归：input_text 数组无图时仍是纯文本 user 消息', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [userSlot(txt('a'), txt('b'))]);
    assert.deepEqual(msgs, [{ role: 'user', content: [{ type: 'text', text: 'ab' }] }]);
  } finally { await s.close(); }
});
