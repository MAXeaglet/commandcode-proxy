import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, connect } from 'node:net';
import test from 'node:test';
import { parseProxyUrl, proxyFetch, proxyLabel } from '../lib/proxy.mjs';

const sockets = new WeakMap();
const listen = server => new Promise(resolve => {
  const active = new Set(); sockets.set(server, active);
  server.on('connection', socket => { active.add(socket); socket.on('close', () => active.delete(socket)); });
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => { for (const socket of sockets.get(server) || []) socket.destroy(); server.close(resolve); });

test('proxy URLs accept supported schemes and Markdown-escaped @ without exposing credentials', () => {
  assert.equal(parseProxyUrl('socks5://name:word\\@127.0.0.1:8009').url, 'socks5://name:word@127.0.0.1:8009');
  assert.equal(parseProxyUrl('https://name:word@proxy.example:3443').protocol, 'https:');
  assert.equal(proxyLabel('https://name:word@proxy.example:3443'), 'https://proxy.example:3443');
  for (const bad of ['ftp://name:secret@proxy.example:21', 'http://name:secret@proxy.example:7890/path', 'socks5://name:secret@proxy.example']) {
    assert.throws(() => parseProxyUrl(bad), error => !error.message.includes('secret'));
  }
});

test('authenticated HTTP CONNECT and SOCKS5 proxies forward to the target', async t => {
  const target = createHttpServer((req, res) => { res.setHeader('Connection', 'close'); res.end(`target:${req.url}`); });
  const targetPort = await listen(target);
  t.after(() => close(target));
  let httpAuth;
  const httpProxy = createHttpServer();
  httpProxy.on('connect', (req, client) => {
    httpAuth = req.headers['proxy-authorization'];
    const upstream = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  const httpPort = await listen(httpProxy);
  t.after(() => close(httpProxy));
  const viaHttp = await proxyFetch(`http://127.0.0.1:${targetPort}/http`, {}, `http://agent:pass@127.0.0.1:${httpPort}`);
  assert.equal(await viaHttp.text(), 'target:/http');
  assert.equal(httpAuth, `Basic ${Buffer.from('agent:pass').toString('base64')}`);

  let socksAuth;
  const socksProxy = createTcpServer(client => {
    let buffer = Buffer.alloc(0); let phase = 0;
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === 0 && buffer.length >= 4) {
        assert.deepEqual([...buffer.subarray(0, 4)], [5, 2, 0, 2]);
        buffer = buffer.subarray(4); phase = 1; client.write(Buffer.from([5, 2]));
      }
      if (phase === 1 && buffer.length >= 2) {
        const length = 3 + buffer[1];
        if (buffer.length < length) return;
        const passLength = buffer[length - 1];
        if (buffer.length < length + passLength) return;
        socksAuth = `${buffer.subarray(2, length - 1)}:${buffer.subarray(length, length + passLength)}`;
        buffer = buffer.subarray(length + passLength); phase = 2; client.write(Buffer.from([1, 0]));
      }
      if (phase === 2 && buffer.length >= 5) {
        const length = 7 + buffer[4];
        if (buffer.length < length) return;
        assert.equal(buffer.readUInt16BE(length - 2), targetPort);
        client.off('data', onData); phase = 3;
        const upstream = connect(targetPort, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(upstream); upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
      }
    };
    client.on('data', onData);
  });
  const socksPort = await listen(socksProxy);
  t.after(() => close(socksProxy));
  const viaSocks = await proxyFetch(`http://127.0.0.1:${targetPort}/socks`, {}, `socks5://agent:pass@127.0.0.1:${socksPort}`);
  assert.equal(await viaSocks.text(), 'target:/socks');
  assert.equal(socksAuth, 'agent:pass');
});

test('the request itself uses the CONNECT tunnel instead of opening a direct connection', async t => {
  const proxy = createHttpServer();
  let targetRequest = '';
  proxy.on('connect', (req, socket) => {
    assert.equal(req.url, 'unresolvable.invalid:80');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', chunk => {
      targetRequest = chunk.toString();
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia-proxy');
    });
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));
  const response = await proxyFetch('http://unresolvable.invalid/proxy-only', {}, `http://127.0.0.1:${port}`);
  assert.equal(await response.text(), 'via-proxy');
  assert.match(targetRequest, /^GET \/proxy-only HTTP\/1\.1/);
});

test('abort closes a tunneled response that stalls after headers', async t => {
  const proxy = createHttpServer();
  proxy.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n'));
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));
  const response = await proxyFetch('http://unresolvable.invalid/stall', { signal: AbortSignal.timeout(100) }, `http://127.0.0.1:${port}`);
  await assert.rejects(response.body.getReader().read());
});
