import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import test, { after, before } from 'node:test';
import { createApplication } from '../lib/application.mjs';

const ORIGIN = 'https://console.example.com';
const PASSWORD = 'integration-password-123';
const MASTER_KEY = Buffer.alloc(32, 0x42);
const GOOD_CREDENTIAL = 'user_goodcredential123';
const BAD_CREDENTIAL = 'user_badcredential123';
const ERROR_CREDENTIAL = 'user_errorcredential123';
const RATE_CREDENTIAL = 'user_ratecredential123';

const state = {
  catalogByCredential: new Map(),
  generateByModel: new Map(),
  initRequests: [],
  modelRequests: [],
  generateRequests: [],
};

const successEvents = [
  { type: 'text-start' },
  { type: 'text-delta', text: 'hello ' },
  { type: 'text-delta', text: 'world' },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 8, outputTokens: 2, cachedInputTokens: 1 } },
];

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function mockResponse(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const mockHandler = async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const authorization = String(req.headers.authorization || '');

  if (path === '/provider/v1/models' && req.method === 'GET') {
    const credential = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    state.modelRequests.push({ credential, headers: req.headers });
    const configured = state.catalogByCredential.get(credential) || { status: 200, ids: ['alpha-model'] };
    if (configured.status !== 200) {
      mockResponse(res, configured.status, configured.body || { error: 'catalog failure' }, configured.headers);
      return;
    }
    mockResponse(res, 200, { data: configured.ids.map(id => ({ id })) });
    return;
  }

  if ((path === '/alpha/fingerprint/record' || path === '/alpha/lifecycle-events') && req.method === 'POST') {
    state.initRequests.push({ path, authorization, body: await requestBody(req) });
    mockResponse(res, 200, { ok: true });
    return;
  }

  if (path === '/alpha/generate' && req.method === 'POST') {
    const body = await requestBody(req);
    const model = body?.params?.model;
    const configured = state.generateByModel.get(model) || { status: 200, events: successEvents };
    state.generateRequests.push({ authorization, body, model, configured });
    if (configured.status !== 200) {
      mockResponse(res, configured.status, configured.body || '<401> provider rejected credential', configured.headers || (configured.status === 429 ? { 'retry-after': '7' } : {}));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    for (const event of configured.events) res.write(`${JSON.stringify(event)}\n`);
    res.end();
    return;
  }

  mockResponse(res, 404, { error: 'mock route not found' });
};

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function setCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('set-cookie');
  return value ? [value] : [];
}

function cookiePair(headers, name) {
  const entry = setCookies(headers).find(value => value.startsWith(`${name}=`));
  return entry ? entry.split(';', 1)[0] : '';
}

function sseEvents(text) {
  return text.split(/\n\n/).filter(Boolean).map(block => {
    const event = block.match(/^event: ([^\n]+)$/m)?.[1] || null;
    const dataText = block.match(/^data: ([\s\S]*?)$/m)?.[1];
    let data = dataText;
    try { data = JSON.parse(dataText); } catch {}
    return { event, data };
  });
}

async function call(base, path, { method = 'GET', headers = {}, body } = {}) {
  const requestHeaders = { ...headers };
  const options = { method, headers: requestHeaders };
  if (body !== undefined) {
    requestHeaders['content-type'] ||= 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { response, status: response.status, text, body: parsed };
}

let mockServer;
let app;
let managementServer;
let inferenceServer;
let managementBase;
let inferenceBase;
let csrf;
let sessionCookie;
let clientKey;
let oldClientKey;
let goodId;
let badId;

function managementCall(path, options = {}) {
  const headers = {
    origin: ORIGIN,
    'x-csrf-token': csrf,
    cookie: sessionCookie,
    ...options.headers,
  };
  return call(managementBase, path, { ...options, headers });
}

function inferenceCall(path, options = {}) {
  return call(inferenceBase, path, options);
}

before(async () => {
  const mock = await listen(mockHandler);
  mockServer = mock.server;

  state.catalogByCredential.set(GOOD_CREDENTIAL, { status: 200, ids: ['alpha-model'] });
  state.catalogByCredential.set(BAD_CREDENTIAL, {
    status: 401,
    body: { error: `invalid credential ${BAD_CREDENTIAL}` },
  });

  app = await createApplication({
    databasePath: ':memory:',
    masterKey: MASTER_KEY,
    initialPassword: PASSWORD,
    origin: ORIGIN,
    apiBase: mock.base,
    maxInflight: 4,
    trustProxy: false,
  });
  const management = await listen(app.management);
  const inference = await listen(app.inference);
  managementServer = management.server;
  inferenceServer = inference.server;
  managementBase = management.base;
  inferenceBase = inference.base;
});

after(async () => {
  app?.close();
  await Promise.all([
    managementServer ? close(managementServer) : Promise.resolve(),
    inferenceServer ? close(inferenceServer) : Promise.resolve(),
    mockServer ? close(mockServer) : Promise.resolve(),
  ]);
});

test('management auth and account CRUD keep secrets out of records', async () => {
  const anonymous = await call(managementBase, '/command/api/auth/session');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, 'unauthenticated');
  assert.match(anonymous.body.csrf, /^[A-Za-z0-9_-]{32,}$/);
  const loginCookie = cookiePair(anonymous.response.headers, 'cc_login');
  assert.ok(loginCookie);

  const missingOrigin = await call(managementBase, '/command/api/auth/login', {
    method: 'POST',
    headers: { cookie: loginCookie, 'x-csrf-token': anonymous.body.csrf },
    body: { email: 'admin@example.com', password: PASSWORD },
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.body.error.code, 'csrf_invalid');

  const login = await call(managementBase, '/command/api/auth/login', {
    method: 'POST',
    headers: { origin: ORIGIN, cookie: loginCookie, 'x-csrf-token': anonymous.body.csrf },
    body: { email: 'admin@example.com', password: PASSWORD },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.email, 'admin@example.com');
  assert.match(login.body.csrf, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(typeof login.body.expires_at, 'number');
  csrf = login.body.csrf;
  sessionCookie = cookiePair(login.response.headers, 'cc_session');
  assert.ok(sessionCookie);

  const unauthenticatedWrite = await call(managementBase, '/command/api/upstreams', {
    method: 'POST',
    body: { name: 'unauthorized', credential: GOOD_CREDENTIAL },
  });
  assert.equal(unauthenticatedWrite.status, 401);

  const good = await managementCall('/command/api/upstreams', {
    method: 'POST',
    body: {
      name: 'Primary provider', notes: 'local integration account', enabled: true,
      credential: GOOD_CREDENTIAL, priority: 0, load_factor: 1, max_concurrency: 2,
      whitelist: ['alpha-model'],
    },
  });
  assert.equal(good.status, 201);
  goodId = good.body.id;
  assert.equal(good.body.credential, undefined);
  assert.equal(good.body.credential_prefix, `${GOOD_CREDENTIAL.slice(0, 10)}…`);
  assert.equal(good.body.name, 'Primary provider');
  assert.doesNotMatch(JSON.stringify(good.body), new RegExp(GOOD_CREDENTIAL));

  const bad = await managementCall('/command/api/upstreams', {
    method: 'POST',
    body: {
      name: 'Bad provider', notes: '', enabled: true,
      credential: BAD_CREDENTIAL, priority: 0, load_factor: 1, max_concurrency: 2,
      whitelist: ['alpha-model'],
    },
  });
  assert.equal(bad.status, 201);
  badId = bad.body.id;
  assert.doesNotMatch(JSON.stringify(bad.body), new RegExp(BAD_CREDENTIAL));

  const updated = await managementCall(`/command/api/upstreams/${goodId}`, {
    method: 'PATCH',
    body: { name: 'Primary provider updated', notes: 'renamed', whitelist: ['alpha-model'] },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Primary provider updated');
  assert.equal(updated.body.credential, undefined);
  assert.doesNotMatch(JSON.stringify(updated.body), new RegExp(GOOD_CREDENTIAL));

  const detail = await managementCall(`/command/api/upstreams/${goodId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.name, 'Primary provider updated');
  assert.equal(detail.body.credential, undefined);
  assert.doesNotMatch(JSON.stringify(detail.body), new RegExp(GOOD_CREDENTIAL));
  const temporaryUpstream = await managementCall('/command/api/upstreams', {
    method: 'POST',
    body: {
      name: 'Delete upstream', notes: '', enabled: true,
      credential: 'user_deletecredential123', priority: 0, load_factor: 1, max_concurrency: 1,
      whitelist: [],
    },
  });
  assert.equal(temporaryUpstream.status, 201);
  const deletedUpstream = await managementCall(`/command/api/upstreams/${temporaryUpstream.body.id}`, { method: 'DELETE' });
  assert.equal(deletedUpstream.status, 200);
  assert.equal((await managementCall(`/command/api/upstreams/${temporaryUpstream.body.id}`)).status, 404);

  const clients = await managementCall('/command/api/clients', {
    method: 'POST',
    body: { name: 'Integration client', notes: 'temporary', enabled: true, expires_at: null, whitelist: [] },
  });
  assert.equal(clients.status, 201);
  assert.match(clients.body.key, /^sk-cc_/);
  clientKey = clients.body.key;
  assert.equal(clients.body.expires_at, null);

  const clientList = await managementCall('/command/api/clients');
  assert.equal(clientList.status, 200);
  assert.ok(clientList.body.data.some(row => row.id === clients.body.id));
  assert.equal(clientList.body.data.find(row => row.id === clients.body.id).key, undefined);
  assert.equal(clientList.body.data.find(row => row.id === clients.body.id).credential, undefined);

  const clientDetail = await managementCall(`/command/api/clients/${clients.body.id}`);
  assert.equal(clientDetail.status, 200);
  assert.equal(clientDetail.body.key, undefined);
  assert.equal(clientDetail.body.key_prefix, clients.body.key_prefix);

  const clientUpdate = await managementCall(`/command/api/clients/${clients.body.id}`, {
    method: 'PATCH',
    body: { name: 'Integration client updated', notes: 'updated', whitelist: [] },
  });
  assert.equal(clientUpdate.status, 200);
  assert.equal(clientUpdate.body.name, 'Integration client updated');
  assert.equal(clientUpdate.body.key, undefined);

  const invalidGrace = await managementCall(`/command/api/clients/${clients.body.id}/rotate`, {
    method: 'POST', body: { grace_seconds: 3601 },
  });
  assert.equal(invalidGrace.status, 400);
  assert.equal(invalidGrace.body.error.code, 'invalid_input');

  const rotated = await managementCall(`/command/api/clients/${clients.body.id}/rotate`, {
    method: 'POST', body: { grace_seconds: 0 },
  });
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.key, /^sk-cc_/);
  oldClientKey = clientKey;
  clientKey = rotated.body.key;
  assert.notEqual(clientKey, oldClientKey);
  assert.match(rotated.body.key_prefix, /^sk-cc_/);

  const rotatedDetail = await managementCall(`/command/api/clients/${clients.body.id}`);
  assert.equal(rotatedDetail.status, 200);
  assert.equal(rotatedDetail.body.key, undefined);
  assert.equal(rotatedDetail.body.key_prefix, rotated.body.key_prefix);

  const temporaryClient = await managementCall('/command/api/clients', {
    method: 'POST',
    body: { name: 'Delete me', notes: '', enabled: true, expires_at: null, whitelist: [] },
  });
  assert.equal(temporaryClient.status, 201);
  const deleted = await managementCall(`/command/api/clients/${temporaryClient.body.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await managementCall(`/command/api/clients/${temporaryClient.body.id}`)).status, 404);
});

test('account proxy is encrypted, redacted, editable and removable', async () => {
  const secret = 'socks5://agent:example-pass@127.0.0.1:18009';
  const created = await managementCall('/command/api/upstreams', { method: 'POST', body: {
    name: 'Proxy account', credential: 'user_proxyaccount123', enabled: false, proxy_url: secret,
  } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.proxy_label, 'socks5://127.0.0.1:18009');
  assert.doesNotMatch(JSON.stringify(created.body), /example-pass/);
  const stored = app.repo.db.prepare('SELECT url FROM upstream_proxies WHERE upstream_id=?').get(id);
  assert.ok(stored);
  assert.doesNotMatch(stored.url, /example-pass/);
  assert.equal(app.repo.proxy(id), secret);
  const listed = await managementCall('/command/api/upstreams');
  assert.doesNotMatch(JSON.stringify(listed.body), /example-pass/);
  const invalid = await managementCall(`/command/api/upstreams/${id}`, { method: 'PATCH', body: { proxy_url: 'ftp://agent:example-pass@127.0.0.1:18009' } });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(invalid.text, /example-pass/);
  assert.equal(app.repo.proxy(id), secret);
  const cleared = await managementCall(`/command/api/upstreams/${id}`, { method: 'PATCH', body: { proxy_url: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.proxy_label, null);
  assert.equal(app.repo.proxy(id), null);
});

test('model refresh persists success and failure, and manual test emits SSE lifecycle', async () => {
  const refreshed = await managementCall(`/command/api/upstreams/${goodId}/models/refresh`, { method: 'POST', body: {} });
  assert.equal(refreshed.status, 200);
  assert.deepEqual(refreshed.body.models, [{ id: 'alpha-model' }]);
  assert.equal(refreshed.body.health, 'healthy');
  assert.equal(refreshed.body.credential, undefined);
  assert.doesNotMatch(JSON.stringify(refreshed.body), new RegExp(GOOD_CREDENTIAL));

  const failedRefresh = await managementCall(`/command/api/upstreams/${badId}/models/refresh`, { method: 'POST', body: {} });
  assert.equal(failedRefresh.status, 502);
  assert.equal(failedRefresh.body.error.code, 'upstream_error');
  assert.doesNotMatch(failedRefresh.text, new RegExp(BAD_CREDENTIAL));
  const badDetail = await managementCall(`/command/api/upstreams/${badId}`);
  assert.equal(badDetail.body.health, 'credential_error');
  assert.match(badDetail.body.models_error, /HTTP 401/);
  assert.doesNotMatch(JSON.stringify(badDetail.body), new RegExp(BAD_CREDENTIAL));

  const manual = await managementCall(`/command/api/upstreams/${goodId}/test`, {
    method: 'POST',
    body: { model: 'alpha-model', prompt: 'say hello from the isolated test' },
  });
  assert.equal(manual.status, 200);
  assert.equal(manual.response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = sseEvents(manual.text);
  assert.deepEqual(events.map(item => item.event), ['connecting', 'connected', 'first_byte', 'text', 'text', 'done']);
  assert.equal(events[1].data.status, 200);
  assert.equal(events[2].data.elapsed_ms >= 0, true);
  assert.deepEqual(events.slice(3, 5).map(item => item.data.text), ['hello ', 'world']);
  assert.equal(events.at(-1).data.success, true);
  assert.doesNotMatch(manual.text, new RegExp(GOOD_CREDENTIAL));

  const forbiddenManual = await managementCall(`/command/api/upstreams/${goodId}/test`, {
    method: 'POST', body: { model: 'not-in-catalog', prompt: 'must be rejected' },
  });
  assert.equal(forbiddenManual.status, 403);
  assert.equal(forbiddenManual.body.error.code, 'model_not_allowed');
});

test('messages, responses, and chat completions all stream and buffer converted output', async () => {

  const protocols = [
    {
      path: '/v1/chat/completions',
      streamBody: { model: 'alpha-model', messages: [{ role: 'system', content: 'be concise' }, { role: 'user', content: 'hello' }], stream: true },
      plainBody: { model: 'alpha-model', messages: [{ role: 'user', content: 'hello' }], stream: false },
      checkRequest(body) {
        assert.deepEqual(body.params.system, [{ type: 'text', text: 'be concise' }]);
        assert.deepEqual(body.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
        assert.deepEqual(body.params.tools, []);
        assert.equal(body.skills, null);
        assert.equal(body.mode, 'agent');
        assert.equal(body.config.environment, 'win32');
      },
      checkStream(text) {
        assert.match(text, /data: \[DONE\]/);
        const chunks = text.split('\n\n').filter(Boolean).filter(block => block.startsWith('data: ') && block !== 'data: [DONE]').map(block => JSON.parse(block.slice(6)));
        assert.equal(chunks.some(chunk => chunk.choices?.[0]?.delta?.content === 'hello '), true);
        assert.equal(chunks.some(chunk => chunk.choices?.[0]?.delta?.content === 'world'), true);
        assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
      },
      checkPlain(body) {
        assert.equal(body.object, 'chat.completion');
        assert.equal(body.choices[0].message.content, 'hello world');
        assert.equal(body.choices[0].finish_reason, 'stop');
      },
    },
    {
      path: '/v1/messages',
      streamBody: { model: 'alpha-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }], stream: true },
      plainBody: { model: 'alpha-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }], stream: false },
      checkRequest(body) {
        assert.deepEqual(body.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
      },
      checkStream(text) {
        assert.match(text, /event: message_start/);
        assert.match(text, /event: content_block_delta/);
        assert.match(text, /"text":"hello "/);
        assert.match(text, /"text":"world"/);
        assert.match(text, /event: message_stop/);
      },
      checkPlain(body) {
        assert.equal(body.type, 'message');
        assert.equal(body.content[0].type, 'text');
        assert.equal(body.content[0].text, 'hello world');
        assert.equal(body.stop_reason, 'end_turn');
      },
    },
    {
      path: '/v1/responses',
      streamBody: { model: 'alpha-model', instructions: 'be concise', input: 'hello', stream: true },
      plainBody: { model: 'alpha-model', instructions: 'be concise', input: 'hello', stream: false },
      checkRequest(body) {
        assert.deepEqual(body.params.system, [{ type: 'text', text: 'be concise' }]);
        assert.deepEqual(body.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
      },
      checkStream(text) {
        assert.match(text, /event: response\.created/);
        assert.match(text, /event: response\.output_text\.delta/);
        assert.match(text, /"delta":"hello "/);
        assert.match(text, /"delta":"world"/);
        assert.match(text, /event: response\.completed/);
      },
      checkPlain(body) {
        assert.equal(body.object, 'response');
        assert.equal(body.status, 'completed');
        assert.equal(body.output_text, 'hello world');
        assert.equal(body.output[0].type, 'message');
      },
    },
  ];

  for (const protocol of protocols) {
    const beforeStream = state.generateRequests.length;
    const streamed = await inferenceCall(protocol.path, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}` },
      body: protocol.streamBody,
    });
    assert.equal(streamed.status, 200, protocol.path);
    assert.match(streamed.response.headers.get('content-type'), /text\/event-stream/);
    protocol.checkStream(streamed.text);
    assert.equal(state.generateRequests.length, beforeStream + 1);
    assert.equal(state.generateRequests.at(-1).body.params.model, 'alpha-model');
    protocol.checkRequest(state.generateRequests.at(-1).body);

    const beforePlain = state.generateRequests.length;
    const plain = await inferenceCall(protocol.path, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}` },
      body: protocol.plainBody,
    });
    assert.equal(plain.status, 200, protocol.path);
    protocol.checkPlain(plain.body);
    assert.equal(state.generateRequests.length, beforePlain + 1);
    assert.equal(state.generateRequests.at(-1).body.params.model, 'alpha-model');
  }
  assert.ok(state.initRequests.some(item => item.path === '/alpha/fingerprint/record'));
  assert.ok(state.initRequests.some(item => item.path === '/alpha/lifecycle-events'));
  assert.equal(state.initRequests.filter(item => item.authorization === `Bearer ${GOOD_CREDENTIAL}`).length, 2);
});

test('inference and management routes stay isolated; 401 is isolated and 429 is not replayed', async () => {
  const managementOnInference = await call(managementBase, '/v1/chat/completions');
  assert.equal(managementOnInference.status, 404);
  const inferenceOnManagement = await call(inferenceBase, '/command/api/overview');
  assert.equal(inferenceOnManagement.status, 404);

  const oldKey = await inferenceCall('/v1/models', { headers: { authorization: `Bearer ${oldClientKey}` } });
  assert.equal(oldKey.status, 401);
  assert.equal(oldKey.body.error.type, 'authentication_error');

  state.catalogByCredential.set(ERROR_CREDENTIAL, { status: 200, ids: ['error-model'] });
  const errorAccount = await managementCall('/command/api/upstreams', {
    method: 'POST',
    body: { name: 'Error provider', notes: '', enabled: true, credential: ERROR_CREDENTIAL, priority: 0, load_factor: 1, max_concurrency: 2, whitelist: ['error-model'] },
  });
  assert.equal(errorAccount.status, 201);
  const errorId = errorAccount.body.id;
  const errorRefresh = await managementCall(`/command/api/upstreams/${errorId}/models/refresh`, { method: 'POST', body: {} });
  assert.equal(errorRefresh.status, 200);
  state.generateByModel.set('error-model', {
    status: 401,
    body: `<401> invalid credential ${ERROR_CREDENTIAL}`,
  });
  const before401 = state.generateRequests.length;
  const upstream401 = await inferenceCall('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${clientKey}` },
    body: { model: 'error-model', messages: [{ role: 'user', content: 'should fail' }], stream: false },
  });
  assert.equal(upstream401.status, 401);
  assert.equal(upstream401.body.error.type, 'authentication_error');
  assert.doesNotMatch(upstream401.text, new RegExp(ERROR_CREDENTIAL));
  assert.equal(state.generateRequests.length, before401 + 1);
  const goodAfter401 = await managementCall(`/command/api/upstreams/${goodId}`);
  assert.equal(goodAfter401.body.health, 'healthy');

  state.catalogByCredential.set(RATE_CREDENTIAL, { status: 200, ids: ['rate-model'] });
  const rateAccount = await managementCall('/command/api/upstreams', {
    method: 'POST',
    body: { name: 'Rate provider', notes: '', enabled: true, credential: RATE_CREDENTIAL, priority: 0, load_factor: 1, max_concurrency: 2, whitelist: ['rate-model'] },
  });
  assert.equal(rateAccount.status, 201);
  const rateId = rateAccount.body.id;
  assert.equal((await managementCall(`/command/api/upstreams/${rateId}/models/refresh`, { method: 'POST', body: {} })).status, 200);
  state.generateByModel.set('rate-model', {
    status: 429,
    headers: { 'retry-after': '7' },
    body: { error: `rate limited ${RATE_CREDENTIAL}` },
  });
  const before429 = state.generateRequests.length;
  const upstream429 = await inferenceCall('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${clientKey}` },
    body: { model: 'rate-model', messages: [{ role: 'user', content: 'one attempt only' }], stream: false },
  });
  assert.equal(upstream429.status, 429);
  assert.equal(upstream429.body.error.type, 'rate_limit_error');
  assert.equal(upstream429.response.headers.get('retry-after'), '30');
  assert.doesNotMatch(upstream429.text, new RegExp(RATE_CREDENTIAL));
  assert.equal(state.generateRequests.length, before429 + 1);
  const rateDetail = await managementCall(`/command/api/upstreams/${rateId}`);
  assert.equal(rateDetail.body.health, 'degraded');
  assert.equal(rateDetail.body.cooldown_until > Date.now(), true);

  const beforeForbidden = state.generateRequests.length;
  const forbidden = await inferenceCall('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${clientKey}` },
    body: { model: 'not-allowed-anywhere', messages: [{ role: 'user', content: 'no upstream request' }], stream: false },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'model_not_allowed');
  assert.equal(state.generateRequests.length, beforeForbidden);
});

test('event statusCode is preserved instead of collapsing to 502', async () => {
  state.generateByModel.set('alpha-model', {
    status: 200,
    events: [
      { type: 'text-start' },
      { type: 'error', error: { message: 'provider at capacity', statusCode: 429 } },
    ],
  });
  const result = await inferenceCall('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${clientKey}` },
    body: { model: 'alpha-model', messages: [{ role: 'user', content: 'trigger event error' }], stream: false },
  });
  assert.equal(result.status, 429);
  assert.equal(result.body.error.type, 'rate_limit_error');
  assert.equal(result.response.headers.get('retry-after'), '30');
});

test('one account routes model refresh, initialization and inference through its proxy', async t => {
  const sockets = new Set(); let connects = 0;
  const proxy = createServer();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, client) => {
    connects++;
    const target = new URL(`http://${req.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await close(proxy); });
  const credential = 'user_proxyroute123456';
  state.catalogByCredential.set(credential, { status: 200, ids: ['proxy-only-model'] });
  const created = await managementCall('/command/api/upstreams', { method: 'POST', body: {
    name: 'Routed account', credential, whitelist: ['proxy-only-model'], proxy_url: `http://agent:pass@127.0.0.1:${port}`,
  } });
  assert.equal(created.status, 201);
  const refreshed = await managementCall(`/command/api/upstreams/${created.body.id}/models/refresh`, { method: 'POST', body: {} });
  assert.equal(refreshed.status, 200);
  const generated = await inferenceCall('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${clientKey}` },
    body: { model: 'proxy-only-model', messages: [{ role: 'user', content: 'via account proxy' }], stream: false } });
  assert.equal(generated.status, 200);
  assert.ok(connects >= 4, `expected model, two initialization and generation tunnels; received ${connects}`);
});

test('manual account test reports the upstream event statusCode', async () => {
  const model = 'region-restricted-model';
  state.generateByModel.set(model, { status: 200, events: [
    { type: 'start' },
    { type: 'error', error: { message: 'Country, region, or territory not supported', statusCode: 403 } },
  ] });
  const created = await managementCall('/command/api/upstreams', { method: 'POST', body: {
    name: 'Restricted model account', credential: 'user_restricted123', enabled: false, whitelist: [model],
  } });
  assert.equal(created.status, 201);
  const result = await managementCall(`/command/api/upstreams/${created.body.id}/test`, { method: 'POST', body: { model, prompt: 'Reply OK.' } });
  assert.equal(result.status, 200);
  const events = sseEvents(result.text);
  assert.equal(events.at(-1).event, 'done');
  assert.equal(events.at(-1).data.success, false);
  assert.match(events.at(-1).data.error, /HTTP 403/);
  assert.doesNotMatch(events.at(-1).data.error, /HTTP 502/);
});

test('account proxy check reports its tunnel exit IP and clears stale results on change', async t => {
  const sockets = new Set();
  const proxy = createServer();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, socket) => {
    assert.equal(req.url, 'ip-api.com:80');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      const body = JSON.stringify({ status: 'success', query: '203.0.113.7', countryCode: 'US', country: 'United States', regionName: 'Texas', city: 'Dallas' });
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await close(proxy); });
  const created = await managementCall('/command/api/upstreams', { method: 'POST', body: {
    name: 'Probe account', credential: 'user_probeaccount123', enabled: false, proxy_url: `http://agent:secret@127.0.0.1:${port}`,
  } });
  assert.equal(created.status, 201);
  const checked = await managementCall(`/command/api/upstreams/${created.body.id}/proxy/check`, { method: 'POST', body: {} });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.proxy_probe.success, true);
  assert.equal(checked.body.proxy_probe.exit_ip, '203.0.113.7');
  assert.equal(checked.body.proxy_probe.country_code, 'US');
  assert.equal(checked.body.proxy_probe.region, 'Texas');
  assert.doesNotMatch(checked.text, /secret/);
  const cleared = await managementCall(`/command/api/upstreams/${created.body.id}`, { method: 'PATCH', body: { proxy_url: null } });
  assert.equal(cleared.body.proxy_probe, null);
  const missing = await managementCall(`/command/api/upstreams/${created.body.id}/proxy/check`, { method: 'POST', body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'proxy_not_configured');
});
