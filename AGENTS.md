# commandcode 代理项目 — AGENTS.md

## 一句话

Command Code API → OpenAI 兼容接口的反代代理。接收 OpenAI 格式的 `/v1/chat/completions`，翻译成 CC 内部协议发往 `api.commandcode.ai`，再把 NDJSON 响应转成 SSE 流回。

## 环境前提

- Node >= 18.0.0
- **零外部依赖**，无需 `npm install`，纯 Node.js 内置模块
- ESM 模块（`package.json` 中 `"type": "module"`，文件扩展名 `.mjs`）
  - ❌ 不要用 `require()`，不要创建 `.js` / `.cjs` 文件

## 启动

```bash
npm start            # 启动（node proxy.mjs）
npm run dev          # watch 模式（node --watch proxy.mjs，Node 内置，非 nodemon）
```

配置加载优先级：**环境变量 > config.json > 默认值**。

| 环境变量 | config.json 字段 | 默认值 |
|----------|-----------------|--------|
| `CC_API_KEY` | `apiKey` | `""` |
| `PORT` | `port` | `3000` |
| `HOST` | `host` | `0.0.0.0` |
| `CC_API_BASE` | `apiBase` | `https://api.commandcode.ai` |
| `PROJECT_SLUG` | `projectSlug` | `cc-proxy` |
| `LOG_FILE` | `logFile` | `""` |

当前实际端口：`3050`（config.json 覆写），监听 `0.0.0.0`（所有网络接口，非仅 localhost）。

## 快速验证

```bash
# 健康检查
curl http://127.0.0.1:3050/health

# 模型列表
curl http://127.0.0.1:3050/v1/models

# 非流式调用
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## 架构

```
工具 (OpenAI格式) → proxy.mjs (端口3050) → api.commandcode.ai/alpha/generate
```

CC API 端点是 `/alpha/generate`，**不是** `/v1/chat/completions`——不要弄混。

单文件 `proxy.mjs`（1335 行），包含 HTTP 服务器、协议转换、session 管理、streaming 全部逻辑。

## 关键文件

| 文件 | 作用 |
|------|------|
| `proxy.mjs` | 全部逻辑：HTTP 服务器、协议转换、session 管理、streaming |
| `config.json` | 端口、API Key、日志路径等 |
| `README.md` | 完整文档（模型列表、接入示例） |
| `.commandcode/taste/` | CLI 自动生成的 taste 数据，**不要手动修改** |

## 已实现的协议

- **输入**: OpenAI Chat Completions (`/v1/chat/completions`) + Anthropic Messages (`/v1/messages`)
- **输出**: OpenAI SSE 流式 + 非流式 JSON；Anthropic SSE 流式 + 非流式 JSON
- **多模态**: 支持 `image_url` 格式图片输入（需用 vision 模型如 `xiaomi/mimo-v2.5`）
- **工具调用**: tool_calls 完整双向映射，含 tool_choice/parallel_tool_calls 透传
- **模型列表**: 从 CC Provider API 动态拉取（5min 缓存），硬编码兜底
- **推理强度**: `reasoning_effort` (low/medium/high/max)
- **Session**: 2h 到期 + 30min 抖动，进程级管理
- **流式超时**: 流式 30s，非流式 90s 无新数据自动中断

## 风险与规避

### 1. CC 升级检测机制

命令码团队可能更新 API 协议或增加反代理检测。

| 风险 | 规避 |
|------|------|
| API 字段变更 | 用 hook-fetch.mjs 定期抓包 CLI 真实流量，对比 proxy.mjs 请求体 |
| 版本号过期 | 更新 `CC_VERSION` 为最新 CLI 版本 |
| 新增必需 header | 抓包对比差异，补齐缺失字段 |
| 用户代理/指纹检测 | 已伪装 `x-cli-environment: production` + W3C traceparent |

**定期抓包对比命令：**
```powershell
$env:NODE_OPTIONS="--import=C:/Users/10045/AppData/Local/Temp/opencode/hook-fetch.mjs"
cmd --prompt "test"
# 然后 diff proxy.mjs 构建的请求体 vs C:\Users\10045\Desktop\cmd-capture.log
```

### 2. Session 指纹风险

| 风险 | 规避 |
|------|------|
| Session 固定导致被关联 | 已实现 2h 到期 + 30min 随机抖动，进程重启自动换新 |
| threadId 复用检测 | 每个请求独立 UUID |
| 并发 session 检测 | 单进程单 session，多用户共享同一 session（和 CLI 行为一致） |

### 3. 流量模式风险

| 风险 | 规避 |
|------|------|
| 高并发暴露代理特征 | 勿对单个 CC 账号开极高并发，和正常 CLI 使用频率保持一致 |
| 非流式请求占比异常 | CC CLI 几乎全是流式，非流式比例过高可能被标记 |
| API Key 格式暴露 | `isPlaceholderKey()` 自动将 `sk-xxx` 等占位 Key 替换为真实 Key，上游看不到占位格式 |

### 4. 套餐与模型限制

| 风险 | 规避 |
|------|------|
| Go 计划用户调用 Pro 模型 | 接口层不做限制，依赖 CC 上游返回错误（错误信息会透传给客户端） |
| 免费额度耗尽触发 429 | proxy 透传 CC 的 429 + `retry_after`，客户端应实现退避重试 |

### 5. 代码层面

| 风险 | 规避 |
|------|------|
| 流中断导致连接泄漏 | 流式/非流式均有超时机制（30s/90s），`res.writableEnded` 检查防重复写 |
| 内存泄漏 | 零依赖，单文件，流式 buffer 每次请求独立，无全局状态累积 |
| config.json 中 Key 泄漏 | 已在 `.gitignore` 排除，仓库中 config.json 的 apiKey 为空字符串 |

### 紧急响应流程

如果 CC 大规模封禁代理流量：

1. 立即停止代理 → `killall node`
2. 用 hook-fetch.mjs 抓一次最新 CLI 流量，对比差异
3. 更新 `CC_VERSION` 和请求体字段
4. 更换 API Key
5. 灰度恢复（先单用户测试，再逐步放开）

基于真实 CLI 抓包逆向，关键伪装：

- 请求体用 `config/memory/taste/permissionMode/params/threadId` 信封格式
- 字段名 camelCase (`workingDir` 不是 `working_dir`)
- `x-session-id`: 每个进程一个，2h 循环
- `x-command-code-version`: `0.32.3`（手动更新）
- `x-cli-environment`: `production`
- `traceparent`: W3C Trace Context
- API Key 哈希映射：客户端填 `sk-xxx` 等占位 Key 会自动替换为 config 里的真实 Key

## 常见陷阱

- 本地 `curl.exe` 用 `-d @file.json` 传 body（PowerShell 的 `curl` 是 `Invoke-WebRequest` 别名）
- 工具连代理时填的 API Key 会被透传给 CC 做认证，不要填假的
- CC API Key 格式是 `user_xxx`，长度远长于 OpenAI 的 `sk-xxx`
- 如果 401，检查 Key 是否在 config.json 中正确配置，以及 CC 账号是否有效
- CC 的 `stream` 参数强制为 `true`，非流式请求在代理层做 buffer
