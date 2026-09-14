<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronRight, CircleHelp, Copy, Cpu, FileClock, Globe2, KeyRound, Layers3, LayoutDashboard, LogOut, Menu, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, Search, Server, Settings2, ShieldCheck, Sparkles, Terminal, Trash2, X, Zap } from 'lucide-vue-next';
import { api, session, testStream, type Session, type Upstream, type Client, type Overview, type Audit } from './api';
import Modal from './Modal.vue';
import EntityDialog from './EntityDialog.vue';

type Page = 'overview' | 'upstreams' | 'test' | 'models' | 'clients' | 'audit' | 'settings';
const navigation = [
  { id: 'overview' as Page, label: '总览', icon: LayoutDashboard, group: '工作空间' },
  { id: 'upstreams' as Page, label: '上游账号', icon: Server },
  { id: 'test' as Page, label: '账号测试', icon: Terminal },
  { id: 'models' as Page, label: '模型配置', icon: Layers3 },
  { id: 'clients' as Page, label: '内网 API', icon: KeyRound, group: '访问管理' },
  { id: 'audit' as Page, label: '操作审计', icon: FileClock },
  { id: 'settings' as Page, label: '安全设置', icon: ShieldCheck },
];
const page = ref<Page>('overview'); const mobileNav = ref(false); const auth = ref<Session | null>(null); const booting = ref(true);
const email = ref(''); const password = ref(''); const loginError = ref(''); const loggingIn = ref(false);
const overview = ref<Overview>(); const upstreams = ref<Upstream[]>([]); const clients = ref<Client[]>([]); const audits = ref<Audit[]>([]);
const loading = ref(false); const busy = ref(''); const notice = ref(''); const noticeError = ref(false);
const search = ref(''); const selected = ref<string[]>([]);
const editor = ref<{ kind: 'upstreams' | 'clients'; item?: Upstream | Client }>();
const revealed = ref<{ name: string; key: string }>();
const confirmation = ref<{ kind: 'upstreams' | 'clients' | 'sessions'; id: string; name: string; action: 'delete' | 'rotate' | 'revoke' }>();
const grace = ref(0);
const accountId = ref(''); const modelSearch = ref(''); const modelDraft = ref<string[]>([]); const manualModels = ref('');
const testModel = ref(''); const prompt = ref('请简短回复：连接成功。'); const testing = ref(false); const output = ref(''); const events = ref<{ event: string; message: string; ms?: number }[]>([]);
const currentPassword = ref(''); const newPassword = ref(''); const repeatPassword = ref('');
let abortTest: AbortController | undefined; let timer: ReturnType<typeof setInterval> | undefined; let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const currentNav = computed(() => navigation.find(n => n.id === page.value)!);
const filteredUpstreams = computed(() => upstreams.value.filter(a => `${a.name} ${a.notes} ${a.credential_prefix}`.toLowerCase().includes(search.value.toLowerCase())));
const filteredClients = computed(() => clients.value.filter(a => `${a.name} ${a.notes}`.toLowerCase().includes(search.value.toLowerCase())));
const account = computed(() => upstreams.value.find(a => a.id === accountId.value));
const catalog = computed(() => account.value?.models.filter(m => m.id.toLowerCase().includes(modelSearch.value.toLowerCase())) || []);
const testModels = computed(() => {
  const a = account.value; if (!a) return [];
  const rules = a.whitelist;
  return [...new Set([...a.models.map(m => m.id), ...rules.filter(m => !m.endsWith('*'))])].filter(m => !rules.length || rules.some(rule => rule.endsWith('*') ? m.startsWith(rule.slice(0, -1)) : rule === m));
});
const successRate = computed(() => overview.value?.requests ? Math.round(overview.value.successes / overview.value.requests * 100) : 0);
const statusLabels: Record<string, string> = { ready: '就绪', untested: '待测试', disabled: '已停用', credential_error: '凭据异常', cooling: '冷却中', saturated: '并发已满', healthy: '健康', unknown: '未测试', degraded: '需关注' };
const actionLabels: Record<string, string> = { 'auth.login': '管理员登录', 'auth.logout': '退出登录', 'auth.password': '修改密码', 'auth.revoke_others': '撤销其他会话', 'upstreams.create': '新建上游', 'upstreams.update': '修改上游', 'upstreams.delete': '删除上游', 'upstreams.models': '刷新模型目录', 'upstreams.test': '账号生成测试', 'clients.create': '创建客户端 API', 'clients.update': '修改客户端 API', 'clients.delete': '撤销客户端 API', 'clients.rotate': '轮换客户端密钥' };
const eventLabels: Record<string, string> = { connecting: '正在连接上游', connected: '上游连接已建立', first_byte: '收到首字节', done: '测试完成' };
const date = (value?: number | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
const count = (value = 0) => new Intl.NumberFormat('zh-CN').format(value);
function notify(message: string, error = false) { notice.value = message; noticeError.value = error; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => notice.value = '', 6500); }
function navigate(id: Page) { page.value = id; location.hash = id; mobileNav.value = false; search.value = ''; selected.value = []; }
function fromHash() { const value = location.hash.slice(1) as Page; if (navigation.some(n => n.id === value)) page.value = value; }
function unauthorized() { auth.value = null; password.value = ''; revealed.value = undefined; editor.value = undefined; confirmation.value = undefined; upstreams.value = []; clients.value = []; audits.value = []; overview.value = undefined; abortTest?.abort(); output.value = ''; events.value = []; currentPassword.value = ''; newPassword.value = ''; repeatPassword.value = ''; void session().catch(() => {}); }
async function reload(silent = false) {
  if (!auth.value?.email) return;
  if (!silent) loading.value = true;
  try {
    const [o, u, c] = await Promise.all([api<Overview>('/overview'), api<{ data: Upstream[] }>('/upstreams'), api<{ data: Client[] }>('/clients')]);
    if (!auth.value?.email) return;
    overview.value = o; upstreams.value = u.data; clients.value = c.data;
    if (!accountId.value || !u.data.some(a => a.id === accountId.value)) accountId.value = u.data[0]?.id || '';
    if (page.value === 'audit') audits.value = (await api<{ data: Audit[] }>('/audit')).data;
  } catch (error) { if (!silent) notify((error as Error).message, true); }
  finally { loading.value = false; }
}
async function login() {
  loggingIn.value = true; loginError.value = '';
  try { await session(); auth.value = await api<Session>('/auth/login', 'POST', { email: email.value, password: password.value }); password.value = ''; await reload(); }
  catch (error) { loginError.value = (error as Error).message; }
  finally { loggingIn.value = false; }
}
async function logout() {
  try { await api('/auth/session', 'DELETE'); unauthorized(); }
  catch (error) { notify((error as Error).message, true); }
}
async function saved(value: Upstream | Client) {
  editor.value = undefined;
  if ('key' in value && value.key) revealed.value = { name: value.name, key: value.key };
  notify('已安全保存'); await reload(true);
}
async function run(id: string, work: () => Promise<void>) {
  if (busy.value) return; busy.value = id;
  try { await work(); } catch (error) { notify((error as Error).message, true); } finally { busy.value = ''; }
}
async function toggle(kind: 'upstreams' | 'clients', row: Upstream | Client) { await run(row.id, async () => { await api(`/${kind}/${row.id}`, 'PATCH', { enabled: !row.enabled }); await reload(true); notify(row.enabled ? '已停用' : '已启用'); }); }
function toggleAll() { selected.value = selected.value.length === filteredUpstreams.value.length ? [] : filteredUpstreams.value.map(a => a.id); }
async function batch(enabled: boolean) { await run('batch', async () => { await api('/upstreams/batch', 'POST', { ids: selected.value, enabled }); selected.value = []; await reload(true); notify('批量操作已完成'); }); }
async function confirmAction() {
  const value = confirmation.value; if (!value) return;
  await run('confirm', async () => {
    if (value.action === 'rotate') { const result = await api<Client>(`/clients/${value.id}/rotate`, 'POST', { grace_seconds: grace.value }); confirmation.value = undefined; revealed.value = { name: value.name, key: result.key! }; }
    else if (value.kind === 'sessions') { await api('/auth/sessions/others', 'DELETE'); confirmation.value = undefined; notify('其他会话已全部注销'); }
    else { await api(`/${value.kind}/${value.id}`, 'DELETE'); confirmation.value = undefined; notify('已撤销并删除'); }
    await reload(true);
  });
}
async function copy(value: string) { try { await navigator.clipboard.writeText(value); notify('已复制到剪贴板'); } catch { notify('剪贴板不可用，请手动选择复制', true); } }
function selectAccount(id: string, destination: Page) { accountId.value = id; navigate(destination); }
function resetModelDraft() { modelDraft.value = account.value?.whitelist.filter(m => !m.endsWith('*')) || []; manualModels.value = account.value?.whitelist.filter(m => m.endsWith('*')).join('\n') || ''; }
async function refreshModels() {
  if (!accountId.value) return;
  await run('refresh', async () => {
    const data = await api<Upstream>(`/upstreams/${accountId.value}/models/refresh`, 'POST', {});
    const index = upstreams.value.findIndex(a => a.id === data.id); if (index >= 0) upstreams.value[index] = data;
    notify(`目录验证通过，已拉取 ${data.models.length} 个模型`);
    if (page.value === 'test') events.value = [{ event: 'catalog', message: `凭据与网络验证通过 · ${data.models.length} 个模型`, ms: data.latency_ms ?? undefined }];
    await reload(true);
  });
}
function selectVisibleModels() { modelDraft.value = [...new Set([...modelDraft.value, ...catalog.value.map(m => m.id)])]; }
async function saveModels() { await run('models', async () => { const whitelist = [...new Set([...modelDraft.value, ...manualModels.value.split(/[\n,，]/).map(x => x.trim()).filter(Boolean)])]; await api(`/upstreams/${accountId.value}`, 'PATCH', { whitelist }); await reload(true); resetModelDraft(); notify('模型白名单已更新'); }); }
async function startTest() {
  if (testing.value) return;
  testing.value = true; output.value = ''; events.value = []; abortTest = new AbortController();
  try {
    await testStream(accountId.value, { model: testModel.value, prompt: prompt.value }, abortTest.signal, (event, data) => {
      if (event === 'text') { output.value += String(data.text || ''); return; }
      events.value.push({ event, message: event === 'done' && !data.success ? String(data.error || '测试失败') : eventLabels[event] || event, ms: typeof data.elapsed_ms === 'number' ? data.elapsed_ms : undefined });
      if (event === 'done' && !data.success) notify(String(data.error || '测试失败'), true);
    });
  } catch (error) { events.value.push({ event: 'error', message: abortTest.signal.aborted ? '测试已停止' : (error as Error).message }); }
  finally { testing.value = false; await reload(true); }
}
async function changePassword() {
  if (newPassword.value !== repeatPassword.value) return notify('两次输入的新密码不一致', true);
  await run('password', async () => { await api('/auth/password', 'PATCH', { current_password: currentPassword.value, password: newPassword.value }); currentPassword.value = ''; newPassword.value = ''; repeatPassword.value = ''; notify('密码已修改，其他会话已注销'); });
}
async function moreAudits() { await run('audit', async () => { const last = audits.value.at(-1); if (!last) return; const result = await api<{ data: Audit[] }>(`/audit?before=${last.id}`); if (!result.data.length) notify('已加载全部记录'); else audits.value.push(...result.data); }); }
watch(accountId, resetModelDraft);
watch(testModels, values => { if (!values.includes(testModel.value)) testModel.value = values[0] || ''; });
watch(page, value => { if (value === 'models') resetModelDraft(); if (value === 'audit') void reload(true); if (value !== 'test') abortTest?.abort(); });
onMounted(async () => {
  fromHash(); window.addEventListener('hashchange', fromHash); window.addEventListener('cc:unauthorized', unauthorized);
  try { const value = await session(); if (value.email) { auth.value = value; await reload(); } }
  catch (error) { loginError.value = (error as Error).message; }
  finally { booting.value = false; }
  timer = setInterval(() => { if (auth.value?.email && !testing.value && !busy.value && !document.hidden) void reload(true); }, 15000);
});
onBeforeUnmount(() => { clearInterval(timer); clearTimeout(noticeTimer); abortTest?.abort(); window.removeEventListener('hashchange', fromHash); window.removeEventListener('cc:unauthorized', unauthorized); });
</script>

<template>
  <div v-if="booting" class="boot-screen"><div class="brand-mark"><Terminal :size="25" /></div><span>正在连接工作空间…</span></div>
  <div v-else-if="!auth?.email" class="login-layout">
    <section class="login-story">
      <a class="brand" href="/command/"><span class="brand-mark"><Terminal :size="24" /></span><span>CommandCode<span class="brand-caption">CONTROL PLANE</span></span></a>
      <div class="login-story-main"><span class="pill light"><span class="status-dot" /> SECURE BY DESIGN</span><h1>连接模型。<br />掌控每一次<span>调用。</span></h1><p>一个安静、有序的工作空间。<br />统一管理上游账号、模型与内网访问。</p>
        <div class="login-diagram"><div><Layers3 :size="20" /><span>模型集群</span></div><span class="diagram-line" /><div class="diagram-core"><Terminal :size="26" /></div><span class="diagram-line" /><div><ShieldCheck :size="20" /><span>服务网络</span></div></div>
      </div>
      <footer><span class="status-dot" /> 管理面与推理面严格隔离 <span>COMMANDCODE / CONSOLE</span></footer>
    </section>
    <main class="login-form-area"><form class="login-form" @submit.prevent="login"><span class="eyebrow">WELCOME BACK</span><h2>登录管理控制台</h2><p>继续管理你的 AI 基础设施。</p><div v-if="loginError" class="notice error" role="alert">{{ loginError }}</div><label>管理员邮箱<input v-model="email" name="email" type="email" required autocomplete="username" /></label><label>密码<input v-model="password" name="password" type="password" required autocomplete="current-password" placeholder="输入管理员密码" /></label><button class="button primary login-button" :disabled="loggingIn">{{ loggingIn ? '正在验证…' : '进入工作空间' }}<ArrowRight :size="18" /></button><div class="login-security"><ShieldCheck :size="16" /><span>安全会话 · 受限访问 · 全程审计</span></div></form><span class="login-footnote">仅供授权管理员使用</span></main>
  </div>
  <div v-else class="workspace">
    <div v-if="mobileNav" class="sidebar-shade" @click="mobileNav = false" />
    <aside class="sidebar" :class="{ opened: mobileNav }">
      <a class="brand" href="#overview" @click.prevent="navigate('overview')"><span class="brand-mark"><Terminal :size="22" /></span><span>CommandCode<span class="brand-caption">CONTROL PLANE</span></span></a>
      <div class="workspace-label"><span class="workspace-avatar">CC</span><div>默认工作空间<small>安全网关 · 单管理员</small></div><ChevronRight :size="15" /></div>
      <nav aria-label="主导航"><template v-for="item in navigation" :key="item.id"><span v-if="item.group" class="nav-group">{{ item.group }}</span><button :class="['nav-item', { active: page === item.id }]" :aria-current="page === item.id ? 'page' : undefined" @click="navigate(item.id)"><component :is="item.icon" :size="19" /><span>{{ item.label }}</span><span v-if="item.id === 'upstreams'" class="nav-count">{{ upstreams.length }}</span></button></template></nav>
      <div class="sidebar-bottom"><div class="network-note"><ShieldCheck :size="19" /><div>推理接口受访问控制<small>由部署环境配置</small></div></div><button class="profile" @click="navigate('settings')"><span class="avatar">A</span><span>Administrator<small>工作空间管理员</small></span><Settings2 :size="17" /></button></div>
    </aside>
    <div class="workspace-main">
      <header class="topbar"><div class="breadcrumb"><button class="icon-button menu-button" aria-label="打开导航" @click="mobileNav = true"><Menu :size="20" /></button><span>工作空间</span><ChevronRight :size="14" /><strong>{{ currentNav.label }}</strong></div><div class="topbar-actions"><span class="private-label"><span class="status-dot" /> 安全部署</span><span class="topbar-divider" /><button class="icon-button" :disabled="loading" aria-label="刷新数据" @click="reload()"><RefreshCw :size="17" :class="{ spinning: loading }" /></button><button class="icon-button" aria-label="退出登录" @click="logout"><LogOut :size="17" /></button></div></header>
      <main class="page-content">
        <header class="page-heading"><div><span class="eyebrow">{{ page === 'overview' ? 'YOUR GATEWAY, AT A GLANCE' : 'COMMANDCODE / ' + page.toUpperCase() }}</span><h1>{{ page === 'overview' ? '工作空间总览' : currentNav.label }}<span v-if="page === 'overview'" class="heading-dot" /></h1><p>{{ { overview: '账号、模型与请求状态，一目了然。', upstreams: '让每个账号各尽其能，让每次请求有序抵达。', test: '从目录连通到真实生成，逐步验证上游状态。', models: '按账号精细配置模型，让可用能力清晰可控。', clients: '一个内网入口，为每个客户端划定独立边界。', audit: '每一次关键操作，都有迹可循。', settings: '管理你的凭据与会话，守护工作空间。' }[page] }}</p></div><button v-if="page === 'upstreams' || page === 'clients'" class="button primary" @click="editor = { kind: page }"><Plus :size="18" />{{ page === 'upstreams' ? '新建上游账号' : '创建客户端 API' }}</button><span v-else-if="page === 'overview'" class="date-chip">{{ new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) }}</span></header>
        <template v-if="page === 'overview'">
          <section class="overview-hero"><div class="hero-copy"><span class="pill light"><span class="status-dot" /> PRIVATE MODEL GATEWAY</span><h2>你的模型，井然有序。</h2><p>分层优先级与加权负载调度，<br />为每一次灵感提供稳定的连接。</p><button class="hero-link" @click="navigate('upstreams')">管理上游账号 <ArrowUpRight :size="17" /></button></div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one" /><div class="orbit orbit-two" /><div class="art-node node-a"><Cpu :size="23" /></div><div class="art-node node-b"><Layers3 :size="22" /></div><div class="art-node node-c"><Zap :size="20" /></div><div class="art-center"><Terminal :size="37" /><span>COMMANDCODE</span></div><span class="art-caption">INTELLIGENCE, CONNECTED.</span></div></section>
          <section class="stat-grid"><article class="stat-card"><div><span>健康上游</span><Server :size="18" /></div><strong>{{ overview?.healthy ?? 0 }}<small>/ {{ overview?.accounts ?? 0 }}</small></strong><span class="stat-foot"><span class="status-dot" /> 已通过连通验证</span></article><article class="stat-card"><div><span>可用模型</span><Layers3 :size="18" /></div><strong>{{ count(overview?.models) }}</strong><span class="stat-foot">健康账号可承载的模型</span></article><article class="stat-card"><div><span>客户端 API</span><KeyRound :size="18" /></div><strong>{{ count(overview?.clients) }}</strong><span class="stat-foot">独立密钥 · 精细化授权</span></article><article class="stat-card"><div><span>当前在途</span><Activity :size="18" /></div><strong>{{ count(overview?.inflight) }}<small>请求</small></strong><span class="stat-foot">实时负载，自动调度</span></article></section>
          <div class="overview-grid"><section class="panel"><header class="panel-header"><div><h3>请求概况</h3><p>自持久化记录建立以来</p></div><span class="pill neutral">累计</span></header><div class="request-summary"><div><span>累计请求</span><strong>{{ count(overview?.requests) }}</strong></div><div><span>成功率</span><strong>{{ successRate }}<small>%</small></strong></div></div><progress class="request-progress" :value="overview?.successes || 0" :max="overview?.requests || 1" /><div class="progress-legend"><span><i class="legend-green" />成功 {{ count(overview?.successes) }}</span><span><i class="legend-amber" />失败 {{ count(overview?.errors) }}</span></div><div class="panel-footnote"><ShieldCheck :size="15" /> 仅记录请求统计，不保存提示词或响应正文</div></section>
          <section class="panel"><header class="panel-header"><div><h3>连接路径</h3><p>管理面与推理面隔离</p></div><Globe2 :size="18" /></header><div class="flow-list"><div><span class="flow-icon"><KeyRound :size="17" /></span><div><strong>客户端鉴权</strong><small>独立 API Key 与模型白名单</small></div><Check :size="16" /></div><div><span class="flow-icon"><Layers3 :size="17" /></span><div><strong>智能账号调度</strong><small>优先级 → 在途负载 → 加权轮询</small></div><Check :size="16" /></div><div><span class="flow-icon"><Cpu :size="17" /></span><div><strong>CommandCode 上游</strong><small>不重放已发送的生成请求</small></div><Check :size="16" /></div></div></section></div>
          <section class="panel"><header class="panel-header"><div><h3>需要关注</h3><p>账号最近的错误状态</p></div><button class="text-button" @click="navigate('upstreams')">查看账号 <ArrowRight :size="15" /></button></header><div v-if="!overview?.recent_errors.length" class="calm-state"><span class="calm-icon"><CheckCircle2 :size="25" /></span><div><strong>当前没有待处理的账号错误</strong><p>一切从容有序。新账号可先执行目录测试。</p></div></div><div v-else class="error-list"><button v-for="item in overview.recent_errors" :key="item.id" @click="selectAccount(item.id, 'test')"><span class="status-dot amber" /><strong>{{ item.name }}</strong><span>{{ item.error }}</span><ArrowUpRight :size="16" /></button></div></section>
        </template>
        <template v-else-if="page === 'upstreams'">
          <div class="info-strip"><Layers3 :size="18" /><span>数值较小的优先级先调度，同层按在途负载与权重分配；全部不可用时自动降级。</span></div>
          <section class="panel table-panel"><div class="table-toolbar"><div class="search-input"><Search :size="17" /><input v-model="search" aria-label="搜索上游账号" placeholder="搜索账号名称、备注…" /></div><div v-if="selected.length" class="batch-actions"><span>已选 {{ selected.length }}</span><button class="text-button" :disabled="!!busy" @click="batch(true)">启用</button><button class="text-button" :disabled="!!busy" @click="batch(false)">停用</button></div><span v-else class="muted">{{ upstreams.length }} 个账号</span></div>
            <div class="table-scroll"><table><thead><tr><th class="checkbox-cell"><input type="checkbox" aria-label="选择全部账号" :checked="!!filteredUpstreams.length && selected.length === filteredUpstreams.length" @change="toggleAll" /></th><th>账号</th><th>调度 / 健康</th><th>优先级 / 权重</th><th>并发负载</th><th>请求统计</th><th>最近测试</th><th class="align-right">操作</th></tr></thead><tbody><tr v-for="row in filteredUpstreams" :key="row.id"><td><input v-model="selected" type="checkbox" :value="row.id" :aria-label="`选择 ${row.name}`" /></td><td><div class="entity-name"><span class="entity-avatar"><Server :size="17" /></span><div><strong>{{ row.name }}</strong><small class="mono">{{ row.credential_prefix }}</small><small v-if="row.notes" class="row-note">{{ row.notes }}</small></div></div></td><td><span :class="['pill', row.scheduling]"><span class="status-dot" />{{ statusLabels[row.scheduling] }}</span><small class="cell-sub">{{ statusLabels[row.health] }}{{ row.cooldown_until > Date.now() ? ' · ' + Math.ceil((row.cooldown_until - Date.now()) / 1000) + 's' : '' }}</small></td><td><span class="metric-pair">P{{ row.priority }} <span>/ {{ row.load_factor }}×</span></span></td><td><span class="mono">{{ row.inflight }} <span class="muted">/ {{ row.max_concurrency }}</span></span><progress class="load-progress" :value="row.inflight" :max="row.max_concurrency" /></td><td><strong class="number">{{ count(row.requests) }}</strong><small class="cell-sub">成功 {{ row.successes }} · 失败 {{ row.errors }}</small></td><td><span class="small">{{ date(row.last_test_at) }}</span><small class="cell-sub">{{ row.latency_ms === null ? '—' : row.latency_ms + ' ms' }}</small></td><td><div class="row-actions"><button class="icon-button" :aria-label="`测试 ${row.name}`" title="测试账号" @click="selectAccount(row.id, 'test')"><Play :size="16" /></button><button class="icon-button" :aria-label="`编辑 ${row.name}`" title="编辑账号" @click="editor = { kind: 'upstreams', item: row }"><Pencil :size="16" /></button><button class="icon-button" :disabled="!!busy" :aria-label="`${row.enabled ? '停用' : '启用'} ${row.name}`" :title="row.enabled ? '停用' : '启用'" @click="toggle('upstreams', row)"><Pause v-if="row.enabled" :size="16" /><Play v-else :size="16" /></button><button class="icon-button danger" :aria-label="`删除 ${row.name}`" title="删除账号" @click="confirmation = { kind: 'upstreams', id: row.id, name: row.name, action: 'delete' }"><Trash2 :size="16" /></button></div></td></tr></tbody></table></div>
            <div v-if="!filteredUpstreams.length" class="empty-state"><Server :size="32" /><h3>{{ search ? '没有找到匹配账号' : '连接你的第一个上游账号' }}</h3><p>添加账号后，刷新模型目录即可验证连接。</p><button v-if="!search" class="button secondary" @click="editor = { kind: 'upstreams' }"><Plus :size="16" />添加上游账号</button></div>
          </section>
        </template>
        <template v-else-if="page === 'test'">
          <div class="test-layout"><section class="panel test-config"><header class="panel-header"><div><h3>连接诊断</h3><p>人工测试绕过调度状态，不绕过模型权限</p></div><Terminal :size="19" /></header><div class="form-stack"><label>上游账号<select v-model="accountId" :disabled="testing"><option value="" disabled>请选择账号</option><option v-for="row in upstreams" :key="row.id" :value="row.id">{{ row.name }}</option></select></label><div class="test-step"><span>01</span><div><strong>验证凭据与模型目录</strong><p>检查基础网络，并拉取账号模型快照</p></div></div><button class="button secondary full-width" :disabled="!account || testing || !!busy" @click="refreshModels"><RefreshCw :size="16" :class="{ spinning: busy === 'refresh' }" />{{ busy === 'refresh' ? '正在验证…' : '测试连接 / 刷新目录' }}</button><div v-if="account?.models_error" class="notice error">{{ account.models_error }}</div><div class="test-step"><span>02</span><div><strong>最小真实生成</strong><p>此操作会向上游发送真实请求</p></div></div><label>测试模型<select v-model="testModel" :disabled="testing"><option value="" disabled>请先刷新目录或配置模型</option><option v-for="model in testModels" :key="model" :value="model">{{ model }}</option></select></label><label>测试提示词<textarea v-model="prompt" rows="3" maxlength="4000" :disabled="testing" /></label><button v-if="!testing" class="button primary full-width" :disabled="!account || !testModel || !prompt.trim() || !!busy" @click="startTest"><Play :size="16" />开始生成测试</button><button v-else class="button secondary full-width" @click="abortTest?.abort()"><Pause :size="16" />停止测试</button></div></section><section class="panel terminal-panel"><header class="terminal-header"><div><span class="terminal-dots"><i /><i /><i /></span><span>实时输出</span></div><span :class="['pill', testing ? 'ready' : 'neutral']">{{ testing ? 'STREAMING' : 'READY' }}</span></header><div class="test-timeline" aria-live="polite"><div v-for="(event, index) in events" :key="index"><span class="timeline-dot" /><span>{{ event.message }}</span><code v-if="event.ms !== undefined">{{ event.ms }} ms</code></div></div><pre v-if="output" class="test-output" aria-label="生成输出">{{ output }}</pre><div v-else-if="!events.length" class="terminal-empty"><Terminal :size="40" /><h3>等待一次连接</h3><p>选择账号和模型，实时观察<br />连接、首字节与生成结果。</p></div><div v-else-if="testing" class="terminal-wait"><span class="cursor" /> 等待上游内容…</div><footer class="terminal-footer"><ShieldCheck :size="14" /> 提示词与正文不会写入审计日志</footer></section></div>
        </template>
        <template v-else-if="page === 'models'">
          <section class="panel"><div class="model-toolbar"><label>上游账号<select v-model="accountId"><option value="" disabled>请选择账号</option><option v-for="row in upstreams" :key="row.id" :value="row.id">{{ row.name }}</option></select></label><div class="model-freshness"><span>最近刷新</span><strong>{{ date(account?.models_refreshed_at) }}</strong></div><button class="button secondary" :disabled="!account || !!busy" @click="refreshModels"><RefreshCw :size="16" :class="{ spinning: busy === 'refresh' }" />刷新目录</button></div></section><div v-if="account?.models_error" class="notice error">{{ account.models_error }}</div>
          <div v-if="account" class="models-layout"><section class="panel"><header class="panel-header"><div><h3>账号模型目录 <span class="count-badge">{{ account.models.length }}</span></h3><p>勾选要加入白名单的模型</p></div><button class="text-button" @click="selectVisibleModels">选择搜索结果</button></header><div class="search-input model-search"><Search :size="17" /><input v-model="modelSearch" aria-label="搜索模型" placeholder="搜索模型名称…" /></div><div class="model-list"><label v-for="model in catalog" :key="model.id" class="model-option"><input v-model="modelDraft" type="checkbox" :value="model.id" /><span class="model-symbol"><Cpu :size="17" /></span><span>{{ model.id }}</span><Check v-if="modelDraft.includes(model.id)" :size="15" /></label><div v-if="!catalog.length" class="empty-state"><Layers3 :size="30" /><h3>暂无匹配模型</h3><p>刷新模型目录，或在右侧手工添加。</p></div></div></section><section class="panel whitelist-panel"><header class="panel-header"><div><h3>有效白名单</h3><p>{{ modelDraft.length }} 个精确模型已选中</p></div><ShieldCheck :size="18" /></header><div class="form-stack"><div v-if="modelDraft.length" class="selected-models"><span v-for="model in modelDraft" :key="model">{{ model }}<button :aria-label="`移除 ${model}`" @click="modelDraft = modelDraft.filter(m => m !== model)"><X :size="12" /></button></span></div><label>手工添加 / 前缀规则<textarea v-model="manualModels" class="mono" rows="6" placeholder="claude-*&#10;zai-org/GLM-5.3" /><small>每行一个模型名称或尾部 * 前缀规则。</small></label><div class="notice"><CircleHelp :size="17" /><span>空白名单表示不限制模型。客户端自己的白名单仍会生效。</span></div><button class="button primary full-width" :disabled="!!busy" @click="saveModels"><Check :size="17" />保存白名单</button><button class="text-button centered" @click="modelDraft = []; manualModels = ''">清空选择（不限制）</button></div></section></div><div v-else class="panel empty-state"><Layers3 :size="32" /><h3>先添加一个上游账号</h3><button class="button secondary" @click="navigate('upstreams')">前往上游账号</button></div>
        </template>
        <template v-else-if="page === 'clients'">
          <section class="endpoint-card"><span class="endpoint-icon"><Globe2 :size="23" /></span><div><span class="eyebrow">统一内网地址 · OPENAI / ANTHROPIC</span><code>由部署环境提供</code></div><button class="button secondary" @click="copy('由部署环境提供')"><Copy :size="15" />复制地址</button></section><div class="info-strip"><ShieldCheck :size="18" /><span>原始密钥仅在创建或轮换时显示一次。数据库仅保存加盐哈希，不提供密钥找回。</span></div>
          <section class="panel table-panel"><div class="table-toolbar"><div class="search-input"><Search :size="17" /><input v-model="search" aria-label="搜索客户端 API" placeholder="搜索客户端名称、备注…" /></div><span class="muted">{{ clients.length }} 个客户端</span></div><div class="table-scroll"><table><thead><tr><th>客户端</th><th>密钥 / 状态</th><th>模型权限</th><th>使用情况</th><th>过期时间</th><th class="align-right">操作</th></tr></thead><tbody><tr v-for="row in filteredClients" :key="row.id"><td><div class="entity-name"><span class="entity-avatar amber-bg"><KeyRound :size="17" /></span><div><strong>{{ row.name }}</strong><small>{{ row.notes || '独立客户端访问凭据' }}</small></div></div></td><td><code>{{ row.key_prefix }}</code><small class="cell-sub"><span :class="['pill', !row.enabled ? 'disabled' : row.expires_at && row.expires_at < Date.now() ? 'cooling' : 'ready']">{{ !row.enabled ? '已停用' : row.expires_at && row.expires_at < Date.now() ? '已过期' : '有效' }}</span></small></td><td><span class="pill neutral">{{ row.whitelist.length ? row.whitelist.length + ' 条规则' : '不限制' }}</span></td><td><strong>{{ count(row.requests) }}</strong><small class="cell-sub">成功 {{ row.successes }} · 失败 {{ row.errors }}</small><small class="cell-sub">最近 {{ date(row.last_used_at) }}</small></td><td class="small">{{ row.expires_at ? date(row.expires_at) : '永不过期' }}</td><td><div class="row-actions"><button class="icon-button" :aria-label="`编辑 ${row.name}`" title="编辑客户端" @click="editor = { kind: 'clients', item: row }"><Pencil :size="16" /></button><button class="icon-button" :aria-label="`轮换 ${row.name}`" title="轮换密钥" @click="grace = 0; confirmation = { kind: 'clients', id: row.id, name: row.name, action: 'rotate' }"><RefreshCw :size="16" /></button><button class="icon-button" :disabled="!!busy" :aria-label="`${row.enabled ? '停用' : '启用'} ${row.name}`" :title="row.enabled ? '停用' : '启用'" @click="toggle('clients', row)"><Pause v-if="row.enabled" :size="16" /><Play v-else :size="16" /></button><button class="icon-button danger" :aria-label="`撤销 ${row.name}`" title="撤销客户端" @click="confirmation = { kind: 'clients', id: row.id, name: row.name, action: 'delete' }"><Trash2 :size="16" /></button></div></td></tr></tbody></table></div><div v-if="!filteredClients.length" class="empty-state"><KeyRound :size="32" /><h3>{{ search ? '没有匹配的客户端' : '为第一个客户端创建访问凭据' }}</h3><p>每个密钥独立授权、统计和轮换。</p><button v-if="!search" class="button secondary" @click="editor = { kind: 'clients' }"><Plus :size="16" />创建客户端 API</button></div></section>
        </template>
        <template v-else-if="page === 'audit'">
          <div class="info-strip"><FileClock :size="18" /><span>仅记录操作类型、目标 ID、结果与来源 IP。不记录密码、完整密钥、提示词或响应正文。</span></div><section class="panel table-panel"><div class="table-scroll"><table><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>来源 IP</th><th>结果</th></tr></thead><tbody><tr v-for="row in audits" :key="row.id"><td class="small nowrap">{{ date(row.time) }}</td><td><span class="audit-action"><FileClock :size="15" />{{ actionLabels[row.action] || row.action }}</span></td><td><code class="target-id">{{ row.target || '管理员会话' }}</code></td><td class="mono small">{{ row.ip || '—' }}</td><td><span :class="['pill', row.outcome === 'success' ? 'ready' : 'cooling']">{{ row.outcome === 'success' ? '成功' : '失败' }}</span></td></tr></tbody></table></div><div v-if="!audits.length" class="empty-state"><FileClock :size="32" /><h3>暂无审计记录</h3></div><footer v-else class="table-footer"><span>已显示 {{ audits.length }} 条</span><button class="text-button" :disabled="!!busy" @click="moreAudits">加载更早记录 <ArrowDownToLine :size="15" /></button></footer></section>
        </template>
        <template v-else-if="page === 'settings'">
          <div class="settings-layout"><section class="panel"><header class="panel-header"><div><h3>修改管理员密码</h3><p>修改后，其他所有登录会话将立即失效。</p></div><KeyRound :size="19" /></header><form class="form-stack" @submit.prevent="changePassword"><label>管理员邮箱<input :value="auth.email" readonly autocomplete="username" /></label><label>当前密码<input v-model="currentPassword" type="password" required autocomplete="current-password" /></label><label>新密码<input v-model="newPassword" type="password" minlength="12" maxlength="128" required autocomplete="new-password" placeholder="12–128 个字符" /></label><label>确认新密码<input v-model="repeatPassword" type="password" minlength="12" maxlength="128" required autocomplete="new-password" /></label><button class="button primary" :disabled="!!busy">保存新密码</button></form></section><section class="panel session-panel"><span class="large-shield"><ShieldCheck :size="32" /></span><h3>你的工作空间，安全有界</h3><p>会话使用安全 Cookie，在 12 小时后过期。<br />如有设备遗失或异常登录，可撤销其他会话。</p><div class="security-facts"><span><Check :size="16" /> Secure / HttpOnly / SameSite</span><span><Check :size="16" /> 写操作 CSRF 校验</span><span><Check :size="16" /> 登录保护与脱敏审计</span></div><button class="button secondary full-width" @click="confirmation = { kind: 'sessions', id: '', name: '', action: 'revoke' }">注销全部其他会话</button></section></div>
        </template>
        <footer class="page-footer"><span>CommandCode Console</span><span>私有连接，清晰掌控。</span></footer>
      </main>
    </div>
  </div>
  <div v-if="notice" :class="['toast', { error: noticeError }]" role="status"><CheckCircle2 v-if="!noticeError" :size="19" /><CircleHelp v-else :size="19" /><span>{{ notice }}</span><button aria-label="关闭提示" @click="notice = ''"><X :size="16" /></button></div>
  <EntityDialog v-if="editor" :kind="editor.kind" :item="editor.item" @close="editor = undefined" @saved="saved" />
  <Modal v-if="revealed" title="请妥善保存这枚密钥" @close="revealed = undefined"><div class="form-stack"><div class="notice"><ShieldCheck :size="18" /><span>这是唯一一次显示完整密钥的机会。关闭后无法再次查看，请存入安全的密码管理器。</span></div><label>{{ revealed.name }}<textarea class="secret-key mono" :value="revealed.key" readonly rows="3" aria-label="一次性 API 密钥" /></label><div class="form-grid"><button class="button secondary" @click="copy(revealed.key)"><Copy :size="16" />复制密钥</button><button class="button secondary" @click="copy(JSON.stringify({ base_url: '由部署环境提供', api_key: revealed.key }, null, 2))"><Copy :size="16" />复制配置</button></div><footer class="modal-footer"><button class="button primary" @click="revealed = undefined"><Check :size="17" />我已安全保存</button></footer></div></Modal>
  <Modal v-if="confirmation" :title="confirmation.action === 'rotate' ? '轮换客户端密钥' : confirmation.action === 'revoke' ? '注销其他会话' : '确认撤销并删除'" @close="!busy && (confirmation = undefined)"><div class="form-stack"><p class="confirm-description">{{ confirmation.action === 'rotate' ? `即将为「${confirmation.name}」生成新密钥。请及时更新客户端配置。` : confirmation.action === 'revoke' ? '除当前会话外，所有登录会话将立即失效。' : `「${confirmation.name}」将被删除，此操作不可撤销。已发送的请求不会重新播放。` }}</p><label v-if="confirmation.action === 'rotate'">新旧密钥并行窗口<select v-model.number="grace"><option :value="0">立即失效旧密钥（默认）</option><option :value="60">1 分钟</option><option :value="300">5 分钟</option><option :value="900">15 分钟</option><option :value="3600">1 小时</option></select><small>窗口结束后，旧密钥自动失效。</small></label><footer class="modal-footer"><button class="button secondary" :disabled="!!busy" @click="confirmation = undefined">取消</button><button :class="['button', confirmation.action === 'delete' ? 'destructive' : 'primary']" :disabled="!!busy" @click="confirmAction">{{ busy ? '正在处理…' : '确认操作' }}</button></footer></div></Modal>
</template>
