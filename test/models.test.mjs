import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockUpstream, startProxy } from './helpers.mjs';

const MODELS = [
  { id: 'google/gemini-3.8-flash' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  { id: 'unknown-model' },
];
const MOCK = join(dirname(fileURLToPath(import.meta.url)), 'pricing-fetch-mock.cjs');

async function startModelProxy({ pricingStatus = 200, pricingFailFirst = 0, refreshMs = 60000 } = {}) {
  const calls = [];
  // 订阅接口状态码，测试中途可改
  const state = { subscriptionStatus: 200 };
  const upstream = await startMockUpstream({
    onRequest: async (req, res) => {
      calls.push(req.url);
      if (req.url === '/provider/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: MODELS }));
      } else if (req.url === '/alpha/billing/subscriptions') {
        if (state.subscriptionStatus !== 200) {
          res.writeHead(state.subscriptionStatus, { 'Content-Type': 'application/json' });
          res.end('{"success":false}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { planId: 'individual-go' } }));
      }
    },
  });
  const cwd = mkdtempSync(join(tmpdir(), 'ccp-models-'));
  const counter = join(cwd, 'pricing-calls.log');
  const statusFile = join(cwd, 'pricing-status');
  writeFileSync(statusFile, String(pricingStatus));
  writeFileSync(join(cwd, 'config.json'), JSON.stringify({
    useProviderModelsWithPlanFilter: true,
    modelRefreshIntervalMs: refreshMs,
  }));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: {
      CC_USE_PROVIDER_MODELS: 'true',
      CC_TEST_PRICING_STATUS_FILE: statusFile,
      CC_TEST_PRICING_FAIL_FIRST: String(pricingFailFirst),
      CC_TEST_PRICING_COUNTER_FILE: counter,
    },
    execArgv: ['--require', MOCK],
    cwd,
  });
  return {
    proxy,
    calls,
    state,
    setPricingStatus: status => writeFileSync(statusFile, String(status)),
    pricingCalls: () => existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0,
    resetPricingCalls: () => writeFileSync(counter, ''),
    async close() {
      await proxy.kill();
      await upstream.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

async function modelIds(proxy, key = 'user_test') {
  const response = await proxy.get('/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()).data.map(model => model.id);
}

test('v1/models filters denied rows and keeps models missing from pricing', async () => {
  const s = await startModelProxy();
  try {
    assert.deepEqual(await modelIds(s.proxy), ['unknown-model']);
  } finally { await s.close(); }
});

test('v1/models fails open when pricing is unavailable', async () => {
  const s = await startModelProxy({ pricingStatus: 503 });
  try {
    assert.deepEqual(await modelIds(s.proxy), MODELS.map(model => model.id));
  } finally { await s.close(); }
});

test('concurrent keys share one pricing refresh but fetch subscriptions separately', async () => {
  const s = await startModelProxy();
  try {
    await Promise.all([modelIds(s.proxy, 'user_one'), modelIds(s.proxy, 'user_two')]);
    assert.equal(s.calls.filter(url => url === '/alpha/billing/subscriptions').length, 2);
    assert.equal(s.pricingCalls(), 1);
  } finally { await s.close(); }
});

test('concurrent requests for one key share the subscription refresh', async () => {
  const s = await startModelProxy();
  try {
    await Promise.all([modelIds(s.proxy), modelIds(s.proxy)]);
    assert.equal(s.calls.filter(url => url === '/alpha/billing/subscriptions').length, 1);
    assert.equal(s.pricingCalls(), 1);
  } finally { await s.close(); }
});

test('same key reuses subscription and pricing data within the TTL', async () => {
  const s = await startModelProxy();
  try {
    await modelIds(s.proxy);
    s.calls.length = 0;
    s.resetPricingCalls();
    await Promise.all([modelIds(s.proxy), modelIds(s.proxy)]);
    assert.equal(s.calls.filter(url => url === '/alpha/billing/subscriptions').length, 0);
    assert.equal(s.pricingCalls(), 0);
  } finally { await s.close(); }
});

const subscriptionCalls = s => s.calls.filter(url => url === '/alpha/billing/subscriptions').length;

test('pricing refresh retries transient failures before falling back', async () => {
  const s = await startModelProxy({ pricingFailFirst: 2 });
  try {
    assert.deepEqual(await modelIds(s.proxy), ['unknown-model']);
    assert.equal(s.pricingCalls(), 3);
  } finally { await s.close(); }
});

test('failed pricing refresh is not cached', async () => {
  const s = await startModelProxy({ pricingStatus: 503 });
  try {
    assert.deepEqual(await modelIds(s.proxy), MODELS.map(model => model.id));
    s.setPricingStatus(200);
    assert.deepEqual(await modelIds(s.proxy), ['unknown-model']);
  } finally { await s.close(); }
});

test('failed subscription refresh is not cached', async () => {
  const s = await startModelProxy();
  try {
    s.state.subscriptionStatus = 503;
    assert.deepEqual(await modelIds(s.proxy), MODELS.map(model => model.id));
    assert.equal(subscriptionCalls(s), 3, '5xx 应重试');
    s.state.subscriptionStatus = 200;
    assert.deepEqual(await modelIds(s.proxy), ['unknown-model']);
  } finally { await s.close(); }
});

test('subscription 4xx is not retried', async () => {
  const s = await startModelProxy();
  try {
    s.state.subscriptionStatus = 401;
    assert.deepEqual(await modelIds(s.proxy), MODELS.map(model => model.id));
    assert.equal(subscriptionCalls(s), 1);
  } finally { await s.close(); }
});

test('expired cache is used when refresh keeps failing', async () => {
  const s = await startModelProxy({ refreshMs: 1000 });
  try {
    assert.deepEqual(await modelIds(s.proxy), ['unknown-model']);
    await new Promise(r => setTimeout(r, 1200));
    s.state.subscriptionStatus = 503;
    s.setPricingStatus(503);
    s.calls.length = 0;
    s.resetPricingCalls();
    assert.deepEqual(await modelIds(s.proxy), ['unknown-model'], '应降级到过期的旧结果而非全量');
    assert.equal(subscriptionCalls(s), 3, '过期后应尝试刷新');
    assert.equal(s.pricingCalls(), 3);
  } finally { await s.close(); }
});
