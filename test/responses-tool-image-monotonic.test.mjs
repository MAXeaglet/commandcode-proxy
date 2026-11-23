// 回归：工具截图裁剪必须是「连续后缀」，不能带洞。
//
// 事故（2026-11-13）：旧实现从最新往回贪心时，装不下就**跳过继续找更老的图**，
// 于是保留集带洞。下一轮来一张大小不同的新图，预算余量变化 → 洞的位置前移 →
// 之前在历史中段被替换成占位的图又「复活」成真图 → 该点之后的整段历史内容改变
// → 上游按前缀匹配的缓存从该点起全部作废（实测 29 万 token 只命中 1.4K）。
//
// 本测试用一组专门能打穿旧实现的尺寸（小-大-小-大），逐步追加图片，断言：
//   1) 每一轮被裁掉的永远是**连续前缀**（不存在"跳过某张却保留更老的"）
//   2) 被裁集合随轮次只增不减（已丢弃的旧图永不复活）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const fakePng = (bytes) => 'data:image/png;base64,' + 'A'.repeat(bytes);
const PREFIX_LEN = 'data:image/png;base64,'.length;

// 单位 KB。旧贪心在 1024KB 预算下的表现：
//   3 张 [50, 900, 100] → 保留 {1,2}（50 被跳过）
//   第 4 张 500 → 500+100=600、900 跳过、50 又能塞进 650 → 保留 {0,2,3}（50 复活、900 变占位）
// 连续后缀实现则只会把 cut 点往后推：{1,2} → {2,3}，50 永不复用。
const SIZES_KB = [50, 900, 100, 500];

function request(images) {
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '按顺序截个图' }] },
  ];
  images.forEach((url, i) => {
    input.push({ type: 'function_call', call_id: `call_${i}`, name: 'screenshot', arguments: '{}' });
    input.push({ type: 'function_call_output', call_id: `call_${i}`,
      output: [{ type: 'input_image', image_url: url }] });
  });
  return { model: 'm', input };
}

/** 从 wire 层的 cc 消息里读出「哪些原始索引还是真图」。
 *  同长度图片可能重复，故按长度分组、顺序消费，避免 Map 后写覆盖前写。 */
function keptIndices(msgs, urls) {
  const pool = new Map();          // len -> 待匹配的索引队列
  urls.forEach((u, i) => {
    if (!pool.has(u.length)) pool.set(u.length, []);
    pool.get(u.length).push(i);
  });
  const kept = [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type !== 'image') continue;
      const q = pool.get(part.image.length);
      assert.ok(q && q.length, `wire 上出现了未知长度的图（${part.image.length}），说明有图被改写/复制`);
      kept.push(q.shift());
    }
  }
  return kept.sort((a, b) => a - b);
}

test('裁剪结果是连续后缀，且已丢弃的旧图不会复活', async () => {
  const s = await setup({ env: { CC_MAX_TOOL_IMAGE_MB: '1' } });
  try {
    const urls = SIZES_KB.map(kb => fakePng(kb * 1024));
    let prevDropped = new Set();

    for (let n = 2; n <= urls.length; n++) {
      const images = urls.slice(0, n);
      await s.proxy.post('/v1/responses', request(images), AUTH);
      const kept = keptIndices(s.mock.lastGenerate().body.params.messages, images);
      const total = images.length;

      // 1) 连续后缀：[kept[0], total) 必须连续且以最后一张结尾
      assert.deepEqual(
        kept,
        Array.from({ length: kept.length }, (_, i) => kept[0] + i),
        `第 ${n} 轮保留集必须是连续后缀，实际 {${kept.join(',')}}`);
      assert.equal(kept[kept.length - 1], total - 1, `第 ${n} 轮必须保留最新那张`);

      // 2) 被裁集合只增不减
      const dropped = new Set(Array.from({ length: total }, (_, i) => i).filter(i => !kept.includes(i)));
      for (const idx of prevDropped) {
        assert.ok(dropped.has(idx),
          `第 ${n} 轮把之前已裁掉的 image#${idx} 又发了出去（历史中段被二次改写，前缀缓存会整段失效）`);
      }
      prevDropped = dropped;
    }

    // 顺带确认裁掉的那张留了占位说明（模型要知道历史里有图被丢）
    const placeholders = s.mock.lastGenerate().body.params.messages
      .flatMap(m => Array.isArray(m.content) ? m.content : [])
      .filter(c => c.type === 'text' && String(c.text).includes('image budget exceeded'));
    assert.ok(placeholders.length >= 1);
  } finally { await s.close(); }
});

test('预算内不裁剪（回归：不能因为改了算法就乱丢图）', async () => {
  const s = await setup({ env: { CC_MAX_TOOL_IMAGE_MB: '8' } });
  try {
    const urls = [100, 100, 100].map(kb => fakePng(kb * 1024));
    await s.proxy.post('/v1/responses', request(urls), AUTH);
    const kept = keptIndices(s.mock.lastGenerate().body.params.messages, urls);
    assert.deepEqual(kept, [0, 1, 2], '三张共 300KB，远小于 8MB，一张都不该裁');
  } finally { await s.close(); }
});

test('单张就超过预算时仍保留最新那张（至少保一张）', async () => {
  const s = await setup({ env: { CC_MAX_TOOL_IMAGE_MB: '1' } });
  try {
    const urls = [fakePng(1200 * 1024), fakePng(1300 * 1024)];  // 两张都超 1MB
    await s.proxy.post('/v1/responses', request(urls), AUTH);
    const kept = keptIndices(s.mock.lastGenerate().body.params.messages, urls);
    assert.deepEqual(kept, [1], '单张超预算也要保最新那张，且绝不能两张都发出去');
  } finally { await s.close(); }
});
