<script setup lang="ts">
import { reactive, ref } from 'vue';
import Modal from './Modal.vue';
import { api, type Upstream, type Client } from './api';
const props = defineProps<{ kind: 'upstreams' | 'clients'; item?: Upstream | Client }>();
const emit = defineEmits<{ close: []; saved: [value: Upstream | Client] }>();
const source = props.item as Upstream | undefined;
const form = reactive({ name: props.item?.name || '', notes: props.item?.notes || '', enabled: props.item?.enabled ?? true, credential: '', priority: source?.priority ?? 0, load_factor: source?.load_factor ?? 1, max_concurrency: source?.max_concurrency ?? 2, whitelist: props.item?.whitelist.join('\n') || '', expires: (props.item as Client)?.expires_at ? localDate((props.item as Client).expires_at!) : '' });
const pending = ref(false); const error = ref('');
function localDate(value: number) { const d = new Date(value); return new Date(value - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
async function save() {
  pending.value = true; error.value = '';
  try {
    const data: Record<string, unknown> = { name: form.name, notes: form.notes, enabled: form.enabled, whitelist: form.whitelist.split(/[\n,，]/).map(x => x.trim()).filter(Boolean) };
    if (props.kind === 'upstreams') {
      Object.assign(data, { priority: form.priority, load_factor: form.load_factor, max_concurrency: form.max_concurrency });
      if (form.credential || !props.item) data.credential = form.credential;
    } else data.expires_at = form.expires ? new Date(form.expires).getTime() : null;
    const result = await api<Upstream | Client>(`/${props.kind}${props.item ? `/${props.item.id}` : ''}`, props.item ? 'PATCH' : 'POST', data);
    form.credential = ''; emit('saved', result);
  } catch (e) { error.value = (e as Error).message; }
  finally { pending.value = false; }
}
</script>
<template>
  <Modal :title="`${item ? '编辑' : '新建'}${kind === 'upstreams' ? '上游账号' : '客户端 API'}`" @close="!pending && emit('close')">
    <form class="form-stack" @submit.prevent="save">
      <div v-if="error" class="notice error" role="alert">{{ error }}</div>
      <label>名称<input v-model="form.name" name="name" required maxlength="100" placeholder="例如：CommandCode 主账号" /></label>
      <label>备注 <span class="optional">可选</span><textarea v-model="form.notes" name="notes" rows="2" maxlength="2000" placeholder="记录用途，不要填写密钥或密码" /></label>
      <template v-if="kind === 'upstreams'">
        <label>上游凭据 <span class="optional">{{ item ? '留空则不修改' : '仅加密保存' }}</span><input v-model="form.credential" name="credential" type="password" :required="!item" autocomplete="new-password" placeholder="user_…" /></label>
        <div class="form-grid thirds">
          <label>优先级<input v-model.number="form.priority" name="priority" type="number" min="0" max="1000" required /><small>数值越小越优先</small></label>
          <label>负载因子<input v-model.number="form.load_factor" name="load_factor" type="number" min="1" max="1000" required /><small>同层流量权重</small></label>
          <label>最大并发<input v-model.number="form.max_concurrency" name="max_concurrency" type="number" min="1" max="128" required /><small>单账号在途上限</small></label>
        </div>
      </template>
      <label v-else>过期时间 <span class="optional">留空则不过期</span><input v-model="form.expires" name="expires_at" type="datetime-local" /></label>
      <label>模型白名单<textarea v-model="form.whitelist" name="whitelist" class="mono" rows="3" placeholder="每行一个模型，例如 claude-*&#10;留空表示不限制" /><small>精确名称或尾部 * 前缀匹配；实际权限仍受上游可用模型限制。</small></label>
      <label class="check-label"><input v-model="form.enabled" name="enabled" type="checkbox" /><span>启用{{ kind === 'upstreams' ? '此上游账号' : '此客户端 API' }}</span></label>
      <footer class="modal-footer"><button type="button" class="button secondary" :disabled="pending" @click="emit('close')">取消</button><button class="button primary" :disabled="pending">{{ pending ? '正在保存…' : item ? '保存更改' : '创建' }}</button></footer>
    </form>
  </Modal>
</template>
