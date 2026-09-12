// 测试用 mock 上游 + 代理进程管理。
// 全部走 loopback，不需要真 key、不访问 Command Code 或 npm registry。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = dirname(fileURLToPath(import.meta.url)).replace(/[/\\]test$/, '');

// ── 挂起保护 ──────────────────────────────────────────────
// 不能用 --test-timeout：Node 18 没有该选项（20.11 才加入），加了会让
// engines 下限直接跑不起来。改用启动一个 unref 的定时器，进程若因泄漏
// 的 socket / 未 await 的句柄而无法退出，到点强制退出并说明原因。
// 正常结束时定时器被 unref，不阻止退出。
const HANG_GUARD_MS = Number(process.env.CC_TEST_HANG_GUARD_MS ?? 120000);
const hangGuard = setTimeout(() => {
  console.error('[test] 超时未退出：疑似有 server/socket 未关闭（' +
    '检查每个测试是否都在 finally 里 await close()）。强制退出。');
  process.exit(1);
}, HANG_GUARD_MS);
hangGuard.unref?.();

// 取一个当前空闲的端口：让内核分配（listen 0）后立刻释放。
// 不能用 pid 派生区间 —— node --test 各文件并行，pid 取模会在不同 pid 间
// 映射到同一区间（如 pid 100 与 pid 600 同桶），进而偶发 EADDRINUSE。
// 内核分配把冲突面缩到「释放到重新占用」之间的极小窗口，调用方另有重试兜底。
import net from 'node:net';
export async function allocPort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 关闭一个 http server，且**保证有界**。
 * server.close() 只停止接受新连接，会一直等到既有连接结束 —— 若有 keep-alive
 * 或未被对端关闭的 socket，它会永远挂着，把 CI 拖到 job 超时。
 * （实际发生过：Fork 测试漏写一个 await 导致 mock 泄漏，三个矩阵 job 全部
 *   空转 10 分钟后被取消。）故先强制断开所有连接，再 close，并叠加兜底超时。
 */
export async function closeServer(server, timeoutMs = 3000) {
  if (!server || !server.listening) return;
  try { server.closeAllConnections?.(); } catch {}
  await Promise.race([new Promise(r => server.close(r)), sleep(timeoutMs)]);
  try { server.closeAllConnections?.(); } catch {}
}

/** 启动一个 mock 上游。ndjson 为要回给代理的 CC NDJSON 行数组。 */
export async function startMockUpstream(opts = {}) {
  const port = await allocPort();
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url, method: req.method, headers: req.headers, raw });
      if (opts.onRequest) await opts.onRequest(req, res, seen[seen.length - 1]);
      if (res.writableEnded) return;
      const status = opts.status ?? 200;
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(opts.errorBody || JSON.stringify({ error: { message: 'mock error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const line of opts.ndjson ?? [
        '{"type":"text-start"}',
        '{"type":"text-delta","text":"hello"}',
        '{"type":"text-end"}',
        '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":9,"outputTokens":3}}',
        '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":9,"outputTokens":3,"cachedInputTokens":0}}',
      ]) res.write(line + '\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { port, seen, close: () => closeServer(server),
    // 最后一次 /alpha/generate 的请求体（wire 层断言的主要入口）
    lastGenerate: () => {
      const g = seen.filter(s => s.url === '/alpha/generate').pop();
      return g ? { raw: g.raw, body: JSON.parse(g.raw), headers: g.headers } : null;
    },
    generateCount: () => seen.filter(s => s.url === '/alpha/generate').length };
}

/** 在临时 cwd 中启动代理（复刻真实部署：proxy.mjs 与 config.json 同目录）。 */
export async function startProxy({ upstreamPort, env = {}, cwd } = {}) {
  const port = await allocPort();
  const logs = [];
  // 自建的临时工作目录用完必须删；调用方传了 cwd 则由调用方负责。
  const ownWorkdir = cwd === undefined;
  const workdir = cwd ?? mkdtempSync(join(tmpdir(), 'ccp-test-'));
  copyFileSync(join(REPO, 'proxy.mjs'), join(workdir, 'proxy.mjs'));
  if (!existsSync(join(workdir, 'config.json'))) {
    copyFileSync(join(REPO, 'config.json'), join(workdir, 'config.json'));
  }
  const child = spawn(process.execPath, ['proxy.mjs'], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
      CC_API_BASE: 'http://127.0.0.1:' + upstreamPort,
      CC_USE_PROVIDER_MODELS: 'false',   // 不访问 /provider/v1/models
      ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => logs.push(d.toString()));
  child.stderr.on('data', d => logs.push(d.toString()));

  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(base + '/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(125);
  }
  if (!up) { child.kill(); throw new Error('proxy did not start:\n' + logs.join('')); }

  return {
    port, base, child, logs: () => logs.join(''),
    get: (path, init) => fetch(base + path, init),
    post: (path, body, headers = {}) => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    kill: () => new Promise(r => {
      child.once('exit', () => {
        if (ownWorkdir) { try { rmSync(workdir, { recursive: true, force: true }); } catch {} }
        r();
      });
      child.kill();
      setTimeout(() => {
        if (ownWorkdir) { try { rmSync(workdir, { recursive: true, force: true }); } catch {} }
        r();
      }, 2000);
    }),
  };
}

/** 一次性搭好 mock 上游 + 代理。 */
export async function setup(opts = {}) {
  const mock = await startMockUpstream(opts);
  const proxy = await startProxy({ upstreamPort: mock.port, env: opts.env, cwd: opts.cwd });
  return { mock, proxy, async close() { await proxy.kill(); await mock.close(); } };
}
