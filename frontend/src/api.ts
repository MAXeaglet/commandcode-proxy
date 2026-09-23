export interface Session { email?: string; csrf: string; expires_at?: number }
export interface Model { id: string }
export interface UsageWindow { used: number; limit: number; remaining: number; resets_at: number | null }
export interface Billing {
  monthly?: UsageWindow | null;
  free_remaining: number | null; spent: number | null; period_basis: 'billing-period' | 'reported' | null; period_start: number | null; summary_error: string | null;
  monthly_remaining: number; purchased_remaining: number | null; premium_remaining: number | null; opensource_remaining: number | null;
  five_hour: UsageWindow | null; weekly: UsageWindow | null; period_end: number | null; updated_at: number;
}
export interface Upstream {
  id: string; name: string; notes: string; enabled: boolean; whitelist: string[];
  priority: number; load_factor: number; max_concurrency: number; credential_prefix: string;
  proxy_label?: string | null;
  proxy_probe?: { success: boolean; exit_ip?: string; country_code?: string | null; country?: string | null; region?: string | null; city?: string | null; latency_ms?: number; checked_at: number; message?: string } | null;
  health: string; scheduling: string; inflight: number; cooldown_until: number;
  models: Model[]; models_refreshed_at: number | null; models_error: string | null;
  last_test_at: number | null; latency_ms: number | null; last_error: string | null;
  requests: number; successes: number; errors: number;
  billing_source?: string | null; billing?: Billing | null; billing_error?: string | null; billing_checked_at?: number | null;
}
export interface Client {
  id: string; name: string; notes: string; enabled: boolean; whitelist: string[];
  expires_at: number | null; key_prefix: string; requests: number; successes: number;
  errors: number; last_used_at: number | null; key?: string;
}
export interface Audit { id: number; time: number; action: string; target: string; outcome: string; ip: string }
export interface Overview {
  accounts: number; healthy: number; models: number; clients: number; inflight: number;
  requests: number; successes: number; errors: number;
  recent_errors: { id: string; name: string; error: string }[]; internal_base_url: string;
}
let csrf = '';
export class ApiError extends Error { constructor(public status: number, message: string, public code = '') { super(message); } }
export async function session(): Promise<Session> {
  const response = await fetch('/command/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json();
  if (response.status !== 401 && !response.ok) throw new ApiError(response.status, '无法连接管理服务');
  csrf = data.csrf || ''; return data;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/command/api${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('cc:unauthorized'));
    throw new ApiError(response.status, data.error?.message || '请求失败', data.error?.code);
  }
  if (data.csrf) csrf = data.csrf;
  return data;
}
export async function testStream(id: string, body: { model: string; prompt: string }, signal: AbortSignal, onEvent: (event: string, data: Record<string, unknown>) => void) {
  const response = await fetch(`/command/api/upstreams/${id}/test`, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
  });
  if (!response.ok) { const data = await response.json(); if (response.status === 401) window.dispatchEvent(new Event('cc:unauthorized')); throw new ApiError(response.status, data.error?.message || '测试失败'); }
  if (!response.body) throw new Error('浏览器不支持流式响应');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }); let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const event = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (event && data) { onEvent(event, JSON.parse(data)); if (event === 'done') completed = true; }
      }
    }
    if (!completed) throw new Error('测试连接意外中断，请重试');
  } finally { await reader.cancel().catch(() => {}); }
}
