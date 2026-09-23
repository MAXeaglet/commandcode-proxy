import { readFileSync } from 'node:fs';
import { Repository } from '../lib/repository.mjs';
import { readSecret } from '../lib/security.mjs';

const databasePath = process.env.CC_DATABASE || '/data/commandcode.sqlite';
const masterKey = Buffer.from(readSecret(process.env.CC_MASTER_KEY_FILE || '/run/secrets/master-key'), 'hex');
const source = readFileSync(process.env.CC_ACCOUNTS_FILE || '/migration/accounts.caddy', 'utf8');
const accessKey = readSecret(process.env.CC_ACCESS_KEY_FILE || '/migration/access-key');
const credentials = [...source.matchAll(/Authorization\s+"Bearer\s+(user_[A-Za-z0-9_-]+)"/g)].map(m => m[1]);
if (!credentials.length || credentials.length > 16 || !/^sk-[A-Za-z0-9_.-]{16,512}$/.test(accessKey)) throw new Error('Migration input does not match expected credential formats');
const repo = new Repository(databasePath, masterKey);
try {
  if (repo.list('upstreams').length || repo.list('clients').length) throw new Error('Refusing to migrate into a non-empty database');
  const apiBase = process.env.CC_API_BASE || 'https://api.commandcode.ai';
  for (let index = 0; index < credentials.length; index++) {
    const credential = credentials[index];
    const account = repo.createUpstream({ name: `CommandCode 账号 ${index + 1}`, notes: '从既有 Caddy 账号安全导入', enabled: true, priority: index, load_factor: 1, max_concurrency: 2, whitelist: [] }, credential);
    try {
      const response = await fetch(`${apiBase}/provider/v1/models`, { headers: { Authorization: `Bearer ${credential}`, 'x-cli-environment': 'production' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const current = repo.get('upstreams', account.id);
      current.models = Array.isArray(data.data) ? [...new Set(data.data.filter(m => typeof m?.id === 'string').map(m => ({ id: m.id })))] : [];
      current.models_refreshed_at = Date.now(); current.health = current.models.length ? 'healthy' : 'degraded';
      repo.save('upstreams', current);
    } catch (error) {
      const current = repo.get('upstreams', account.id); current.models_error = '导入时模型目录刷新失败，需在控制台重试'; current.last_error = '模型目录暂不可用'; repo.save('upstreams', current);
    }
  }
  const client = repo.createClient({ name: 'Sub2API 内部客户端', notes: '从既有 Caddy 访问密钥安全导入', enabled: true, whitelist: [], expires_at: null }, accessKey);
  repo.audit('migration.import', `${credentials.length} upstreams`, 'success', 'server');
  console.log(`migration complete: ${credentials.length} upstreams, 1 client`);
  void client;
} finally { repo.close(); }
