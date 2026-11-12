// 隧道传输层重试 + 直连回退：已配 CC_UPSTREAM_PROXY 时，隧道本身可能不可用
// （代理进程重启、线路抖动：TLS 握手被掐断、首包后 RST）。#50 的流级重试救不了
// 这一层 —— 它重试时仍走原路（隧道），代理不可用则每次都失败，客户端只看到连续 502。
//
// 本组用例守住四条边界：① 隧道可用时行为不变（sanity）；
// ② 传输层失败 → 退避后重试一次隧道，仍失败则该条请求回退直连，下游只看到一次 200；
// ③ 非传输层失败（CONNECT 被拒绝）不重试、不回退 —— 那是配置问题，不该悄悄换路；
// ④ 退避期间客户端断连 → 不再发起新尝试（下游已经走了，换路只是白打上游）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { allocPort, closeServer, startProxy, startMockUpstream } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

/**
 * 一个可编排行为的 HTTP CONNECT 代理 mock。behavior 超出 script 长度则重复最后一项：
 *   'ok'        正常建立隧道并转发到真 mock 上游（sanity 用）
 *   'rst'       接受 TCP 连接后直接掐断 —— 隧道层传输失败（ECONNRESET / socket hang up）
 *   'reject'    回 HTTP 403 拒绝 CONNECT —— 非传输层失败，upstreamFetch 必须原样上抛
 *
 * 注意：首个对话请求前会先发 fingerprint / lifecycle 两个 init 预请求，它们同样走
 * upstreamFetch → 同样占 CONNECT。所以统一用 ['ok','ok',...] 先把 init 走完
 * （成功后 8h 内不再刷新），之后的 connect 才对应对话请求本身，计数才可断言。
 */
async function startConnectProxy(script) {
  const port = await allocPort();
  const state = { connects: 0 };
  let behavior;
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    state.connects++;
    behavior = script[Math.min(state.connects - 1, script.length - 1)];
    if (behavior === 'rst') { clientSocket.destroy(); return; }
    if (behavior === 'reject') {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nProxy-Authenticate: Basic realm="mock"\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    // 'ok'：把隧道另一端接到 mock 上游，纯字节转发
    const [host, portStr] = req.url.split(':');
    const upstream = net.connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port, state, close: () => closeServer(server) };
}

async function setupFallback(script, env = {}) {
  const mock = await startMockUpstream();
  const tunnel = await startConnectProxy(script);
  const proxy = await startProxy({
    upstreamPort: mock.port,
    env: { CC_UPSTREAM_PROXY: `http://127.0.0.1:${tunnel.port}`, ...env },
  });
  return {
    mock, tunnel, proxy,
    chat: (stream = true) => proxy.post('/v1/chat/completions', { ...CHAT, stream }, AUTH),
    async close() { await proxy.kill(); await tunnel.close(); await mock.close(); },
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

// ── ① sanity：隧道可用时行为与改动前完全一致 ────────────────

test('隧道可用 → 请求照常经隧道到达上游，行为不变', async () => {
  const s = await setupFallback(['ok']);
  try {
    const r = await s.chat(true);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.match(text, /hello/, '正文应来自 mock 上游，经隧道送达');
    assert.equal(s.tunnel.state.connects, 3, '2 次 init + 1 次对话，全部走隧道');
    assert.equal(s.mock.generateCount(), 1);
  } finally { await s.close(); }
});

// ── ② 传输层失败 → 重试一次隧道 → 仍失败则回退直连 ───────────

test('隧道 RST 两次 → 回退直连成功，下游无感', async () => {
  const s = await setupFallback(['ok', 'ok', 'rst']);   // 前两次是 init 预请求
  try {
    const r = await s.chat(true);
    const text = await r.text();
    assert.equal(r.status, 200, '代理不可用时该退化为慢但可用，而不是 502');
    assert.match(text, /hello/, '正文应来自回退后的直连请求');
    assert.equal(s.tunnel.state.connects, 4, '对话请求先重试一次隧道（共 2 次），然后才换路');
    assert.equal(s.mock.generateCount(), 1, '上游只会被直连请求命中一次');
    await waitForLog(s.proxy, /Upstream proxy attempt failed, retrying/);
    await waitForLog(s.proxy, /Upstream proxy retry failed, falling back to direct/);
  } finally { await s.close(); }
});

// ── ③ 非传输层失败：原样上抛，不重试、不回退 ─────────────────

test('CONNECT 被 403 拒绝 → 不重试也不换路，如实回 502', async () => {
  const s = await setupFallback(['ok', 'ok', 'reject']);   // 前两次是 init 预请求
  try {
    const r = await s.chat(true);
    const text = await r.text();
    assert.equal(r.status, 502, '代理拒绝 CONNECT 是配置/认证问题，必须原样暴露');
    assert.match(text, /proxy_error/);
    assert.equal(s.tunnel.state.connects, 3, '非传输层失败不得触发重试');
    assert.equal(s.mock.generateCount(), 0, '不得悄悄改走直连');
    assert.doesNotMatch(s.proxy.logs(), /retrying|falling back to direct/);
  } finally { await s.close(); }
});

// ── ④ 退避期间客户端断连 → 不再发起新尝试 ────────────────────

test('首次隧道失败后退避期间客户端断连 → 不再重试隧道，也不回退直连', async () => {
  const s = await setupFallback(['ok', 'ok', 'rst'], { CC_UPSTREAM_PROXY_RETRY_DELAY_MS: '2000' });
  try {
    const ac = new AbortController();
    const pending = fetch(`${s.proxy.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ ...CHAT, stream: true }),
      signal: ac.signal,
    }).catch(() => null);
    await waitForLog(s.proxy, /Upstream proxy attempt failed, retrying/);   // 已进入退避
    ac.abort();
    await pending;
    await sleep(2600);                                                      // 退避 2s 早已过去
    assert.equal(s.mock.generateCount(), 0, '断连后不得回退直连打上游');
    assert.ok(s.tunnel.state.connects <= 4,
      `断连后的第 2 次隧道尝试只能被 abort 立即打断（connects=${s.tunnel.state.connects}）`);
    assert.doesNotMatch(s.proxy.logs(), /falling back to direct/);
  } finally { await s.close(); }
});
