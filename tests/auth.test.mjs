import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, test, before, after, beforeEach } from 'node:test';
import { createApplication } from '../lib/application.mjs';
import { decrypt, encrypt, hashPassword, verifyPassword } from '../lib/security.mjs';

const ORIGIN = 'https://console.example.com';
const PASSWORD = '测试专用至少12字符安全';
const NEW_PASSWORD = '测试专用新密码至少12字符';
const MASTER_KEY = Buffer.alloc(32, 0x42);

let providerServer;
let providerBase;
const providerRequests = [];

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function providerHandler(req, res) {
  const body = await readRequestBody(req);
  providerRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
  if (req.method === 'GET' && req.url === '/provider/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'alpha' }] }));
  }
  if (req.method === 'POST' && req.url === '/alpha/generate') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(`${JSON.stringify({ type: 'text-delta', text: 'mock response' })}\n${JSON.stringify({ type: 'finish' })}\n`);
    return;
  }
  if (req.method === 'POST' && (req.url === '/alpha/fingerprint/record' || req.url === '/alpha/lifecycle-events')) {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'mock route not found' }));
}

function setCookieValue(setCookie) {
  if (!setCookie) return '';
  return setCookie.split(';', 1)[0];
}

function cookiesFromResponse(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  return values.map(setCookieValue).filter(Boolean);
}

function cookieNamed(cookies, name) {
  return cookies.find(value => value.startsWith(`${name}=`)) || '';
}

async function httpRequest(base, path, { method = 'GET', headers = {}, body, cookie, csrf, origin, ...options } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) {
    requestHeaders['content-type'] ??= 'application/json';
    options.body = JSON.stringify(body);
  }
  if (cookie) requestHeaders.cookie = cookie;
  if (csrf) requestHeaders['x-csrf-token'] = csrf;
  if (origin) requestHeaders.origin = origin;
  return fetch(`${base}${path}`, { ...options, method, headers: requestHeaders });
}

async function startApplication(options = {}) {
  const app = await createApplication({
    databasePath: ':memory:',
    masterKey: MASTER_KEY,
    initialPassword: PASSWORD,
    origin: ORIGIN,
    apiBase: providerBase,
    assetsPath: 'frontend/dist',
    maxInflight: 4,
    trustProxy: false,
    ...options,
  });
  const server = createServer(app.management);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return { ...app, server, base };
}

async function login(app, { password = PASSWORD, email = 'admin@example.com' } = {}) {
  const anonymous = await httpRequest(app.base, '/command/api/auth/session');
  assert.equal(anonymous.status, 401);
  const anonymousBody = await anonymous.json();
  const loginCookie = cookieNamed(cookiesFromResponse(anonymous), 'cc_login');
  assert.ok(loginCookie);
  const response = await httpRequest(app.base, '/command/api/auth/login', {
    method: 'POST',
    origin: ORIGIN,
    csrf: anonymousBody.csrf,
    cookie: loginCookie,
    body: { email, password },
  });
  const body = await response.json();
  const cookies = cookiesFromResponse(response);
  return {
    response,
    body,
    sessionCookie: cookieNamed(cookies, 'cc_session'),
    clearLoginCookie: cookieNamed(cookies, 'cc_login'),
  };
}

async function managementRequest(app, path, auth, options = {}) {
  return httpRequest(app.base, path, {
    ...options,
    cookie: auth?.sessionCookie,
    csrf: options.csrf === undefined ? auth?.body?.csrf : options.csrf,
    origin: options.origin === undefined && options.method && options.method !== 'GET' && options.method !== 'HEAD' ? ORIGIN : options.origin,
  });
}

async function createClient(app, auth, fields = {}) {
  const response = await managementRequest(app, '/command/api/clients', auth, {
    method: 'POST',
    body: {
      name: 'test client',
      notes: 'auth regression',
      enabled: true,
      expires_at: null,
      whitelist: ['alpha'],
      ...fields,
    },
  });
  assert.equal(response.status, 201);
  return response.json();
}

before(async () => {
  providerServer = createServer(providerHandler);
  providerServer.listen(0, '127.0.0.1');
  await once(providerServer, 'listening');
  providerBase = `http://127.0.0.1:${providerServer.address().port}`;
});

after(async () => {
  providerServer.close();
  await once(providerServer, 'close');
});

describe('security primitives', () => {
  test('password hashes use a salt and reject the wrong password', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    assert.notEqual(first, second);
    assert.notEqual(first.split(':')[0], second.split(':')[0]);
    assert.equal(await verifyPassword(PASSWORD, first), true);
    assert.equal(await verifyPassword('错误密码至少12字符', first), false);
    assert.notEqual(first, PASSWORD);
  });

  test('AES-GCM rejects ciphertext tampering and AAD mismatch', () => {
    const encrypted = encrypt('secret payload', MASTER_KEY, 'upstream-id');
    assert.equal(decrypt(encrypted, MASTER_KEY, 'upstream-id'), 'secret payload');

    const parts = encrypted.split('.');
    const ciphertext = Buffer.from(parts[2], 'base64url');
    ciphertext[0] ^= 1;
    assert.throws(() => decrypt(`${parts[0]}.${parts[1]}.${ciphertext.toString('base64url')}`, MASTER_KEY, 'upstream-id'));
    assert.throws(() => decrypt(encrypted, MASTER_KEY, 'different-upstream-id'));
  });
});

describe('management authentication and client secrets', () => {
  let app;

  beforeEach(async t => {
    app = await startApplication();
    t.after(async () => {
      app.close();
      app.server.close();
      await once(app.server, 'close');
    });
  });

  test('anonymous management requests are 401 and issue a login CSRF token', async () => {
    const response = await httpRequest(app.base, '/command/api/overview');
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'unauthenticated');

    const session = await httpRequest(app.base, '/command/api/auth/session');
    assert.equal(session.status, 401);
    const sessionBody = await session.json();
    assert.equal(typeof sessionBody.csrf, 'string');
    assert.ok(sessionBody.csrf.length >= 32);
    assert.ok(cookieNamed(cookiesFromResponse(session), 'cc_login'));
  });

  test('configured administrator email and inference URL reach login and overview', async t => {
    const configured = await startApplication({ initialAdminEmail: 'owner@example.com', internalBaseUrl: 'http://gateway.example.test:3051/v1' });
    t.after(async () => { configured.close(); configured.server.close(); await once(configured.server, 'close'); });
    const auth = await login(configured, { email: 'owner@example.com' });
    assert.equal(auth.response.status, 200);
    const overview = await httpRequest(configured.base, '/command/api/overview', { cookie: auth.sessionCookie });
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).internal_base_url, 'http://gateway.example.test:3051/v1');
  });

  test('login requires the configured Origin and login CSRF token; writes require session CSRF', async () => {
    const anonymous = await httpRequest(app.base, '/command/api/auth/session');
    const body = await anonymous.json();
    const loginCookie = cookieNamed(cookiesFromResponse(anonymous), 'cc_login');

    const wrongOrigin = await httpRequest(app.base, '/command/api/auth/login', {
      method: 'POST', origin: 'https://attacker.invalid', csrf: body.csrf, cookie: loginCookie,
      body: { email: 'admin@example.com', password: PASSWORD },
    });
    assert.equal(wrongOrigin.status, 403);

    const wrongLoginCsrf = await httpRequest(app.base, '/command/api/auth/login', {
      method: 'POST', origin: ORIGIN, csrf: 'wrong-token', cookie: loginCookie,
      body: { email: 'admin@example.com', password: PASSWORD },
    });
    assert.equal(wrongLoginCsrf.status, 403);

    const auth = await login(app);
    assert.equal(auth.response.status, 200);
    const noWriteCsrf = await httpRequest(app.base, '/command/api/clients', {
      method: 'POST', origin: ORIGIN, cookie: auth.sessionCookie,
      body: { name: 'blocked', notes: '', enabled: true, expires_at: null, whitelist: [] },
    });
    assert.equal(noWriteCsrf.status, 403);

    const wrongWriteOrigin = await managementRequest(app, '/command/api/clients', auth, {
      method: 'POST', origin: 'https://attacker.invalid',
      body: { name: 'blocked', notes: '', enabled: true, expires_at: null, whitelist: [] },
    });
    assert.equal(wrongWriteOrigin.status, 403);
  });

  test('logout invalidates the current session', async () => {
    const auth = await login(app);
    const loggedOut = await managementRequest(app, '/command/api/auth/session', auth, { method: 'DELETE' });
    assert.equal(loggedOut.status, 200);

    const afterLogout = await httpRequest(app.base, '/command/api/auth/session', { cookie: auth.sessionCookie });
    assert.equal(afterLogout.status, 401);
  });

  test('changing the password keeps the current session and revokes other sessions', async () => {
    const first = await login(app);
    const second = await login(app);
    assert.notEqual(first.sessionCookie, second.sessionCookie);

    const changed = await managementRequest(app, '/command/api/auth/password', first, {
      method: 'PATCH',
      body: { current_password: PASSWORD, password: NEW_PASSWORD },
    });
    assert.equal(changed.status, 200);

    const currentStillWorks = await httpRequest(app.base, '/command/api/auth/session', { cookie: first.sessionCookie });
    assert.equal(currentStillWorks.status, 200);
    const revokedOther = await httpRequest(app.base, '/command/api/auth/session', { cookie: second.sessionCookie });
    assert.equal(revokedOther.status, 401);

    const fresh = await login(app, { password: NEW_PASSWORD });
    assert.equal(fresh.response.status, 200);
  });

  test('five consecutive bad passwords lock the account and SQLite time adjustment unlocks it', async () => {
    const anonymous = await httpRequest(app.base, '/command/api/auth/session');
    const sessionBody = await anonymous.json();
    const loginCookie = cookieNamed(cookiesFromResponse(anonymous), 'cc_login');
    const attempt = () => httpRequest(app.base, '/command/api/auth/login', {
      method: 'POST', origin: ORIGIN, csrf: sessionBody.csrf, cookie: loginCookie,
      body: { email: 'admin@example.com', password: '错误密码至少12字符' },
    });

    const failures = [];
    for (let i = 0; i < 5; i++) failures.push(await attempt());
    assert.deepEqual(failures.slice(0, 4).map(response => response.status), [401, 401, 401, 401]);
    assert.equal(failures[4].status, 429);
    const limits = app.repo.db.prepare('SELECT failures, locked_until FROM login_limits').all();
    assert.equal(limits.length, 2);
    assert.ok(limits.every(row => row.failures >= 5 && row.locked_until > Date.now() + 14 * 60_000));

    app.repo.db.prepare('UPDATE login_limits SET locked_until=?, updated=?').run(Date.now() - 1, Date.now() - 1);
    const unlocked = await login(app);
    assert.equal(unlocked.response.status, 200);
  });

  test('client creation returns a key once but list and detail never return the secret', async () => {
    const auth = await login(app);
    const created = await createClient(app, auth);
    assert.equal(typeof created.key, 'string');
    assert.ok(created.key.length > 20);

    const listResponse = await managementRequest(app, '/command/api/clients', auth);
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.equal(Array.isArray(listed.data), true);
    const listedClient = listed.data.find(row => row.id === created.id);
    assert.ok(listedClient);
    assert.equal(Object.hasOwn(listedClient, 'key'), false);
    assert.equal(JSON.stringify(listedClient).includes(created.key), false);

    const detailResponse = await managementRequest(app, `/command/api/clients/${created.id}`, auth);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(Object.hasOwn(detail, 'key'), false);
    assert.equal(JSON.stringify(detail).includes(created.key), false);
  });

  test('disabled, expired, deleted, and default-rotated client keys stop authenticating immediately', async () => {
    const auth = await login(app);
    const created = await createClient(app, auth);
    const { id, key } = created;
    assert.ok(app.repo.authenticateClient(key));

    const disabled = await managementRequest(app, `/command/api/clients/${id}`, auth, {
      method: 'PATCH', body: { enabled: false },
    });
    assert.equal(disabled.status, 200);
    assert.equal(app.repo.authenticateClient(key), null);

    const reenabled = await managementRequest(app, `/command/api/clients/${id}`, auth, {
      method: 'PATCH', body: { enabled: true },
    });
    assert.equal(reenabled.status, 200);
    assert.ok(app.repo.authenticateClient(key));

    const row = app.repo.get('clients', id);
    app.repo.save('clients', { ...row, expires_at: Date.now() - 1 });
    assert.equal(app.repo.authenticateClient(key), null);

    const removed = await managementRequest(app, `/command/api/clients/${id}`, auth, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(app.repo.authenticateClient(key), null);

    const replacement = await createClient(app, auth);
    const rotated = await managementRequest(app, `/command/api/clients/${replacement.id}/rotate`, auth, {
      method: 'POST', body: {},
    });
    assert.equal(rotated.status, 200);
    const rotatedBody = await rotated.json();
    assert.equal(app.repo.authenticateClient(replacement.key), null);
    assert.ok(app.repo.authenticateClient(rotatedBody.key));
  });

  test('client rotation honors a grace window, including the legacy key format', async () => {
    const auth = await login(app);
    const created = await createClient(app, auth);
    const firstRotation = await managementRequest(app, `/command/api/clients/${created.id}/rotate`, auth, {
      method: 'POST', body: { grace_seconds: 2 },
    });
    assert.equal(firstRotation.status, 200);
    const firstRotationBody = await firstRotation.json();
    const graceKey = created.key;
    const replacementKey = firstRotationBody.key;
    assert.ok(app.repo.authenticateClient(graceKey));
    assert.ok(app.repo.authenticateClient(graceKey, Date.now() + 1_000));
    assert.equal(app.repo.authenticateClient(graceKey, Date.now() + 3_000), null);
    assert.ok(app.repo.authenticateClient(replacementKey));

    const invalidGrace = await managementRequest(app, `/command/api/clients/${created.id}/rotate`, auth, {
      method: 'POST', body: { grace_seconds: 3601 },
    });
    assert.equal(invalidGrace.status, 400);

    const legacyKey = 'legacy-client-secret-for-test';
    const legacy = app.repo.createClient({
      name: 'legacy', notes: '', enabled: true, expires_at: null, whitelist: [],
    }, legacyKey);
    assert.ok(app.repo.authenticateClient(legacyKey));
  });

  test('model refresh and upstream test use only the local mock provider and emit SSE lifecycle events', async () => {
    const auth = await login(app);
    const upstream = await managementRequest(app, '/command/api/upstreams', auth, {
      method: 'POST',
      body: {
        name: 'mock upstream', notes: '', enabled: true, whitelist: ['alpha'],
        priority: 0, load_factor: 1, max_concurrency: 2, credential: 'user_testcredential',
      },
    });
    assert.equal(upstream.status, 201);
    const upstreamBody = await upstream.json();
    assert.equal(JSON.stringify(upstreamBody).includes('user_testcredential'), false);

    const refreshed = await managementRequest(app, `/command/api/upstreams/${upstreamBody.id}/models/refresh`, auth, {
      method: 'POST', body: {},
    });
    assert.equal(refreshed.status, 200);
    const refreshedBody = await refreshed.json();
    assert.deepEqual(refreshedBody.models.map(model => model.id), ['alpha']);

    const sse = await managementRequest(app, `/command/api/upstreams/${upstreamBody.id}/test`, auth, {
      method: 'POST', body: { model: 'alpha', prompt: 'hello' },
    });
    assert.equal(sse.status, 200);
    const text = await sse.text();
    for (const event of ['connecting', 'connected', 'first_byte', 'text', 'done']) assert.match(text, new RegExp(`event: ${event}\\n`));
    assert.match(text, /"success":true/);
    assert.ok(providerRequests.some(request => request.url === '/alpha/generate'));
  });
});
