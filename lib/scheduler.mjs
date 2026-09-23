import { fail } from './auth.mjs';

export function matches(model, rules) {
  return !rules.length || rules.some(rule => rule.endsWith('*') ? model.startsWith(rule.slice(0, -1)) : model === rule);
}
export function supports(account, model) {
  return matches(model, account.whitelist) && (account.models.some(m => m.id === model) || account.whitelist.some(rule => rule === model));
}
export class Scheduler {
  constructor(repo, clock = Date.now) { this.repo = repo; this.clock = clock; this.inflight = new Map(); this.weights = new Map(); }
  state(account) {
    if (!account.enabled) return 'disabled';
    if (account.health === 'credential_error') return 'credential_error';
    if (account.cooldown_until > this.clock()) return 'cooling';
    if ((this.inflight.get(account.id) || 0) >= account.max_concurrency) return 'saturated';
    return account.health === 'unknown' ? 'untested' : 'ready';
  }
  view(account) { return { ...account, inflight: this.inflight.get(account.id) || 0, scheduling: this.state(account) }; }
  available(account) { return account.enabled && account.health !== 'credential_error' && account.cooldown_until <= this.clock(); }
  allowedModels(client) {
    const ids = new Set();
    for (const account of this.repo.list('upstreams')) {
      if (!this.available(account) || account.health !== 'healthy') continue;
      for (const model of [...account.models.map(m => m.id), ...account.whitelist.filter(m => !m.endsWith('*'))]) {
        if (supports(account, model) && matches(model, client.whitelist)) ids.add(model);
      }
    }
    return [...ids].sort();
  }
  acquire(model, client) {
    const supported = this.repo.list('upstreams').filter(a => supports(a, model));
    if (!matches(model, client.whitelist) || !supported.length) fail(403, 'model_not_allowed', '模型不在客户端与上游的有效白名单交集中');
    let candidates = supported.filter(a => this.available(a) && (this.inflight.get(a.id) || 0) < a.max_concurrency);
    if (!candidates.length) fail(503, 'no_available_upstream', '没有可用上游，请稍后重试', 5);
    const priority = Math.min(...candidates.map(a => a.priority));
    candidates = candidates.filter(a => a.priority === priority);
    const load = Math.min(...candidates.map(a => (this.inflight.get(a.id) || 0) / a.load_factor));
    candidates = candidates.filter(a => Math.abs((this.inflight.get(a.id) || 0) / a.load_factor - load) < 1e-10);
    let selected; let total = 0;
    for (const a of candidates) {
      const weight = (this.weights.get(a.id) || 0) + a.load_factor;
      this.weights.set(a.id, weight); total += a.load_factor;
      if (!selected || weight > this.weights.get(selected.id)) selected = a;
    }
    this.weights.set(selected.id, this.weights.get(selected.id) - total);
    return this.reserve(selected);
  }
  reserve(account) {
    this.inflight.set(account.id, (this.inflight.get(account.id) || 0) + 1);
    let released = false;
    return { account, release: () => {
      if (released) return;
      released = true;
      const n = (this.inflight.get(account.id) || 1) - 1;
      if (n) this.inflight.set(account.id, n); else this.inflight.delete(account.id);
    } };
  }
  result(id, { status = 200, retryAfter, latency = null, manual = false, count = true, cancelled = false } = {}) {
    const account = this.repo.get('upstreams', id);
    if (!account) return;
    const now = this.clock();
    const success = status >= 200 && status < 300 && !cancelled;
    if (count) { account.requests++; account[success ? 'successes' : 'errors']++; }
    if (manual) { account.last_test_at = now; account.latency_ms = latency; }
    if (cancelled) { this.repo.save('upstreams', account); return; }
    if (success) {
      // Ordinary in-flight successes must not undo a quarantine set by a concurrent failure.
      if (manual || account.health !== 'credential_error') account.health = 'healthy';
      account.failures = []; account.circuit_level = 0;
      if (manual) account.cooldown_until = 0;
      if (account.health !== 'credential_error') account.last_error = null;
    } else {
      account.last_error = status === 0 ? '网络连接失败或响应中断' : `上游请求失败（HTTP ${status}）`;
      if (status === 401 || status === 403) account.health = 'credential_error';
      else if (status === 429) {
        const numeric = retryAfter == null ? NaN : Number(retryAfter);
        const delay = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(retryAfter) - now;
        account.cooldown_until = Math.max(account.cooldown_until, now + (Number.isFinite(delay) ? Math.max(0, delay) : 30000));
        if (account.health !== 'credential_error') account.health = 'degraded';
      } else if (status === 0 || status >= 500) {
        account.failures = account.failures.filter(t => now - t <= 60000);
        account.failures.push(now);
        if (account.health !== 'credential_error') account.health = 'degraded';
        if (account.failures.length >= 3) {
          account.cooldown_until = now + Math.min(300000, 30000 * 2 ** account.circuit_level);
          account.circuit_level = Math.min(4, account.circuit_level + 1);
          account.failures = [];
        }
      }
    }
    this.repo.save('upstreams', account);
  }
}
