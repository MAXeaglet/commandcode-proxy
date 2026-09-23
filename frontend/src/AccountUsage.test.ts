// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountUsage from './AccountUsage.vue';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => ({ api: mocks.api }));
function account(overrides: Record<string, unknown> = {}) { return { id: 'account-1', name: '测试账号', notes: '', enabled: true, whitelist: [], priority: 0, load_factor: 1, max_concurrency: 1, credential_prefix: 'user_test…', health: 'healthy', scheduling: 'ready', inflight: 0, cooldown_until: 0, models: [], models_refreshed_at: null, models_error: null, last_test_at: null, latency_ms: null, last_error: null, requests: 0, successes: 0, errors: 0, billing_source: null, billing: null, billing_error: null, billing_checked_at: null, ...overrides }; }
const billing = { monthly: { used: 7.5, limit: 10, remaining: 2.5, resets_at: 1_803_000_000_000 }, monthly_remaining: 2.5, purchased_remaining: 2.5, free_remaining: 0, premium_remaining: 1, opensource_remaining: null, spent: 4.25, period_basis: 'billing-period', period_start: 1_800_000_000_000, period_end: 1_803_000_000_000, summary_error: null, five_hour: { used: 2, limit: 10, remaining: 8, resets_at: 1_800_000_000_000 }, weekly: { used: 10, limit: 20, remaining: 10, resets_at: null }, updated_at: 1_800_000_000_000 };
afterEach(() => { mocks.api.mockReset(); vi.useRealTimers(); });

describe('AccountUsage', () => {
  it('automatically refreshes on first view and has no Cookie form or legacy cookie display', async () => {
    mocks.api.mockResolvedValue({}); const wrapper = mount(AccountUsage, { props: { account: account({ billing_source: 'cookie', billing: { monthly_remaining: 99 } }) as never } }); await flushPromises();
    expect(mocks.api).toHaveBeenCalledWith('/upstreams/account-1/billing/refresh', 'POST', {}); expect(wrapper.find('input').exists()).toBe(false); expect(wrapper.find('form').exists()).toBe(false); expect(wrapper.text()).not.toContain('Cookie'); wrapper.unmount();
  });

  it('renders official spend basis, zero/free balances, windows, and reset information', () => {
    const wrapper = mount(AccountUsage, { props: { account: account({ billing_source: 'upstream', billing, billing_checked_at: Date.now() }) as never } });
    expect(wrapper.text()).toContain('本账期已用'); expect(wrapper.text()).toContain('月度剩余'); expect(wrapper.text()).toContain('充值剩余'); expect(wrapper.text()).toContain('月度总额度'); expect(wrapper.text()).toContain('75.0%'); expect(wrapper.text()).not.toContain('免费余额'); expect(wrapper.text()).toContain('5 小时'); expect(wrapper.text()).toContain('每周'); expect(wrapper.findAll('progress')).toHaveLength(3); expect(wrapper.findAll('progress')[0].attributes('max')).toBe('10'); expect(wrapper.findAll('progress')[0].attributes('value')).toBe('2'); expect(wrapper.findAll('progress')[2].attributes('max')).toBe('10'); expect(wrapper.findAll('progress')[2].attributes('value')).toBe('7.5'); wrapper.unmount();
  });

  it('does not invent a zero monthly cap when the plan is unknown', () => {
    const wrapper = mount(AccountUsage, { props: { account: account({ billing_source: 'upstream', billing: { ...billing, monthly: null }, billing_checked_at: Date.now() }) as never } });
    expect(wrapper.text()).toContain('月度总额度'); expect(wrapper.text()).toContain('未确认'); expect(wrapper.findAll('progress')).toHaveLength(2); expect(wrapper.findAll('.usage-window')[2].text()).toContain('未确认'); expect(wrapper.findAll('.usage-window')[2].find('progress').exists()).toBe(false); wrapper.unmount();
  });

  it('keeps the previous value visible alongside an error and shows summary errors', () => {
    const wrapper = mount(AccountUsage, { props: { account: account({ billing_source: 'upstream', billing, billing_error: '官方账单暂不可用', billing_checked_at: Date.now() }) as never } });
    expect(wrapper.text()).toContain('官方账单暂不可用'); expect(wrapper.text()).toContain('以下为上次成功结果'); expect(wrapper.findAll('progress')).toHaveLength(3); wrapper.unmount();
  });

  it('supports manual refresh errors and emits updated after the request settles', async () => {
    mocks.api.mockRejectedValue(new Error('刷新失败')); const wrapper = mount(AccountUsage, { props: { account: account({ billing_source: 'upstream', billing_checked_at: Date.now() }) as never } }); await wrapper.find('button').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('刷新失败'); expect(wrapper.emitted('updated')).toBeTruthy(); wrapper.unmount();
  });

  it('refreshes after five minutes while visible and reacts to visibility changes', async () => {
    vi.useFakeTimers(); mocks.api.mockResolvedValue({}); const wrapper = mount(AccountUsage, { props: { account: account({ billing_source: 'upstream', billing_checked_at: Date.now() }) as never } }); await flushPromises(); expect(mocks.api).not.toHaveBeenCalled();
    vi.advanceTimersByTime(360_001); await flushPromises(); expect(mocks.api).toHaveBeenCalledTimes(1);
    const beforeVisibility = mocks.api.mock.calls.length; vi.setSystemTime(Date.now() + 300_001); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); await flushPromises(); expect(mocks.api.mock.calls.length).toBeGreaterThan(beforeVisibility); wrapper.unmount();
  });
});
