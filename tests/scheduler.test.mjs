import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../lib/repository.mjs';
import { Scheduler } from '../lib/scheduler.mjs';

const MASTER_KEY = Buffer.alloc(32, 7);
const BASE_TIME = 1_700_000_000_000;

function fixture(t, initialNow = BASE_TIME) {
  const repo = new Repository(':memory:', MASTER_KEY);
  let now = initialNow;
  const scheduler = new Scheduler(repo, () => now);
  t.after(() => repo.close());

  const add = ({
    name,
    priority = 0,
    load_factor = 1,
    max_concurrency = 2,
    whitelist = [],
    models = ['model-a'],
    enabled = true,
    health = 'healthy',
    cooldown_until = 0,
  }) => {
    const data = repo.createUpstream({
      name,
      notes: '',
      enabled,
      priority,
      load_factor,
      max_concurrency,
      whitelist,
    }, 'user_testcredential');
    data.health = health;
    data.cooldown_until = cooldown_until;
    data.models = models.map(id => ({ id }));
    repo.save('upstreams', data);
    return data.id;
  };

  return {
    repo,
    scheduler,
    add,
    now: () => now,
    setNow: value => { now = value; },
    advance: milliseconds => { now += milliseconds; },
  };
}

function client(whitelist = []) {
  return { whitelist };
}

function assertHttpError(action, status, code) {
  assert.throws(action, error => error?.status === status && error?.code === code);
}

test('acquire chooses the minimum priority and falls back when that tier is saturated', t => {
  const f = fixture(t);
  const preferred = f.add({ name: 'preferred', priority: 1, max_concurrency: 1 });
  const fallback = f.add({ name: 'fallback', priority: 2, max_concurrency: 1 });

  const first = f.scheduler.acquire('model-a', client());
  assert.equal(first.account.id, preferred);
  assert.equal(first.account.priority, 1);

  const second = f.scheduler.acquire('model-a', client());
  assert.equal(second.account.id, fallback);
  assert.equal(second.account.priority, 2);

  assertHttpError(() => f.scheduler.acquire('model-a', client()), 503, 'no_available_upstream');
  assert.equal(f.scheduler.view(f.repo.get('upstreams', preferred)).scheduling, 'saturated');
  assert.equal(f.scheduler.view(f.repo.get('upstreams', fallback)).scheduling, 'saturated');

  first.release();
  second.release();
});

test('same-priority candidates use the lowest inflight/load_factor ratio', t => {
  const f = fixture(t);
  const busyLowCapacity = f.add({ name: 'busy-low-capacity', load_factor: 1, max_concurrency: 3 });
  const lessBusyHighCapacity = f.add({ name: 'less-busy-high-capacity', load_factor: 2, max_concurrency: 3 });

  const held = f.scheduler.acquire('model-a', client());
  assert.equal(held.account.id, lessBusyHighCapacity);
  const next = f.scheduler.acquire('model-a', client());
  assert.equal(next.account.id, busyLowCapacity);

  held.release();
  next.release();
});

test('smooth weighted scheduling converges to long-term load_factor proportions', t => {
  const f = fixture(t);
  const one = f.add({ name: 'one', load_factor: 1, max_concurrency: 1000 });
  const two = f.add({ name: 'two', load_factor: 2, max_concurrency: 1000 });
  const counts = new Map([[one, 0], [two, 0]]);

  for (let index = 0; index < 120; index++) {
    const lease = f.scheduler.acquire('model-a', client());
    counts.set(lease.account.id, counts.get(lease.account.id) + 1);
    lease.release();
    if ((index + 1) % 30 === 0) assert.equal(counts.get(two), counts.get(one) * 2);
  }

  assert.deepEqual([...counts.values()], [40, 80]);
});

test('leases release at most once and leave the account reusable', t => {
  const f = fixture(t);
  const id = f.add({ name: 'lease', max_concurrency: 1 });
  const lease = f.scheduler.acquire('model-a', client());

  assert.equal(f.scheduler.view(f.repo.get('upstreams', id)).inflight, 1);
  lease.release();
  lease.release();
  assert.equal(f.scheduler.view(f.repo.get('upstreams', id)).inflight, 0);

  const replacement = f.scheduler.acquire('model-a', client());
  assert.equal(replacement.account.id, id);
  replacement.release();
});

test('exact and prefix whitelist rules require an intersection', t => {
  const f = fixture(t);
  const prefixAccount = f.add({
    name: 'prefix-account',
    whitelist: ['gpt-4*'],
    models: ['gpt-4o', 'gpt-3.5'],
  });
  const exactAccount = f.add({
    name: 'exact-account',
    whitelist: ['claude-3'],
    models: ['claude-3'],
  });

  const exactClientLease = f.scheduler.acquire('gpt-4o', client(['gpt-4o']));
  assert.equal(exactClientLease.account.id, prefixAccount);
  exactClientLease.release();

  const prefixClientLease = f.scheduler.acquire('claude-3', client(['claude-*']));
  assert.equal(prefixClientLease.account.id, exactAccount);
  prefixClientLease.release();

  assertHttpError(() => f.scheduler.acquire('gpt-3.5', client(['gpt-4o'])), 403, 'model_not_allowed');
  assertHttpError(() => f.scheduler.acquire('claude-4', client(['claude-*'])), 403, 'model_not_allowed');
});

test('allowed model catalog contains only healthy, enabled, available catalog entries', t => {
  const f = fixture(t);
  f.add({ name: 'visible', models: ['gpt-4o', 'gpt-4o-mini'] });
  f.add({ name: 'wrong-client-rule', models: ['claude-3'] });
  f.add({ name: 'disabled', models: ['gpt-disabled'], enabled: false });
  f.add({ name: 'unknown', models: ['gpt-unknown'], health: 'unknown' });
  f.add({ name: 'cooling', models: ['gpt-cooling'], cooldown_until: f.now() + 10_000 });
  f.add({ name: 'credential-error', models: ['gpt-secret'], health: 'credential_error' });

  assert.deepEqual(f.scheduler.allowedModels(client(['gpt-*'])), ['gpt-4o', 'gpt-4o-mini']);
});

for (const status of [401, 403]) {
  test(`${status} quarantines an upstream until a manual test succeeds`, t => {
    const f = fixture(t);
    const id = f.add({ name: `credential-${status}` });

    f.scheduler.result(id, { status });
    let account = f.repo.get('upstreams', id);
    assert.equal(account.health, 'credential_error');
    assert.equal(f.scheduler.state(account), 'credential_error');
    assertHttpError(() => f.scheduler.acquire('model-a', client()), 503, 'no_available_upstream');

    f.scheduler.result(id, { status: 200, manual: true, latency: 17 });
    account = f.repo.get('upstreams', id);
    assert.equal(account.health, 'healthy');
    assert.equal(account.last_test_at, f.now());
    assert.equal(account.latency_ms, 17);
    assert.equal(account.last_error, null);
    const lease = f.scheduler.acquire('model-a', client());
    assert.equal(lease.account.id, id);
    lease.release();
  });
}

for (const [label, retryAfter, expectedDelay] of [
  ['numeric', '7', 7_000],
  ['date', new Date(BASE_TIME + 12_000).toUTCString(), 12_000],
  ['missing', undefined, 30_000],
]) {
  test(`429 Retry-After ${label} sets the consumer-visible cooldown`, t => {
    const f = fixture(t);
    const id = f.add({ name: `retry-${label}` });

    f.scheduler.result(id, { status: 429, retryAfter });
    const account = f.repo.get('upstreams', id);
    assert.equal(account.health, 'degraded');
    assert.equal(account.cooldown_until, BASE_TIME + expectedDelay);
    assert.equal(f.scheduler.state(account), 'cooling');
  });
}

test('three network or 5xx failures trip an exponentially backed-off circuit with a cap', t => {
  const f = fixture(t);
  const id = f.add({ name: 'circuit' });
  const delays = [30_000, 60_000, 120_000, 240_000, 300_000];
  const failureSets = [
    [0, 500, 503],
    [500, 502, 500],
    [503, 500, 0],
    [500, 503, 502],
    [0, 500, 503],
  ];

  for (let level = 0; level < delays.length; level++) {
    const before = f.now();
    for (const status of failureSets[level]) f.scheduler.result(id, { status });
    const account = f.repo.get('upstreams', id);
    assert.equal(account.health, 'degraded');
    assert.equal(account.cooldown_until, before + delays[level]);
    assert.equal(account.circuit_level, Math.min(level + 1, 4));
    assert.deepEqual(account.failures, []);
    f.setNow(account.cooldown_until);
  }
});

test('failure timestamps outside the 60-second window do not trip the circuit', t => {
  const f = fixture(t);
  const id = f.add({ name: 'rolling-window' });

  f.scheduler.result(id, { status: 500 });
  f.advance(60_001);
  f.scheduler.result(id, { status: 503 });
  const account = f.repo.get('upstreams', id);
  assert.equal(account.circuit_level, 0);
  assert.equal(account.cooldown_until, 0);
  assert.equal(account.failures.length, 1);
  assert.equal(account.health, 'degraded');
});

test('a successful result clears transient failures and error state', t => {
  const f = fixture(t);
  const id = f.add({ name: 'recovery' });

  f.scheduler.result(id, { status: 500 });
  f.scheduler.result(id, { status: 502 });
  assert.equal(f.repo.get('upstreams', id).failures.length, 2);

  f.scheduler.result(id, { status: 200 });
  const account = f.repo.get('upstreams', id);
  assert.equal(account.health, 'healthy');
  assert.deepEqual(account.failures, []);
  assert.equal(account.circuit_level, 0);
  assert.equal(account.last_error, null);
  assert.equal(account.requests, 3);
  assert.equal(account.successes, 1);
  assert.equal(account.errors, 2);
});

test('an ordinary concurrent success cannot clear credential-error isolation', t => {
  const f = fixture(t);
  const id = f.add({ name: 'concurrent-credential-error' });

  f.scheduler.result(id, { status: 401 });
  const quarantined = f.repo.get('upstreams', id);
  assert.equal(quarantined.health, 'credential_error');
  const originalError = quarantined.last_error;

  f.scheduler.result(id, { status: 200, manual: false });
  const account = f.repo.get('upstreams', id);
  assert.equal(account.health, 'credential_error');
  assert.equal(account.last_error, originalError);
  assertHttpError(() => f.scheduler.acquire('model-a', client()), 503, 'no_available_upstream');
});
