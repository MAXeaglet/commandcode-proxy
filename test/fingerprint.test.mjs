// 指纹 / lifecycle 预请求协议契约。
// 这三条预请求是 CC 侧设备识别的入口，字段形状与次序都属于「行为可观察」的部分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_fp' };
const CHAT = { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] };

// CLI 侧 FINGERPRINT_IB 的 components 字段全集（对齐 command-code CLI 实现）
const CLI_FIELDS = ['arch', 'collectorVersion', 'cpuCount', 'cpuModel', 'gitEmailHash',
  'hostnameHash', 'isContainer', 'macHashes', 'machineIdHash', 'memGiB', 'osRelease',
  'osUserHash', 'platform', 'runtime', 'timezone'];

async function firstRequest(s) {
  const r = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
  await r.text();
  return s.mock.seen;
}

test('初始化会发出 fingerprint/record 与 lifecycle-events 两条预请求', async () => {
  const s = await setup();
  try {
    const seen = await firstRequest(s);
    const paths = seen.map(x => x.url);
    assert.ok(paths.includes('/alpha/fingerprint/record'), '应发出 fingerprint/record');
    assert.ok(paths.includes('/alpha/lifecycle-events'), '应发出 lifecycle-events');
    assert.ok(paths.includes('/alpha/generate'), '应发出 generate');
  } finally { await s.close(); }
});

test('lifecycle 事件类型为 cli_session_exists', async () => {
  const s = await setup();
  try {
    await firstRequest(s);
    const lc = s.mock.seen.find(x => x.url === '/alpha/lifecycle-events');
    const body = JSON.parse(lc.raw);
    assert.equal(body.eventType, 'cli_session_exists');
  } finally { await s.close(); }
});

test('指纹 components 字段集合与 CLI 完全一致（不多不少）', async () => {
  const s = await setup();
  try {
    await firstRequest(s);
    const fp = s.mock.seen.find(x => x.url === '/alpha/fingerprint/record');
    const body = JSON.parse(fp.raw);
    const actual = Object.keys(body.components).sort();
    assert.deepEqual(actual, [...CLI_FIELDS].sort(),
      '字段集合偏离 CLI 是实现指纹的典型破绽');
  } finally { await s.close(); }
});

test('指纹 runtime=cli、collectorVersion=1，thumbmark/machineIdHash 为 64 位 hex', async () => {
  const s = await setup();
  try {
    await firstRequest(s);
    const body = JSON.parse(s.mock.seen.find(x => x.url === '/alpha/fingerprint/record').raw);
    assert.equal(body.components.runtime, 'cli', 'runtime 必须自称 cli');
    assert.equal(body.components.collectorVersion, 1);
    assert.match(body.thumbmark, /^[0-9a-f]{64}$/, 'thumbmark 应为 sha256 hex');
    assert.match(body.components.machineIdHash, /^[0-9a-f]{64}$/);
    assert.match(body.components.hostnameHash, /^[0-9a-f]{64}$/);
    assert.match(body.components.osUserHash, /^[0-9a-f]{64}$/);
  } finally { await s.close(); }
});

test('macHashes 为 2~5 个 hex 串（CLI 的取值区间）', async () => {
  const s = await setup();
  try {
    await firstRequest(s);
    const body = JSON.parse(s.mock.seen.find(x => x.url === '/alpha/fingerprint/record').raw);
    const macs = body.components.macHashes;
    assert.ok(Array.isArray(macs));
    assert.ok(macs.length >= 2 && macs.length <= 5, 'macHashes 数量应在 2~5，实际 ' + macs.length);
    for (const m of macs) assert.match(m, /^[0-9a-f]+$/);
  } finally { await s.close(); }
});

test('每种指纹只上报一次（进程内去重）', async () => {
  const s = await setup();
  try {
    await firstRequest(s);
    // 第二次请求不应再触发预请求
    const r2 = await s.proxy.post('/v1/chat/completions', CHAT, AUTH);
    await r2.text();
    const fpCount = s.mock.seen.filter(x => x.url === '/alpha/fingerprint/record').length;
    assert.equal(fpCount, 1, '同一进程内指纹只应上报一次，实际 ' + fpCount);
  } finally { await s.close(); }
});

test('不同 API key 各自初始化（互不复用指纹状态）', async () => {
  const s = await setup();
  try {
    const r1 = await s.proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer user_a' });
    await r1.text();
    const r2 = await s.proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer user_b' });
    await r2.text();
    const fpCount = s.mock.seen.filter(x => x.url === '/alpha/fingerprint/record').length;
    assert.equal(fpCount, 2, '每个 key 应各自初始化一次，实际 ' + fpCount);
  } finally { await s.close(); }
});

// components.cpuCount 是明文上传的，且可与同样明文的 cpuModel 交叉核对。
// CLI 的 gatherRawSignals 取 os.cpus().length —— 逻辑处理器数，不是物理核心数。
// 这张表是对「CLI 语义」的锁定：改了型号/核数就得同步改这里的期望值。
const EXPECTED_THREADS = {
  '12th Gen Intel(R) Core(TM) i7-12650H': 16,
  '12th Gen Intel(R) Core(TM) i5-12400F': 12,
  '12th Gen Intel(R) Core(TM) i9-12900K': 24,
  '13th Gen Intel(R) Core(TM) i7-13700K': 24,
  '13th Gen Intel(R) Core(TM) i5-13600K': 20,
  '13th Gen Intel(R) Core(TM) i9-13900K': 32,
  'Intel(R) Core(TM) Ultra 7 155H': 22,
  'Intel(R) Core(TM) Ultra 9 285H': 16,   // Arrow Lake 取消超线程，核数 == 线程数
  'Intel(R) Core(TM) i9-14900K': 32,
  'Intel(R) Core(TM) i7-14700K': 28,
  'AMD Ryzen 7 7800X3D': 16,
  'AMD Ryzen 9 7950X': 32,
  'AMD Ryzen 5 7600': 12,
  'AMD Ryzen 9 7900X': 24,
  'AMD Ryzen 7 5800X3D': 16,
};

test('cpuCount 是逻辑处理器数（os.cpus().length），且与 cpuModel 自洽', async () => {
  const s = await setup();
  try {
    const keys = ['user_a', 'user_b', 'user_c', 'user_d', 'user_e', 'user_f', 'user_g', 'user_h'];
    for (const k of keys) {
      const r = await s.proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer ' + k });
      await r.text();
    }
    const fps = s.mock.seen.filter(x => x.url === '/alpha/fingerprint/record')
      .map(x => JSON.parse(x.raw).components);
    assert.ok(fps.length >= 6, '应覆盖到足够多的指纹样本');
    for (const c of fps) {
      const expected = EXPECTED_THREADS[c.cpuModel];
      assert.ok(expected !== undefined, 'cpuModel 必须在已知表内：' + c.cpuModel);
      assert.equal(c.cpuCount, expected,
        `${c.cpuModel} 的 cpuCount 应为逻辑处理器数 ${expected}（CLI 取 os.cpus().length），` +
        '填物理核数等于宣称这台机器关了超线程 —— 而 cpuModel 与 cpuCount 都是明文，可被交叉核对');
    }
  } finally { await s.close(); }
});

