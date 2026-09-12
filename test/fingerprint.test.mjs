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
