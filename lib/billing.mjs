import { fail } from './auth.mjs';
import { upstreamFetch } from '../protocols.mjs';

const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = value => {
  const n = numeric(value);
  const time = n !== null ? (n < 1e11 ? n * 1000 : n) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time <= 8640000000000000 ? time : null;
};
const windowUsage = value => {
  const used = numeric(value?.used); const limit = numeric(value?.cap);
  return used !== null && used >= 0 && limit !== null && limit > 0
    ? { used, limit, remaining: Math.max(0, limit - used), resets_at: timestamp(value.resetAt) } : null;
};
// Monthly grants from the official command-code CLI 1.54.2 plan catalog.
// Keep legacy Pro ($30) distinct from Pro v1 ($80); never infer a plan from spend.
const monthlyGrants = { 'individual-go': 10, 'individual-goat': 70, 'individual-pro': 30, 'individual-pro-v1': 80, 'individual-provider': 15, 'individual-max': 150, 'individual-ultra': 300, 'teams-pro': 40 };
export function monthlyWindow(subscription, remaining) {
  if (subscription?.success !== true || subscription.data?.status !== 'active' || typeof subscription.data.planId !== 'string' || !Number.isFinite(remaining) || remaining < 0) return null;
  const plan = subscription.data.planId.toLowerCase().replaceAll('_', '-');
  const id = Object.keys(monthlyGrants).sort((a, b) => b.length - a.length).find(id => plan === id || plan.startsWith(`${id}-`));
  if (!id) return null;
  const limit = monthlyGrants[id];
  // A balance above the known grant may signal changed plan terms. Don't show a false cap.
  if (remaining > limit) return null;
  return { used: Math.max(0, limit - remaining), limit, remaining, resets_at: timestamp(subscription.data.currentPeriodEnd) };
}
export function parseCredits(body) {
  const credits = body?.credits;
  if (body?.success === false || !credits || numeric(credits.monthlyCredits) === null) throw new Error('invalid_billing');
  const windows = body.windowLimits ?? credits.windowLimits;
  return {
    monthly_remaining: numeric(credits.monthlyCredits), purchased_remaining: numeric(credits.purchasedCredits),
    free_remaining: numeric(credits.freeCredits),
    premium_remaining: numeric(credits.premiumMonthlyCredits), opensource_remaining: numeric(credits.opensourceMonthlyCredits),
    five_hour: windowUsage(windows?.fiveHour), weekly: windowUsage(windows?.weekly),
  };
}
export class BillingService {
  constructor(repo, apiBase) { this.repo = repo; this.apiBase = apiBase; this.pending = new Map(); }
  async request(path, credential, proxy) {
    const response = await upstreamFetch(`${this.apiBase}${path}`, {
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json', 'x-cli-environment': 'production' },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    }, proxy);
    if (!response.ok) {
      await response.body?.cancel();
      fail(502, response.status === 401 || response.status === 403 ? 'billing_credential_invalid' : 'billing_unavailable',
        response.status === 401 || response.status === 403 ? '上游凭据无效或无账单权限，请在编辑账号中更新凭据' : `官方账单暂不可用（HTTP ${response.status}）`);
    }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) throw new Error('billing_too_large'); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async refresh(id) {
    if (this.pending.has(id)) return this.pending.get(id);
    const task = this.read(id); this.pending.set(id, task);
    try { return await task; } finally { this.pending.delete(id); }
  }
  async read(id) {
    const current = this.repo.get('upstreams', id);
    if (!current) fail(404, 'not_found', '账号不存在');
    const credential = this.repo.credential(id);
    const proxy = this.repo.proxy(id);
    this.repo.discardBillingSession(id);
    if (current.billing_source === 'upstream' && current.billing_checked_at && Date.now() - current.billing_checked_at < 60000) {
      if (current.billing_error) fail(429, 'billing_retry_later', '刚刚刷新失败，请一分钟后重试');
      return current;
    }
    const sameAccount = () => this.repo.get('upstreams', id) && this.repo.credential(id) === credential && this.repo.proxy(id) === proxy;
    try {
      // Match the official CLI's organization scope before querying any billing data.
      const who = await this.request('/alpha/whoami?limits=1', credential, proxy);
      if (who?.success !== true || !who.user || (who.org != null && (typeof who.org.id !== 'string' || !who.org.id || who.org.id.length > 200))) throw new Error('invalid_identity');
      const params = new URLSearchParams();
      if (who.org?.id) params.set('orgId', who.org.id);
      const endpoint = path => `/alpha/${path}${params.size ? `?${params}` : ''}`;
      const billing = parseCredits(await this.request(endpoint('billing/credits'), credential, proxy));
      billing.period_start = null; billing.period_end = null; billing.spent = null; billing.period_basis = null;
      billing.summary_error = null;
      billing.monthly = null;
      try {
        const subscription = await this.request(endpoint('billing/subscriptions'), credential, proxy);
        if (subscription.success === true) {
          billing.period_start = timestamp(subscription.data?.currentPeriodStart);
          billing.period_end = timestamp(subscription.data?.currentPeriodEnd);
          billing.monthly = monthlyWindow(subscription, billing.monthly_remaining);
        }
      } catch { /* Credits remain useful when subscription enrichment is unavailable. */ }
      try {
        if (billing.period_start) params.set('since', new Date(billing.period_start).toISOString());
        const summary = await this.request(endpoint('usage/summary'), credential, proxy);
        const cost = numeric(summary?.totalCost);
        if (summary?.success === false || cost === null || cost < 0) throw new Error('invalid_summary');
        billing.spent = cost;
        billing.period_basis = summary.periodBasis === 'billing-period' ? 'billing-period' : 'reported';
      } catch { billing.summary_error = '已用金额暂不可用，余额已更新'; }
      if (!sameAccount()) fail(409, 'account_changed', '账号凭据已改变，请重新刷新');
      return this.repo.save('upstreams', { ...this.repo.get('upstreams', id), billing_source: 'upstream', billing_authorized: false, billing: { ...billing, updated_at: Date.now() }, billing_error: null, billing_checked_at: Date.now() });
    } catch (error) {
      if (!sameAccount()) fail(409, 'account_changed', '账号凭据已改变，请重新刷新');
      const message = error.code === 'billing_credential_invalid' || error.code === 'billing_unavailable' ? error.message : '官方账单网络异常或响应格式无效';
      const latest = this.repo.get('upstreams', id);
      this.repo.save('upstreams', { ...latest, billing_source: 'upstream', billing_authorized: false, billing: latest.billing_source === 'upstream' ? latest.billing : null, billing_error: message, billing_checked_at: Date.now() });
      fail(502, error.code === 'billing_credential_invalid' ? error.code : 'billing_unavailable', message);
    }
  }
}
