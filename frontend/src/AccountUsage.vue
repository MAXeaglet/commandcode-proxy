<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { api, type Upstream } from './api';
const props = defineProps<{ account: Upstream }>();
const emit = defineEmits<{ updated: [] }>();
const pending = ref(false); const error = ref('');
const billing = computed(() => props.account.billing_source === 'upstream' ? props.account.billing : null);
let timer: ReturnType<typeof setInterval> | undefined;
let alive = true;
let lastAttempt = 0;
const money = (n: number | null | undefined) => n == null ? '未提供' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(n);
const date = (n?: number | null) => n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '未提供';
async function refresh() {
  if (pending.value) return;
  pending.value = true; error.value = ''; lastAttempt = Date.now();
  try { await api(`/upstreams/${props.account.id}/billing/refresh`, 'POST', {}); }
  catch (e) { error.value = (e as Error).message; }
  finally { pending.value = false; if (alive) emit('updated'); }
}
function autoRefresh() {
  const checked = props.account.billing_source === 'upstream' ? props.account.billing_checked_at || 0 : 0;
  if (document.visibilityState === 'visible' && Date.now() - Math.max(checked, lastAttempt) > 300000) void refresh();
}
onMounted(() => { autoRefresh(); timer = setInterval(autoRefresh, 60000); document.addEventListener('visibilitychange', autoRefresh); });
onBeforeUnmount(() => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', autoRefresh); });
</script>
<template>
  <section class="usage-box" :aria-label="`${account.name} 用量与额度`">
    <div class="usage-heading"><strong>{{ account.name }} · 用量与额度</strong><button class="text-button" :disabled="pending" @click="refresh">{{ pending ? '更新中…' : '刷新额度' }}</button></div>
    <p v-if="!billing && pending">正在自动获取官方用量…</p>
    <p v-else-if="!billing && !error && !account.billing_error">打开页面后自动同步，也可点击刷新额度。</p>
    <p v-if="error || account.billing_error" class="usage-error" role="alert">{{ error || account.billing_error }}{{ billing ? '（以下为上次成功结果）' : '' }}</p>
    <template v-if="billing">
      <div class="usage-values"><div><span>{{ billing.period_basis === 'billing-period' ? '本账期已用' : '官方统计已用' }}</span><strong>{{ money(billing.spent) }}</strong></div><div><span>月度剩余</span><strong>{{ money(billing.monthly_remaining) }}</strong></div><div><span>充值剩余</span><strong>{{ money(billing.purchased_remaining) }}</strong></div><div v-if="billing.free_remaining != null && billing.free_remaining !== 0"><span>免费余额</span><strong>{{ money(billing.free_remaining) }}</strong></div></div>
      <div class="usage-total"><span>月度总额度</span><strong>{{ billing.monthly ? money(billing.monthly.limit) : '未确认' }}</strong></div>
      <p v-if="billing.summary_error" class="usage-error">{{ billing.summary_error }}</p>
      <div v-for="entry in [{ label: '5 小时', value: billing.five_hour }, { label: '每周', value: billing.weekly }, { label: '月度', value: billing.monthly }]" :key="entry.label" class="usage-window">
        <div><span>{{ entry.label }}</span><span v-if="entry.value">已用 {{ money(entry.value.used) }} / {{ money(entry.value.limit) }} · {{ Math.min(100, Math.max(0, entry.value.used / entry.value.limit * 100)).toFixed(1) }}%</span><span v-else>未确认</span></div>
        <template v-if="entry.value"><progress :value="Math.min(entry.value.used, entry.value.limit)" :max="entry.value.limit" :aria-label="`${entry.label}已用额度`" /><small>剩余 {{ money(entry.value.remaining) }} · 重置 {{ date(entry.value.resets_at) }}</small></template>
      </div>
      <p>更新于 {{ date(billing.updated_at) }} · 页面可见时每 5 分钟自动同步</p>
      <details><summary>账期与额度明细</summary><p>账期开始：{{ date(billing.period_start) }}<br />账期结束：{{ date(billing.period_end) }}</p><p v-if="billing.premium_remaining != null">高级模型余额：{{ money(billing.premium_remaining) }}</p><p v-if="billing.opensource_remaining != null">开源模型余额：{{ money(billing.opensource_remaining) }}</p><p>已用金额以官方统计周期为准；不同额度池可能重叠，不相加。</p></details>
    </template>
  </section>
</template>
<style scoped>
.usage-box { margin-top: 16px; padding: 16px; border: 1px solid var(--border, #e1e5e3); border-radius: 12px; font-size: 12px; }
.usage-heading, .usage-heading > div, .usage-window > div, .usage-values { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.usage-values { margin: 14px 0; }
.usage-values > div { display: grid; gap: 5px; }
.usage-values strong { font-size: 18px; }
.usage-total { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border, #e1e5e3); }
.usage-total strong { font-size: 20px; }
.usage-window { margin-top: 12px; }
progress { width: 100%; height: 8px; accent-color: #28735a; }
.usage-error { color: #a83232; }
details { margin-top: 12px; line-height: 1.7; } summary { cursor: pointer; }
</style>
