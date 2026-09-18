// /v1/responses：图片必须活着走到上游。CC 只收 user 角色上的图，所以
//   用户槽的 input_image → Chat 的 image_url，原样保留；
//   工具槽的图 → 从工具结果里摘掉，抬到紧随其后的一条 user 消息
//   （与 grok-mode-boost/lib/hoist.mjs 同一语义）。
// 断言的是**发到 mock 上游的 CC 请求体**，不是客户端拿到的响应：图片丢了
// 上游照样回 200，只看响应会得到假通过（渠道 6 上实测过这种静默失败）。
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

/** 发一轮并回传落到上游的 CC messages（CC 体里挂在 params.messages 下）。 */
async function send(s, input) {
  const r = await s.proxy.post('/v1/responses', { model: 'm', input }, AUTH);
  assert.equal(r.status, 200);
  await r.text();
  return s.mock.lastGenerate().body.params.messages;
}

const imagesOf = (msg) => (msg.content || []).filter(c => c && c.type === 'image');
const textOf = (msg) => (msg.content || []).find(c => c && c.type === 'text')?.text;
const usersOf = (msgs) => msgs.filter(m => m.role === 'user');
const toolCallsOf = (msg) => (msg.content || []).filter(c => c && c.type === 'tool-call');

test('responses：用户槽的图保留成 Chat 的 image_url（原实现直接丢弃）', async () => {
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

test('responses：工具槽的图抬到紧随其后的 user 消息（数组容器）', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [
      userSlot(txt('读图')),
      call('call_1'),
      toolOut('call_1', [txt('Read image file: a.png'), img]),
    ]);
    const iTool = msgs.findIndex(m => m.role === 'tool');
    assert.notEqual(iTool, -1, 'tool 消息要在');
    // 发起这条 tool 的 assistant 必须紧挨在它前面（call_id 邻接）
    assert.equal(msgs[iTool - 1].role, 'assistant');
    assert.deepEqual(toolCallsOf(msgs[iTool - 1]), [
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: { target_file: 'a.png' } },
    ]);
    // 工具结果里不再夹带图，只留文本
    assert.ok(!JSON.stringify(msgs[iTool]).includes('data:image/png'), '工具结果里不该再有 base64');
    assert.equal(msgs[iTool].content[0].output.value, JSON.stringify([txt('Read image file: a.png')]));
    // 抬出来的图就挂在 tool 之后的那条 user 消息上
    const hoisted = msgs[iTool + 1];
    assert.equal(hoisted.role, 'user');
    assert.deepEqual(imagesOf(hoisted).map(c => c.image), [DATA_URL]);
    assert.match(textOf(hoisted), /^\[tool result image: call_1\]$/);
    assert.equal(usersOf(msgs).length, 2);
  } finally { await s.close(); }
});

test('responses：工具槽的图抬到 user 消息（Codex 的 JSON 字符串容器）', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [
      userSlot(txt('读图')),
      call('call_1'),
      toolOut('call_1', JSON.stringify([txt('Read image file: a.png'), img])),
    ]);
    const iTool = msgs.findIndex(m => m.role === 'tool');
    assert.equal(msgs[iTool].content[0].output.value, JSON.stringify([txt('Read image file: a.png')]));
    assert.deepEqual(imagesOf(msgs[iTool + 1]).map(c => c.image), [DATA_URL]);
    assert.match(textOf(msgs[iTool + 1]), /call_1/);
  } finally { await s.close(); }
});

test('responses：并行工具结果里的图只在最后一个 tool 之后插一条 user', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [
      userSlot(txt('读两张图')),
      call('call_1'),
      call('call_2'),
      toolOut('call_1', [txt('Read image file: a.png'), img]),
      toolOut('call_2', [txt('Read image file: b.png'), img]),
    ]);
    const roles = msgs.map(m => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'tool', 'user']);
    assert.deepEqual(imagesOf(msgs.at(-1)).map(c => c.image), [DATA_URL, DATA_URL]);
    assert.equal(toolCallsOf(msgs[1]).length, 2);
  } finally { await s.close(); }
});

test('responses 回归：无图的工具结果不被改写', async () => {
  const s = await setup();
  try {
    const plain = await send(s, [userSlot(txt('读')), call('call_1'), toolOut('call_1', 'plain text result')]);
    assert.equal(plain.find(m => m.role === 'tool').content[0].output.value, 'plain text result');
    assert.equal(usersOf(plain).length, 1, '无图时不该多出 user 消息');

    const parts = [txt('a'), txt('b')];
    const arrayed = await send(s, [userSlot(txt('读')), call('call_2'), toolOut('call_2', parts)]);
    assert.equal(arrayed.find(m => m.role === 'tool').content[0].output.value, JSON.stringify(parts));
    assert.equal(usersOf(arrayed).length, 1);
  } finally { await s.close(); }
});

test('responses 回归：纯文本输入的字面量与改动前一致', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, 'hi');
    assert.deepEqual(msgs, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  } finally { await s.close(); }
});
