import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockUpstream, startProxy } from './helpers.mjs';

const MODELS = [
  { id: 'google/gemini-3.8-flash' },
  { id: 'unknown-model' },
];
const MOCK = join(dirname(fileURLToPath(import.meta.url)), 'pricing-fetch-mock.cjs');

async function startModelProxy({ pricingStatus = 200 } = {}) {
  const calls = [];
  const upstream = await startMockUpstream({
    onRequest: async (req, res) => {
      calls.push(req.url);
      if (req.url === '/provider/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: MODELS }));
      } else if (req.url === '/alpha/billing/subscriptions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { planId: 'individual-go' } }));
      }
    },
  });
  const cwd = mkdtempSync(join(tmpdir(), 'ccp-models-'));
  const counter = join(cwd, 'pricing-calls.log');
  writeFileSync(join(cwd, 'config.json'), JSON.stringify({
    useProviderModelsWithPlanFilter: true,
    modelRefreshIntervalMs: 60000,
  }));
  const proxy = await startProxy({
    upstreamPort: upstream.port,
    env: {
      CC_USE_PROVIDER_MODELS: 'true',
      CC_TEST_PRICING_STATUS: String(pricingStatus),
      CC_TEST_PRICING_COUNTER_FILE: counter,
      NODE_OPTIONS: `--require=${MOCK}`,
    },
    cwd,
  });
  return {
    proxy,
    calls,
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
