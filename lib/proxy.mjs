import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';

const CONNECT_TIMEOUT_MS = 15000;

export function proxyLabel(raw) {
  if (!raw) return '(direct)';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch { return '(invalid proxy)'; }
}

export function parseProxyUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048 || /[\s\x00-\x1f\x7f]/.test(raw)) throw new Error('代理链接格式无效');
  // Accept a backslash-escaped @ copied from Markdown examples.
  const normalized = raw.replace(/\\@/g, '@');
  let u;
  try { u = new URL(normalized); } catch { throw new Error('代理链接格式无效'); }
  if (!['http:', 'https:', 'socks5:'].includes(u.protocol) || !u.hostname || u.port === '0' || (!u.port && u.protocol === 'socks5:') || !['', '/'].includes(u.pathname) || u.search || u.hash) throw new Error('代理链接须为 http、https 或 socks5 的 host:port 地址');
  let username; let password;
  try { username = decodeURIComponent(u.username); password = decodeURIComponent(u.password); }
  catch { throw new Error('代理账号或密码编码无效'); }
  if ((!username && password) || /[\x00-\x1f\x7f]/.test(username + password)) throw new Error('代理账号或密码无效');
  if (u.protocol === 'socks5:' && (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255)) throw new Error('SOCKS5 代理账号或密码过长');
  return { protocol: u.protocol, host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), username, password, url: normalized };
}

function headersToInit(raw) {
  const out = [];
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) for (const item of v) out.push([k, String(item)]);
    else if (v !== undefined) out.push([k, String(v)]);
  }
  return out;
}

function socksConnect(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    let buffer = Buffer.alloc(0); let needed = 0; let step = 0; let settled = false;
    const fail = () => finish(new Error('SOCKS5 代理连接失败'));
    const abort = () => finish(signal.reason || new Error('请求已取消'));
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      socket.off('data', onData); socket.off('error', fail); socket.off('close', fail);
      if (error) { socket.destroy(); reject(error); }
      else { if (buffer.length) socket.unshift(buffer); resolve(socket); }
    };
    const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (step === 0) {
          if (buffer.length < 2) return;
          const method = buffer[1]; buffer = buffer.subarray(2);
          if (method === 0x02 && proxy.username) {
            const user = Buffer.from(proxy.username); const pass = Buffer.from(proxy.password);
            socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
            step = 1;
          } else if (method === 0x00) { sendTarget(); step = 2; }
          else return fail();
        } else if (step === 1) {
          if (buffer.length < 2) return;
          const ok = buffer[0] === 1 && buffer[1] === 0; buffer = buffer.subarray(2);
          if (!ok) return fail();
          sendTarget(); step = 2;
        } else {
          if (buffer.length < 5) return;
          const type = buffer[3];
          needed = type === 1 ? 10 : type === 4 ? 22 : type === 3 ? 7 + buffer[4] : 0;
          if (!needed) return fail();
          if (buffer.length < needed) return;
          const ok = buffer[0] === 5 && buffer[1] === 0;
          buffer = buffer.subarray(needed);
          return ok ? finish() : fail();
        }
      }
    };
    const sendTarget = () => {
      const name = Buffer.from(host);
      if (name.length > 255) return fail();
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
    };
    socket.on('data', onData); socket.on('error', fail); socket.on('close', fail);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => socket.write(Buffer.from([5, proxy.username ? 2 : 1, ...(proxy.username ? [0, 2] : [0])] )));
  });
}

function httpConnect(proxy, target, signal) {
  return new Promise((resolve, reject) => {
    const transport = proxy.protocol === 'https:' ? https : http;
    const auth = proxy.username ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` : null;
    // CONNECT's Host names the target; the proxy TLS handshake must verify the proxy hostname.
    const req = transport.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: target,
      headers: { Host: target, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
      ...(proxy.protocol === 'https:' ? { servername: proxy.host } : {}), timeout: CONNECT_TIMEOUT_MS, agent: false });
    const abort = () => req.destroy(signal.reason || new Error('请求已取消'));
    req.on('connect', (res, socket, head) => {
      signal?.removeEventListener('abort', abort);
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`代理 CONNECT 失败（HTTP ${res.statusCode}）`)); return; }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error('代理 CONNECT 超时')));
    req.on('error', reject);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    req.end();
  });
}

export async function proxyFetch(urlStr, options = {}, rawProxy) {
  const proxy = parseProxyUrl(rawProxy);
  const u = new URL(urlStr);
  const isTls = u.protocol === 'https:';
  const port = Number(u.port || (isTls ? 443 : 80));
  const target = `${u.hostname}:${port}`;
  const { signal, body } = options;
  const rawSocket = proxy.protocol === 'socks5:' ? await socksConnect(proxy, u.hostname, port, signal) : await httpConnect(proxy, target, signal);
  let socket = rawSocket;
  if (isTls) {
    socket = tls.connect({ socket: rawSocket, servername: u.hostname });
    try {
      await new Promise((resolve, reject) => {
        const abort = () => failure(signal.reason || new Error('请求已取消'));
        const timer = setTimeout(() => failure(new Error('上游 TLS 握手超时')), CONNECT_TIMEOUT_MS);
        const cleanup = () => { clearTimeout(timer); socket.off('secureConnect', success); socket.off('error', failure); signal?.removeEventListener('abort', abort); };
        const success = () => { cleanup(); resolve(); };
        const failure = error => { cleanup(); reject(error); };
        socket.once('secureConnect', success); socket.once('error', failure);
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
    } catch (error) { socket.destroy(); throw error; }
  }
  return new Promise((resolve, reject) => {
    const transport = isTls ? https : http;
    const agent = new transport.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    let responded = false;
    const req = transport.request({ host: u.hostname, port, path: u.pathname + u.search, method: options.method || 'GET', headers: options.headers || {}, agent }, res => {
      responded = true;
      res.once('close', () => signal?.removeEventListener('abort', abort));
      const noBody = [204, 205, 304].includes(res.statusCode);
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers: headersToInit(res.headers) }));
    });
    req.on('error', reject);
    const abort = () => req.destroy(signal.reason || new Error('请求已取消'));
    req.on('close', () => { if (!responded) signal?.removeEventListener('abort', abort); });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    if (body != null) req.write(body);
    req.end();
  });
}
