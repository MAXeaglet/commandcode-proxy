// Codex Desktop 的截图工具把 PNG 直接以 base64 塞进 function_call_output.output：
//   output: [{ type: 'input_image', image_url: 'data:image/png;base64,…' }]
// 真机事故（2026-09-28）：代理把它 JSON.stringify 成字符串塞进 tool-result，上游按**文本**分词，
// 单张 2.76MB 截图 ≈ 1.92M token，直接撞穿模型的 1M 窗口：
//   400 This model's maximum context length is 1048576 tokens. However, you requested 1986800 tokens
//       (1922800 in the messages, 64000 in the completion)
// 官方 CLI 的排布（command-code@1.66.0 dist/cli.mjs 的 convertUserMessage / tool_result 分支）：
//   tool-result 只放文本，图片提出来放进**紧跟其后**的一条 user 消息，
//   线格为 { type:'image', image:'data:<mime>;base64,…', mimeType:'<mime>' }。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
// 长度可控的假 PNG：内容不重要，断言的是"它有没有被当文本发出去"
const fakePng = (bytes) => 'data:image/png;base64,' + 'A'.repeat(bytes);

/** 一条带工具输出的 Responses 请求。imageUrl 为 null = 纯文本工具输出 */
function toolOutputRequest(output, { stream = false } = {}) {
  return {
    model: 'm', stream,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看下截图' }] },
      { type: 'function_call', call_id: 'call_1', name: 'screenshot', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output },
    ],
  };
}
const wire = (s) => s.mock.lastGenerate().body.params.messages;
const toolMsg = (msgs) => msgs.find(m => m.role === 'tool');
const imageParts = (msgs) => msgs.flatMap(m =>
  Array.isArray(m.content) ? m.content.filter(c => c.type === 'image') : []);

test('工具结果里的截图不再以文本形态发给上游', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/responses',
      toolOutputRequest([{ type: 'input_image', image_url: fakePng(300 * 1024) }]), AUTH);
    const msgs = wire(s);
    const tool = toolMsg(msgs);
    assert.ok(tool, '工具结果本身仍要发出');
    assert.ok(!JSON.stringify(tool).includes('data:image'),
      'tool-result 里不能残留 base64：上游按文本分词，2.76MB 就 ≈1.9M token，会直接撑爆 1M 窗口');
    const imgs = imageParts(msgs);
    assert.equal(imgs.length, 1, '图片必须作为独立的 image 块发出');
    assert.equal(imgs[0].mimeType, 'image/png', 'mimeType 取自 data URL');
    assert.ok(imgs[0].image.startsWith('data:image/png;base64,'), 'CC 线格要求 data URL 原样');
  } finally { await s.close(); }
});

test('带图的工具结果：图片挂在紧随其后的 user 消息上（对齐 CLI 排布）', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/responses',
      toolOutputRequest([{ type: 'input_image', image_url: fakePng(1000) }]), AUTH);
    const msgs = wire(s);
    const toolIdx = msgs.findIndex(m => m.role === 'tool');
    const imgMsgIdx = msgs.findIndex(m => imageParts([m]).length > 0);
    assert.equal(msgs[imgMsgIdx].role, 'user', '图片必须挂在 user 消息上，不能塞进 tool-result');
    assert.equal(imgMsgIdx, toolIdx + 1, '顺序必须紧跟 tool 消息 —— CLI 就是这么排的');
  } finally { await s.close(); }
});

test('纯文本工具输出行为不变（回归）', async () => {
  const s = await setup();
  try {
    const text = 'Chunk ID: 1\nProcess exited with code 0\nOutput:\nhello';
    await s.proxy.post('/v1/responses', toolOutputRequest(text), AUTH);
    const msgs = wire(s);
    assert.equal(msgs.map(m => m.role).join(','), 'user,assistant,tool',
      '不能因为这次改动多插消息');
    assert.equal(toolMsg(msgs).content[0].output.value, text, '文本原样透传');
    assert.equal(imageParts(msgs).length, 0);
  } finally { await s.close(); }
});

test('工具输出文本里内联的大 data URL 也会被提出来（不只结构化图块）', async () => {
  const s = await setup();
  try {
    const text = 'size 2.76MB\n' + fakePng(300 * 1024);
    await s.proxy.post('/v1/responses', toolOutputRequest(text), AUTH);
    const msgs = wire(s);
    const value = toolMsg(msgs).content[0].output.value;
    assert.ok(!value.includes('data:image'), '内联 base64 也不能留在文本里');
    assert.ok(value.includes('[image]'), '留占位，模型知道这里原本有图');
    assert.equal(imageParts(msgs).length, 1);
  } finally { await s.close(); }
});

// ── 每请求截图预算（CC_MAX_TOOL_IMAGE_MB）────────────────────────

test('超过预算：从最新往回保留，被裁的老图换占位说明', async () => {
  const s = await setup({ env: { CC_MAX_TOOL_IMAGE_MB: '1' } });
  try {
    const img = fakePng(400 * 1024);           // 单张约 0.39MB，三张 1.17MB > 1MB 预算
    const input = [];
    for (let i = 0; i < 3; i++) {
      input.push({ type: 'function_call', call_id: `call_${i}`, name: 'screenshot', arguments: '{}' });
      input.push({ type: 'function_call_output', call_id: `call_${i}`,
        output: [{ type: 'input_image', image_url: img }] });
    }
    await s.proxy.post('/v1/responses', { model: 'm', input }, AUTH);
    const msgs = wire(s);
    assert.equal(imageParts(msgs).length, 2, '1MB 预算应保留最新的两张（0.39 + 0.39）');
    const placeholders = msgs.flatMap(m => Array.isArray(m.content) ? m.content : [])
      .filter(c => c.type === 'text' && String(c.text).includes('image budget exceeded'));
    assert.equal(placeholders.length, 1, '被裁的那张要留占位，否则模型会以为历史里本来就没图');
  } finally { await s.close(); }
});

test('CC_MAX_TOOL_IMAGE_MB=0 关闭裁剪', async () => {
  const s = await setup({ env: { CC_MAX_TOOL_IMAGE_MB: '0' } });
  try {
    const img = fakePng(400 * 1024);
    const input = [];
    for (let i = 0; i < 3; i++) {
      input.push({ type: 'function_call', call_id: `call_${i}`, name: 'screenshot', arguments: '{}' });
      input.push({ type: 'function_call_output', call_id: `call_${i}`,
        output: [{ type: 'input_image', image_url: img }] });
    }
    await s.proxy.post('/v1/responses', { model: 'm', input }, AUTH);
    assert.equal(imageParts(wire(s)).length, 3, '关掉预算后一张都不该裁');
  } finally { await s.close(); }
});
