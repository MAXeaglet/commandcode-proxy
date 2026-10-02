// 上游闪断透明重试：CC 上游高峰期会中途 RST，undici 抛 `TypeError: terminated`。
// 若此刻**尚未向下游写出任何字节**，这个请求对下游而言从未开始过 —— 代理内部重试即可
// 消化抖动，下游不必先看到 502 再自行退避（那等于完整重发整个上下文）。
//
// 这组用例守住三条边界：① 未吐字前闪断才重试，且重试对下游完全透明；
// ② 已吐字 / 空闲超时 / 客户端断连一律不重试（否则会出现重复文本或吞掉 429 语义）；
// ③ 重试次数与开关按配置生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { allocPort, closeServer, startProxy } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const OK_LINES = [
  '{"type":"text-delta","text":"recovered"}',
  '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":12,"outputTokens":7}}',
];

/**
 * 一个可编排行为的 CC 上游 mock。
 * script 是「第 N 次 /alpha/generate 该怎么做」的数组，超出长度则重复最后一项：
 *   'ok'              正常吐完（下游应看到 recovered）
 *   'cut-before-byte' 写一个内部事件后 RST —— 代理尚未向下游写过任何字节
 *   'cut-after-byte'  先吐一个 text-delta（代理已转发给下游）再 RST
 *   'fin-short'       干净收尾（对端 FIN）但没有 finish 事件 —— 上游「没走完」
 *   'error-then-cut'  先发语义 error 事件（429），再 RST
 *   'hang'            一个字都不写，用来触发空闲看门狗
 */
async function startFlakyUpstream(script) {
  const port = await allocPort();
  const state = { generateCalls: 0 };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url !== '/alpha/generate') {
        // 指纹 / lifecycle / models 等辅助端点：一律空成功
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"data":[]}');
        return;
      }
      state.generateCalls++;
      const action = script[Math.min(state.generateCalls - 1, script.length - 1)];
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.flushHeaders();                                  // 头必须真的发出去，否则代理还卡在 fetch
      if (action === 'hang') return;                       // 已发头但一个字都不吐，等看门狗
      if (action === 'ok') {
        for (const line of OK_LINES) res.write(line + '\n');
        res.end();
        return;
      }
      if (action === 'fin-short') {                        // 干净 FIN，但内容不完整
        res.write('{"type":"start"}\n');
        res.end();
        return;
      }
      if (action === 'error-then-cut') {                   // 语义错误已到手，随后连接才断
        res.write('{"type":"error","error":{"message":"providers are currently at capacity","statusCode":429}}\n');
        setTimeout(() => res.socket?.destroy(), 30);
        return;
      }
      if (action === 'cut-after-byte') res.write('{"type":"text-delta","text":"partial"}\n');
      else res.write('{"type":"start"}\n');
      // 先给出真实字节（让 undici 进入 body 读取阶段），再粗暴 RST → terminated
      setTimeout(() => res.socket?.destroy(), 30);
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    port,
    state,
    close: () => closeServer(server),
  };
}

/** 起 mock 上游 + 代理，退避默认压到 20ms 让用例快跑 */
async function setupRetry(script, env = {}) {
  const mock = await startFlakyUpstream(script);
  const proxy = await startProxy({
    upstreamPort: mock.port,
    env: { CC_UPSTREAM_RETRY_BASE_MS: '20', ...env },
  });
  return {
    mock, proxy,
    chat: (stream = true) => proxy.post('/v1/chat/completions', { ...CHAT, stream }, AUTH),
    async close() { await proxy.kill(); await mock.close(); },
  };
}

/** 日志经 stdout 管道异步写出，断言前要等它落盘（而不是和刷盘赛跑） */
async function waitForLog(proxy, pattern, count = 1, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((proxy.logs().match(pattern) || []).length >= count) return;
    await sleep(25);
  }
  assert.fail(`日志未出现 ${count} 次 ${pattern}\n实际日志:\n${proxy.logs()}`);
}

// ── ① 未吐字前闪断 → 代理内部消化，下游无感 ────────────────

test('流式：上游吐字前闪断一次 → 下游只拿到一次 200，内容是重试后的结果', async () => {
  const s = await setupRetry(['cut-before-byte', 'ok']);
  try {
    const r = await s.chat(true);
    const text = await r.text();
    assert.equal(r.status, 200, '闪断已在代理内部消化，下游不该看到 502');
    assert.match(text, /recovered/, '正文应来自重试成功的那一次');
    assert.doesNotMatch(text, /proxy_error/, '下游不该看到上游闪断的痕迹');
    assert.equal(s.mock.state.generateCalls, 2, '上游应被调用两次：1 次闪断 + 1 次重试');
    await waitForLog(s.proxy, /Upstream stream terminated before first byte - retrying/);
    await waitForLog(s.proxy, /Upstream retry recovered/);
  } finally { await s.close(); }
});

test('非流式：同一条闪断也受保护', async () => {
  const s = await setupRetry(['cut-before-byte', 'ok']);
  try {
    const r = await s.chat(false);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.match(JSON.stringify(body), /recovered/);
    assert.equal(s.mock.state.generateCalls, 2);
  } finally { await s.close(); }
});

// ── ② 不重试的三种情形 ────────────────────────────────────

test('已向下游写过字节后闪断 → 绝不重试（否则下游会看到重复文本）', async () => {
  const s = await setupRetry(['cut-after-byte', 'ok']);
  try {
    const r = await s.chat(true);
    const text = await r.text();
    assert.match(text, /partial/, '已经吐给下游的内容必须保留');
    assert.doesNotMatch(text, /recovered/, '语义已提交，不能再补一次重试的内容');
    assert.equal(s.mock.state.generateCalls, 1, '已吐字后的闪断只能报错，不能重试');
  } finally { await s.close(); }
});

test('流空闲超时（429 减少上下文信号）不被重试', async () => {
  const s = await setupRetry(['hang'], { CC_STREAM_IDLE_MS: '300' });
  try {
    const r = await s.chat(true);
    const text = await r.text();
    assert.equal(r.status, 429, 'idle 超时是刻意传给下游的「请减少上下文」信号');
    assert.equal(s.mock.state.generateCalls, 1, 'idle 超时不能靠重试掩盖');
    assert.doesNotMatch(s.proxy.logs(), /retrying/);
  } finally { await s.close(); }
});

test('持续闪断 → 按上限放弃，仍然如实回 502', async () => {
  const s = await setupRetry(['cut-before-byte']);
  try {
    const r = await s.chat(true);
    const text = await r.text();
    assert.equal(r.status, 502, '重试救不回来时，行为与改动前一致');
    assert.match(text, /proxy_error/);
    assert.equal(s.mock.state.generateCalls, 3, '默认 2 次重试 = 共 3 次尝试');
    await waitForLog(s.proxy, /before first byte - retrying/g, 2);
    const retries = (s.proxy.logs().match(/before first byte - retrying/g) || []).length;
    assert.equal(retries, 2, '每次重试都要留日志，否则线上无法复盘');
  } finally { await s.close(); }
});

// ── ③ 配置开关 ────────────────────────────────────────────

// ── ④ 「干净 FIN」也是闪断：只在未吐字时可重试 ──────────────

test('上游干净收尾但没走完 finish（对端 FIN）→ 未吐字时同样重试', async () => {
  const s = await setupRetry(['fin-short', 'ok']);
  try {
    const r = await s.chat(true);
    const text = await r.text();
    assert.equal(r.status, 200, 'FIN 截断不该直接变成下游的 502');
    assert.match(text, /recovered/);
    assert.equal(s.mock.state.generateCalls, 2);
    await waitForLog(s.proxy, /Upstream stream ended incomplete before first byte - retrying/);
  } finally { await s.close(); }
});

test('持续 FIN 截断 → 按上限放弃，且不会被误记成「重试恢复」', async () => {
  const s = await setupRetry(['fin-short']);
  try {
    const r = await s.chat(true);
    assert.equal(r.status, 502);
    assert.equal(s.mock.state.generateCalls, 3);
    await waitForLog(s.proxy, /ended incomplete before first byte - retrying/g, 2);
    assert.doesNotMatch(s.proxy.logs(), /Upstream retry recovered/,
      '两次尝试都失败了，不能记成 recovered（日志会误导线上排查）');
  } finally { await s.close(); }
});

// ── ⑤ 上游语义错误优先于传输层错误 ──────────────────────────

test('已收到语义 error 事件后再闪断 → 不重试，且回语义状态码而不是 502', async () => {
  const s = await setupRetry(['error-then-cut', 'ok']);
  try {
    const r = await s.chat(true);
    assert.equal(r.status, 429, '重试会吞掉上游有意传下来的 429；502 则是把语义错误说成代理挂了');
    assert.equal(s.mock.state.generateCalls, 1, '语义错误不该被重试覆盖');
    assert.doesNotMatch(s.proxy.logs(), /retrying/);
  } finally { await s.close(); }
});

test('退避期间客户端断连 → 不再发起新的上游尝试', async () => {
  const s = await setupRetry(['cut-before-byte', 'ok'], { CC_UPSTREAM_RETRY_BASE_MS: '900' });
  try {
    const ac = new AbortController();
    const pending = fetch(`${s.proxy.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ ...CHAT, stream: true }),
      signal: ac.signal,
    }).catch(() => null);
    for (let i = 0; i < 80 && s.mock.state.generateCalls === 0; i++) await sleep(25);
    await waitForLog(s.proxy, /before first byte - retrying/);   // 确认已进入退避
    ac.abort();
    await pending;
    await sleep(1200);                                          // 退避 900ms 早已过去
    assert.equal(s.mock.state.generateCalls, 1, '断连后不得再打上游');
    await waitForLog(s.proxy, /Upstream retry abandoned \(client disconnected during backoff\)/);
  } finally { await s.close(); }
});

test('CC_UPSTREAM_RETRY_BASE_MS 合法值生效（启动横幅回显配置值）', async () => {
  const s = await setupRetry(['cut-before-byte', 'ok'], { CC_UPSTREAM_RETRY_BASE_MS: '1000' });
  try {
    const r = await s.chat(true);
    assert.equal(r.status, 200);
    assert.match(s.proxy.logs(), /upstreamRetry":"2 retries, base 1000ms/, '配置值要能在启动横幅里看到');
  } finally { await s.close(); }
});

test('CC_UPSTREAM_RETRY_MAX=0 关闭重试（行为退回改动前）', async () => {
  const s = await setupRetry(['cut-before-byte', 'ok'], { CC_UPSTREAM_RETRY_MAX: '0' });
  try {
    const r = await s.chat(true);
    assert.equal(r.status, 502);
    assert.equal(s.mock.state.generateCalls, 1);
  } finally { await s.close(); }
});

test('退避基数可配：CC_UPSTREAM_RETRY_BASE_MS 生效且非法值回落默认', async () => {
  const s = await setupRetry(['cut-before-byte', 'ok'], {
    CC_UPSTREAM_RETRY_BASE_MS: 'abc',
  });
  try {
    const r = await s.chat(true);
    assert.equal(r.status, 200);
    assert.match(s.proxy.logs(), /base 400ms/, '非法值不能把退避变成 0 或 NaN');
  } finally { await s.close(); }
});

// 客户端断连后不该继续重试：下游已经走了，重试只是白烧上游额度
test('客户端断连 → 打断上游且不重试', async () => {
  const s = await setupRetry(['hang'], { CC_STREAM_IDLE_MS: '5000' });
  try {
    const ac = new AbortController();
    const pending = fetch(`${s.proxy.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ ...CHAT, stream: true }),
      signal: ac.signal,
    }).catch(() => null);
    // 等上游真的被调用过，再断开下游
    for (let i = 0; i < 60 && s.mock.state.generateCalls === 0; i++) await sleep(25);
    assert.equal(s.mock.state.generateCalls, 1, '前置条件：代理已向上游发起请求');
    ac.abort();
    await pending;
    await sleep(300);
    assert.equal(s.mock.state.generateCalls, 1, '客户端断连后不得再发起重试');
    assert.doesNotMatch(s.proxy.logs(), /retrying/);
  } finally { await s.close(); }
});
