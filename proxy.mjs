/**
 * Command Code → OpenAI 兼容代理
 * 基于真实 CLI 流量抓包数据构建
 */
import http from 'http';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── 配置加载 ──────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const defaults = {
    port: 3000,
    host: '0.0.0.0',
    apiBase: 'https://api.commandcode.ai',
    projectSlug: 'cc-proxy',
    logFile: '',
    logLevel: 'info',
    useProviderModels: true,
    modelRefreshIntervalMs: 5 * 60 * 1000,  // 5 minutes
  };

  const configPath = resolve(__dirname, 'config.json');
  if (existsSync(configPath)) {
    try {
      const user = JSON.parse(readFileSync(configPath, 'utf-8'));
      Object.assign(defaults, user);
    } catch (e) {
      console.error('[config] Failed to parse config.json:', e.message);
    }
  }

  // 环境变量覆写
  if (process.env.PORT) defaults.port = parseInt(process.env.PORT);
  if (process.env.HOST) defaults.host = process.env.HOST;
  if (process.env.CC_API_BASE) defaults.apiBase = process.env.CC_API_BASE;
  if (process.env.PROJECT_SLUG) defaults.projectSlug = process.env.PROJECT_SLUG;
  if (process.env.LOG_FILE) defaults.logFile = process.env.LOG_FILE;
  if (process.env.CC_USE_PROVIDER_MODELS) defaults.useProviderModels = process.env.CC_USE_PROVIDER_MODELS !== 'false';

  return defaults;
}

const CFG = loadConfig();
let CC_VERSION = '0.32.3';
const CC_VERSION_FALLBACK = '0.32.3';
const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h — npm registry 刷新间隔

// ── 动态 CC 版本号（从 npm registry 拉取） ─────────────
async function refreshCCVersion() {
  try {
    const url = 'https://registry.npmjs.org/command-code/latest';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`npm responded with ${res.status}`);
    const pkg = await res.json();
    if (pkg.version && typeof pkg.version === 'string') {
      CC_VERSION = pkg.version;
      log('info', 'CC Version refreshed from npm', { version: CC_VERSION });
    }
  } catch (e) {
    log('warn', 'CC Version fetch failed, using current', { version: CC_VERSION, error: e.message });
  }
}
refreshCCVersion(); // 启动时立即拉取
setInterval(refreshCCVersion, CC_VERSION_REFRESH_MS);

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB — 请求体大小上限
const STREAM_IDLE_TIMEOUT_MS = 30000;   // 30s — 流式无新数据中断
const NONSTREAM_IDLE_TIMEOUT_MS = 90000; // 90s — 非流式超时更宽容

// ── 日志 ─────────────────────────────────────────────
function log(level, msg, data) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  if (CFG.logFile) {
    try { appendFileSync(CFG.logFile, line + '\n', 'utf-8'); } catch {}
  }
}

// ── 会话管理 ───────────────────────────────────────
// 每个 API Key 独立一个 session，12h 过期 + 1h 随机抖动
// 同一 Key 在同一周期内复用，到期自动换新
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;    // 12h
const SESSION_JITTER_MS  = 60 * 60 * 1000;           // 1h 抖动范围

const sessionStore = new Map(); // apiKey → { sessionId, expiresAt }

function ensureSession(apiKey) {
  const now = Date.now();
  const entry = sessionStore.get(apiKey);

  if (entry && now < entry.expiresAt) {
    return entry.sessionId;
  }

  // 过期或第一次：生成新 session
  const jitter = Math.floor(Math.random() * SESSION_JITTER_MS);
  const sessionId = randomUUID();
  sessionStore.set(apiKey, { sessionId, expiresAt: now + SESSION_DURATION_MS + jitter });
  log('info', 'Session created', { keyPrefix: apiKey.slice(0, 8) + '...', sessionId: sessionId.slice(0, 8), storeSize: sessionStore.size });
  return sessionId;
}

// 定期清理过期 session，防止 Map 无限增长
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of sessionStore) {
    if (now >= entry.expiresAt) {
      sessionStore.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) log('info', 'Session cleanup', { cleaned, remaining: sessionStore.size });
}, 60 * 60 * 1000); // 每小时

function getSessionId(incomingHeaders, apiKey) {
  // 优先从客户端传来的 session 类 header 获取
  const candidates = [
    incomingHeaders['x-session-id'],
    incomingHeaders['x-claude-code-session-id'],
  ];
  for (const id of candidates) {
    if (id && typeof id === 'string' && id.length >= 8) return id;
  }
  // 按 API Key 分 session
  return ensureSession(apiKey);
}

// 每个请求独立 thread ID
function newThreadId() { return randomUUID(); }

// ── 模型列表 ───────────────────────────────────────
const MODELS = [
  // Anthropic
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  // OpenAI
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  // DeepSeek
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  // Kimi
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5' },
  // GLM
  { id: 'zai-org/GLM-5.1', name: 'GLM 5.1' },
  { id: 'zai-org/GLM-5', name: 'GLM 5' },
  // MiniMax
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3' },
  { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7' },
  { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5' },
  // Qwen
  { id: 'Qwen/Qwen3.6-Max-Preview', name: 'Qwen 3.6 Max Preview' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max' },
  // Step
  { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash' },
  { id: 'stepfun/Step-3.5-Flash', name: 'Step 3.5 Flash' },
  // Xiaomi
  { id: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
  // Gemini
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
];

// ── 工具函数 ───────────────────────────────────────

// 从 sessionId 构造一个假的工作目录路径，再按真实 CLI 规则生成 slug
// 结果形如 "d-users-dev-projects-web-app-a3f2" (和真实 CLI 的 slug 格式一致)
function fakeProjectSlug(sessionId) {
  const names = ['app', 'api', 'backend', 'bot', 'cli', 'core', 'data', 'frontend',
    'lib', 'plugin', 'proxy', 'server', 'service', 'tool', 'web', 'worker'];
  const name = names[parseInt(sessionId.slice(0, 4), 16) % names.length];
  const suffix = sessionId.slice(0, 4);
  // 模拟一个类似 C:\Users\dev\projects\{name}-{suffix} 的路径
  const path = `C:\\Users\\dev\\projects\\${name}-${suffix}`;
  return path
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function getEnvironment() {
  return `${process.platform}-${process.arch}, Node.js ${process.version.slice(1)}`;
}

// ── CC 请求体构建 ─────────────────────────────────

function buildCcRequest(openaiReq) {
  const { model, messages, max_tokens, temperature, tools, stream, reasoning_effort, tool_choice, parallel_tool_calls } = openaiReq;

  // 从 messages 中提取 system prompt
  const systemMsgs = messages.filter(m => m.role === 'system');
  const systemPrompt = systemMsgs.map(m => m.content).join('\n');
  const chatMessages = messages.filter(m => m.role !== 'system');

  // Build tool_call_id → tool_name reverse lookup
  const toolNameMap = {};
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolNameMap[tc.id] = tc.function?.name || '';
        }
      }
    }
  }

  // 转换 messages 为 CC 格式
  const ccMessages = chatMessages.map(msg => {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return { role: 'user', content: [{ type: 'text', text: msg.content }] };
      }
      // 多模态：数组 content 原样透传（text + image_url → CC image 格式）
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map(part => {
          if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            // CC CLI 真实格式: { type: "image", image: "data:image/jpeg;base64,..." }
            return { type: 'image', image: url };
          }
          return part;
        }).filter(Boolean);
        return { role: 'user', content: parts };
      }
      return { role: 'user', content: [{ type: 'text', text: String(msg.content) }] };
    }
    if (msg.role === 'assistant') {
      const parts = [];
      if (msg.content && typeof msg.content === 'string') {
        parts.push({ type: 'text', text: msg.content });
      } else if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') parts.push(part);
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function?.name || '',
            input: (typeof tc.function?.arguments === 'string' ? tryParseJSON(tc.function.arguments) : (tc.function?.arguments || {})),
          });
        }
      }
      return { role: 'assistant', content: parts };
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: msg.tool_call_id,
          toolName: toolNameMap[msg.tool_call_id] || msg.name || '',
          output: { type: 'text', value: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
        }],
      };
    }
    return msg;
  });

  const threadId = newThreadId();

  const body = {
    config: {
      workingDir: process.cwd(),
      date: getDateStr(),
      environment: getEnvironment(),
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: '',
    taste: '',
    skills: '',
    permissionMode: 'standard',
    params: {
      model: model || 'deepseek/deepseek-v4-flash',
      messages: ccMessages,
      max_tokens: Math.min(max_tokens || 64000, 200000),
      stream: true,  // CC API 总是 stream
    },
    threadId,
  };

  // 条件字段
  if (systemPrompt) {
    body.params.system = systemPrompt;
  }
  if (temperature !== undefined) {
    body.params.temperature = temperature;
  }
  if (reasoning_effort !== undefined) {
    body.params.reasoning_effort = reasoning_effort;
  }
  if (tools && tools.length > 0) {
    body.params.tools = tools.map(t => ({
      type: t.type || 'function',
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    }));
  }
  if (tool_choice !== undefined) {
    // OpenAI 格式 → CC (Anthropic 风格) 格式
    if (typeof tool_choice === 'string') {
      const map = { 'auto': 'auto', 'none': 'none', 'required': 'any' };
      body.params.tool_choice = { type: map[tool_choice] || 'auto' };
    } else if (tool_choice.type === 'function') {
      // OpenAI object → Anthropic object
      body.params.tool_choice = { type: 'tool', name: tool_choice.function?.name };
    } else {
      body.params.tool_choice = tool_choice;
    }
  }
  if (parallel_tool_calls !== undefined) {
    body.params.parallel_tool_calls = parallel_tool_calls;
  }

  return body;
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// ── CC NDJSON → OpenAI SSE 转换 ────────────────────

function createSseTranslator(model, completionId, created) {
  let chunkIndex = 0;
  let sentRole = false;
  let finishReason = null;
  let usage = null;
  let toolCallIndex = 0;

  return {
    lastCcEvent: '',
    /** 解析一行 NDJSON，返回 OpenAI chunk 数组 */
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;

      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'text-start':
        case 'reasoning-start':
        case 'start':
        case 'start-step':
          // 忽略，无用户可见内容
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text };
          chunkIndex++;
          sentRole = true;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          const delta = chunkIndex === 0
            ? { role: 'assistant', reasoning_content: text }
            : { reasoning_content: text };
          chunkIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'tool-call': {
          const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`;
          const name = event.toolName || '';
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } };
          const delta = chunkIndex === 0
            ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
            : { tool_calls: [tcEntry] };
          chunkIndex++;
          toolCallIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'finish-step': {
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) usage = event.usage;
          break;
        }

        case 'finish': {
          const fr = finishReason || mapFinishReason(event.finishReason || 'stop');
          const u = event.totalUsage || usage || {};
          normalizeUsage(u);
          const openaiUsage = u ? {
            prompt_tokens: u.inputTokens ?? 0,
            completion_tokens: u.outputTokens ?? 0,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
          } : undefined;
          out.push(makeChunk(completionId, created, model, {}, fr, openaiUsage));
          break;
        }

        case 'error': {
          const msg = event.error?.message || event.message || 'Unknown error';
          log('warn', 'CC stream error', { message: msg });
          // Don't emit a finish_reason chunk — let the natural stream termination
          // handle it. Otherwise a subsequent finish(tool_calls) would be ignored
          // by downstream agent loops that stop at the first finish_reason.
          break;
        }

        default:
          log('warn', 'Unknown CC event type', { type: event.type, event: JSON.stringify(event).slice(0, 200) });
          break;
      }

      return out.length > 0 ? out : null;
    },

    /** 获取 SSE 结束标记 */
    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };
}

function makeChunk(id, created, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// normalize CC usage stats:
// - outputTokens=0 → zero input + cached (anti false billing)
// - cachedInputTokens=0 && input>0 → fill with 90% of input (cache miss masking)
function normalizeUsage(u) {
  if (!u) return;
  const ot = Number(u.outputTokens);
  const it = Number(u.inputTokens);
  if (!ot) {  // 0, null, undefined, NaN → zero input + cached (anti false billing)
    log('info', 'normalizeUsage: output=0, zeroing input', {
      originalInputTokens: u.inputTokens,
      originalCached: u.cachedInputTokens,
    });
    u.inputTokens = 0;
    u.cachedInputTokens = 0;
  } else if ((Number.isNaN(Number(u.cachedInputTokens)) || Number(u.cachedInputTokens) === 0) && it > 0) {
    u.cachedInputTokens = Math.floor(it * 0.9);
  }
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'tool-calls': return 'tool_calls';
    case 'length': return 'length';
    case 'stop': return 'stop';
    default: return reason || 'stop';
  }
}

// ── 错误映射 ───────────────────────────────────────
const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },       // payment required → rate limit
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
};

function mapCcError(ccStatus, ccBody) {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };
  let message = `CC API error (${ccStatus})`;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody);
      message = parsed.error?.message || parsed.message || message;
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  // CC 429 响应可能带 retry-after
  if (ccStatus === 429) {
    return {
      status: 429,
      body: {
        error: { message, type: 'rate_limit_error' },
        retry_after: 30,
      },
    };
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } };
}

// ── HTTP 请求处理 ──────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    req.on('data', c => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy(new Error('Request body too large'));
        reject(new Error('Request body exceeds 10MB limit'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getApiKey(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  // 从字符串中提取第一个 user_ 开头的 Key，自动清理空格/引号/多余路径
  const match = auth.slice(7).match(/user_[a-zA-Z0-9_-]+/);
  if (!match) return null;
  return match[0];
}

// ── 流式转发 ────────────────────────────────────────

async function forwardToCC(body, apiKey, incomingHeaders = {}) {
  const url = `${CFG.apiBase}/alpha/generate`;
  const traceparent = generateTraceparent();
  const sessionId = getSessionId(incomingHeaders, apiKey);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-cli-environment': 'production',
      'x-command-code-version': CC_VERSION,
      'x-session-id': sessionId,
      'x-co-flag': 'false',
      'x-taste-learning': 'false',
      'x-project-slug': fakeProjectSlug(sessionId),
      'traceparent': traceparent,
    },
    body: JSON.stringify(body),
  });

  return response;
}

// ── 路由 ────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  let openaiReq;
  try {
    openaiReq = await readBody(req);
  } catch {
    sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendJSON(res, 401, { error: { message: 'Missing API key. Send in Authorization: Bearer <key> header', type: 'auth_error' } });
    return;
  }

  const stream = openaiReq.stream === true;
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = nowUnix();

  // 构建 CC 请求体
  const ccBody = buildCcRequest(openaiReq);

  try {
    // 转发到 CC API（传入客户端 headers，用于提取 session ID）
    const ccResponse = await forwardToCC(ccBody, apiKey, req.headers);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error', { status: ccResponse.status, body: errorText.slice(0, 200) });
      const mapped = mapCcError(ccResponse.status, errorText);
      sendJSON(res, mapped.status, mapped.body);
      return;
    }

    let reader = null;
    const startTime = Date.now(); let bytesReceived = 0; let lastCcEvent = '';
    if (stream) {
      // ── 流式响应 ──
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const translator = createSseTranslator(model, completionId, created);
      let buffer = '';
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();

      // 下游断连检测
      res.on('close', () => {
        log('warn', 'Client disconnected', {
          path: '/v1/chat/completions',
          model,
          completionId,
          streaming: true,
          elapsedMs: Date.now() - startTime,
          bytesSent: bytesReceived,
          lastCcEvent: lastCcEvent || '(none)',
        });
      });

      try {
        while (true) {
          const result = await Promise.race([
            reader.read(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), STREAM_IDLE_TIMEOUT_MS)
            ),
          ]);
          const { done, value } = result;
          if (done) break;
          bytesReceived += value.length;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const events = translator.parseLine(line);
            if (events) {
              for (const evt of events) res.write(evt);
            }
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
        }

        // 处理剩余 buffer
        if (buffer.trim()) {
          const events = translator.parseLine(buffer);
          if (events) {
            for (const evt of events) res.write(evt);
          }
        }

        res.write(translator.getDoneEvent());
      } catch (e) {
        if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            keyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : 'unknown',
            path: '/v1/chat/completions',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: completionId,
            bytesReceived,
            lastCcEvent: lastCcEvent || '(none)',
          });
          try { reader.cancel(); } catch {}
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: 'Response timeout - try reducing context length (summarize earlier messages)', type: 'rate_limit_error' } })}\n\n`); } catch {}
            if (!res.writableEnded) res.end();
          }
        } else {
          log('error', 'Stream error', { message: e.message });
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'proxy_error' } })}\n\n`); } catch {}
          }
        }
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式响应（缓冲完整 NDJSON）──
      let fullText = '';
      let reasoningContent = '';
      let finishReason = 'stop';
      let usage = null;
      let toolCalls = null;

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; reasoningContent += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                toolCalls = toolCalls || [];
                toolCalls.push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish':
                lastCcEvent = event.type;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage) usage = event.totalUsage;
                break;
              case 'error':
                lastCcEvent = event.type;
                log('warn', 'CC stream error (non-stream)', { message: event.error?.message || event.message });
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type, event: JSON.stringify(event).slice(0, 200) });
                break;
            }
          } catch {}
        }
      };

      while (true) {
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), NONSTREAM_IDLE_TIMEOUT_MS)
          ),
        ]);
        const { done, value } = result;
        if (done) break;
        bytesReceived += value.length;
        buf += decoder.decode(value, { stream: true });
        processLines();
      }
      processLines();

      sendJSON(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: Object.assign(
            { role: 'assistant', content: fullText || null },
            toolCalls ? { tool_calls: toolCalls } : {},
            reasoningContent ? { reasoning_content: reasoningContent } : {},
          ),
          finish_reason: finishReason,
        }],
    usage: (() => {
      if (!usage) usage = {};
      normalizeUsage(usage);
      return {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
      };
    })(),
      });
    }
  } catch (e) {
    if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        keyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : 'unknown',
        path: '/v1/chat/completions',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: completionId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel(); } catch {}
      sendJSON(res, 429, { error: { message: 'Response timeout - try reducing context length (summarize earlier messages)', type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
    } else {
      log('error', 'Upstream error', { message: e.message, stack: e.stack?.split('\n')[1]?.trim() });
      sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 } });
    }
  }
}

// ── Anthropic /v1/messages 协议转换 ─────────────────

function mapAnthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    default: return 'end_turn';
  }
}

function buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage) {
  const content = [];
  if (fullText) content.push({ type: 'text', text: fullText });
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: (() => {
      normalizeUsage(usage || {});
      return {
        input_tokens: usage?.inputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
        cache_creation_input_tokens: usage?.inputTokenDetails?.cacheWriteTokens ?? null,
        cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
      };
    })(),
  };
}

function convertAnthropicToOpenAI(anthropicReq) {
  // 1. Extract system prompt (top-level, not in messages array)
  let systemPrompt = '';
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemPrompt = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      systemPrompt = anthropicReq.system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
  }

  // 2. Build tool name map + convert messages
  const toolNameFromId = {};
  const openaiMessages = [];

  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemPrompt });
  }

  const messages = anthropicReq.messages || [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      let textContent = '';
      const toolCalls = [];
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += block.text || '';
        } else if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name;
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }
      const assistantMsg = { role: 'assistant', content: textContent || null };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      openaiMessages.push(assistantMsg);
    } else if (msg.role === 'user') {
      let textContent = '';
      const toolResults = [];
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text || '';
          } else if (block.type === 'tool_result') {
            toolResults.push(block);
          }
        }
      }
      if (textContent) {
        openaiMessages.push({ role: 'user', content: textContent });
      }
      for (const tr of toolResults) {
        const toolContent = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('')
          : String(tr.content || '');
        openaiMessages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          name: toolNameFromId[tr.tool_use_id] || '',
          content: toolContent,
        });
      }
    }
  }

  // 3. Build OpenAI request
  const openaiReq = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  };

  // 4. Map tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiReq.tools = anthropicReq.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  // 5. Map tool_choice
  if (anthropicReq.tool_choice) {
    const tc = anthropicReq.tool_choice;
    if (tc.type === 'auto' || tc.type === undefined) {
      openaiReq.tool_choice = 'auto';
    } else if (tc.type === 'any') {
      openaiReq.tool_choice = 'required';
    } else if (tc.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    } else if (tc.type === 'none') {
      openaiReq.tool_choice = 'none';
    }
  }

  // 6. Optional params
  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id;

  // 7. Anthropic thinking → reasoning_effort（LiteLLM 标准映射）
  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking;
    if (t.type === 'disabled' || t.type === 'none') {
      // 不发送 reasoning_effort
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium';
    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else if (t.budget_tokens >= 2000) openaiReq.reasoning_effort = 'low';
      else openaiReq.reasoning_effort = 'low'; // <2000 → low
    }
  }

  return openaiReq;
}

/**
 * Async generator that reads CC NDJSON response body and yields
 * Anthropic SSE events for streaming.
 */
async function* createAnthropicSseTranslator(response, model, messageId, ctx) {
  let nextBlockIndex = 0;
  let currentBlockIndex = -1;
  let currentBlockType = null;
  let blockStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let stopReason = null;
  let hasError = false;

  // Close the current text block if one is active
  function closeTextBlock() {
    if (blockStarted && currentBlockType === 'text') {
      blockStarted = false;
      currentBlockType = null;
      return `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex })}\n\n`;
    }
    return '';
  }

  // Open a new text block (closing any previous block first)
  function startTextBlock() {
    if (!blockStarted || currentBlockType !== 'text') {
      const close = closeTextBlock();
      currentBlockIndex = nextBlockIndex++;
      currentBlockType = 'text';
      blockStarted = true;
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'text', text: '' } })}\n\n`;
    }
    return '';
  }

  // Emit message_start (always the first event)
  yield `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  })}\n\n`;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), STREAM_IDLE_TIMEOUT_MS)
        ),
      ]);
      const { done, value } = result;
      if (done) break;
      ctx.bytesReceived += value.length;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        if (!event.type) continue;
        ctx.lastCcEvent = event.type;

        switch (event.type) {
          case 'start': case 'start-step': case 'text-start': case 'reasoning-start':
            // Signal events, no user-visible data
            break;

          case 'reasoning-delta':
            // Anthropic Messages API default mode doesn't expose thinking blocks
            break;

          case 'text-delta': {
            const text = event.text || '';
            if (!text) break;
            const startBlock = startTextBlock();
            if (startBlock) yield startBlock;
            yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`;
            outputTokens += Math.ceil(text.length / 4);
            break;
          }

          case 'tool-call': {
            // Close any pending text block
            const closeBlock = closeTextBlock();
            if (closeBlock) yield closeBlock;

            const id = event.toolCallId || `toolu_${randomUUID().slice(0, 12)}`;
            const name = event.toolName || '';
            const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});

            const tcIndex = nextBlockIndex++;
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`;
            yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`;
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`;
            outputTokens += 20;
            break;
          }

          case 'finish-step':
          case 'finish': {
            if (event.finishReason) stopReason = mapAnthropicStopReason(event.finishReason);
            const u = event.totalUsage || event.usage;
            if (u) {
              normalizeUsage(u);
              inputTokens = u.inputTokens ?? inputTokens;
              outputTokens = u.outputTokens ?? outputTokens;
              cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens;
              cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens;
              ctx.inputTokens = inputTokens;
              ctx.outputTokens = outputTokens;
              ctx.cachedInputTokens = cachedInputTokens;
            } else {
              inputTokens = 0;
              outputTokens = 0;
              cachedInputTokens = 0;
              cacheWriteTokens = 0;
              ctx.inputTokens = 0;
              ctx.outputTokens = 0;
              ctx.cachedInputTokens = 0;
            }
            break;
          }

          case 'error': {
            hasError = true;
            const msg = event.error?.message || event.message || 'Unknown CC error';
            yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: msg } })}\n\n`;
            break;
          }

          default:
            log('warn', 'Unknown CC event type', { type: event.type, event: JSON.stringify(event).slice(0, 200) });
            break;
        }
      }
    }

    // Finalize — close pending text block, emit message_delta + message_stop
    if (!hasError) {
      const closeBlock = closeTextBlock();
      if (closeBlock) yield closeBlock;

      yield `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason || 'end_turn' },
        usage: { output_tokens: outputTokens, cache_read_input_tokens: cachedInputTokens, cache_creation_input_tokens: cacheWriteTokens || null, input_tokens: inputTokens },
      })}\n\n`;

      yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
    }
  } finally {
    // 确保流中断时通知上游
    try { reader.cancel(); } catch {}
  }
}

function sendAnthropicError(res, status, type, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

async function handleMessages(req, res) {
  let anthropicReq;
  try {
    anthropicReq = await readBody(req);
  } catch {
    sendAnthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendJSON(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Missing API key. Send in Authorization: Bearer <key> header' } });
    return;
  }

  const stream = anthropicReq.stream === true;
  const model = anthropicReq.model || 'claude-sonnet-4-6';

  // Convert Anthropic → OpenAI → CC
  const openaiReq = convertAnthropicToOpenAI(anthropicReq);
  const ccBody = buildCcRequest(openaiReq);

  try {
    let reader = null;
    const ccResponse = await forwardToCC(ccBody, apiKey, req.headers);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error (Anthropic)', { status: ccResponse.status, body: errorText.slice(0, 200) });
      const mapped = mapCcError(ccResponse.status, errorText);
      sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message);
      return;
    }
    const startTime = Date.now();

    if (stream) {
      // ── 流式 Anthropic SSE ──
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        const ctx = { bytesReceived: 0, lastCcEvent: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        const messageId = 'msg_' + randomUUID().slice(0, 12);
        // 下游断连检测
        res.on('close', () => {
          log('warn', 'Client disconnected', {
            path: '/v1/messages',
            model,
            messageId,
            streaming: true,
            elapsedMs: Date.now() - startTime,
            bytesSent: ctx.bytesReceived,
            lastCcEvent: ctx.lastCcEvent || '(none)',
            inputTokens: ctx.inputTokens,
            outputTokens: ctx.outputTokens,
            cachedInputTokens: ctx.cachedInputTokens,
          });
        });
        const generator = createAnthropicSseTranslator(ccResponse, model, messageId, ctx);
        for await (const event of generator) {
          res.write(event);
        }
      } catch (e) {
        if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            keyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : 'unknown',
            path: '/v1/messages',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: messageId,
            bytesReceived: ctx.bytesReceived,
            lastCcEvent: ctx.lastCcEvent || '(none)',
            inputTokens: ctx.inputTokens,
            outputTokens: ctx.outputTokens,
            cachedInputTokens: ctx.cachedInputTokens,
          });
          if (!res.writableEnded) {
            try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Response timeout - try reducing context length (summarize earlier messages)' } })}\n\n`); } catch {}
            if (!res.writableEnded) res.end();
          }
        } else {
          log('error', 'Anthropic stream error', { message: e.message });
          if (!res.writableEnded) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: e.message } })}\n\n`);
            } catch {}
          }
        }
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式 Anthropic JSON ──
      let fullText = '';
      let finishReason = 'stop';
      let usage = null;
      let toolCalls = null;
      const messageId = 'msg_' + randomUUID().slice(0, 12);
      let bytesReceived = 0; let lastCcEvent = '';

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]') continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                (toolCalls = toolCalls || []).push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish':
                lastCcEvent = event.type;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage) usage = event.totalUsage;
                break;
              case 'error':
                lastCcEvent = event.type;
                log('warn', 'CC error (Anthropic non-stream)', { message: event.error?.message || event.message });
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type, event: JSON.stringify(event).slice(0, 200) });
                break;
            }
          } catch {}
        }
      };

      while (true) {
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), NONSTREAM_IDLE_TIMEOUT_MS)
          ),
        ]);
        const { done, value } = result;
        if (done) break;
        bytesReceived += value.length;
        buf += decoder.decode(value, { stream: true });
        processLines();
      }
      processLines();

      sendJSON(res, 200, buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage));
    }
  } catch (e) {
    if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        keyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : 'unknown',
        path: '/v1/messages',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: messageId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel(); } catch {}
      sendAnthropicError(res, 429, 'rate_limit_error', 'Response timeout - try reducing context length (summarize earlier messages)');
    } else {
      log('error', 'Upstream error', { message: e.message });
      sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`);
    }
  }
}

// ── 动态模型列表 ────────────────────────────────────

let dynamicModels = null;
let modelsLastFetch = 0;

async function fetchModels(apiKey) {
  const now = Date.now();
  if (dynamicModels && (now - modelsLastFetch) < CFG.modelRefreshIntervalMs) {
    return dynamicModels;
  }

  try {
    if (!apiKey || !CFG.useProviderModels) throw new Error('Provider models disabled');

    const response = await fetch(`${CFG.apiBase}/provider/v1/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'x-cli-environment': 'production',
        'x-command-code-version': CC_VERSION,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.data)) {
        dynamicModels = data.data.map(m => ({
          id: m.id,
          name: m.id,
        }));
        modelsLastFetch = now;
        log('info', 'Fetched models from Provider API', { count: dynamicModels.length });
        return dynamicModels;
      }
    }
    log('warn', 'Provider models fetch failed, using hardcoded list', { status: response.status });
  } catch (e) {
    log('warn', 'Provider models fetch error, using hardcoded list', { error: e.message });
  }

  // Fallback to hardcoded MODELS
  return MODELS;
}

async function handleModels(req, res) {
  const apiKey = getApiKey(req.headers);
  const models = await fetchModels(apiKey);
  const now = nowUnix();
  sendJSON(res, 200, {
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: 'command-code',
    })),
  });
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

// ── 服务器 ──────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);

  try {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      handleChatCompletions(req, res);
    } else if (url.pathname === '/v1/messages' && req.method === 'POST') {
      handleMessages(req, res);
    } else if (url.pathname === '/v1/models' && req.method === 'GET') {
      await handleModels(req, res);
    } else if (url.pathname === '/health' || url.pathname === '/') {
      handleHealth(req, res);
    } else {
      sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    }
  } catch (e) {
    sendJSON(res, 500, { error: { message: e.message, type: 'internal_error' } });
  }
});

server.listen(CFG.port, CFG.host, () => {
  log('info', 'CC Proxy started', {
    url: `http://${CFG.host}:${CFG.port}`,
    api: CFG.apiBase,
    models: MODELS.length,
    session: '12h + 1h jitter, per API key',
    logFile: CFG.logFile || '(console only)',
  });
  if (!CFG.apiKey) {
    log('info', 'No API key in config. API key must be sent in Authorization: Bearer <key> header per request.');
  }
});
