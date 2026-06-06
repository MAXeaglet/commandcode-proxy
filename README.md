# Command Code Proxy

将 Command Code API 转换为 OpenAI 兼容接口的反代代理。

基于对官方 CLI v0.32.3 流量的抓包逆向，精确还原了 Command Code API 的请求协议，并实现了多层反检测伪装。

## 快速开始

### 方式一：配置文件

编辑 `config.json`，填入 API Key：

```json
{
  "port": 3050,
  "apiKey": "user_xxxxxxxxxxxxxxxxxxxx"
}
```

```bash
npm start
```

### 方式二：环境变量

```bash
set CC_API_KEY=user_xxxxxxxxx
npm start
```

默认监听 `http://0.0.0.0:3000`。

## 文件结构

```
commandcode/
├── config.json     # 配置文件（端口 / API Key / 日志路径等）
├── package.json    # npm start
├── proxy.mjs       # 核心代理
└── README.md       # 本文档
```

## 配置

### config.json

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `3000` | 监听端口 |
| `host` | `0.0.0.0` | 监听地址 |
| `apiKey` | `""` | Command Code API Key |
| `apiBase` | `https://api.commandcode.ai` | CC API 地址 |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `logFile` | `""` | 日志文件路径（空=仅控制台） |
| `logLevel` | `info` | 日志级别 |
| `useProviderModels` | `true` | 从 Provider API 动态拉取模型列表 |
| `modelRefreshIntervalMs` | `300000` | 模型列表缓存刷新间隔（5min） |
| `enableVision` | `false` | 启用 vision pipeline（图片→文本描述） |
| `visionModel` | `moonshotai/Kimi-K2.6` | vision pipeline 使用的模型 |

> **注意**：图片输入已通过 `image_url` 原生支持，直接用 vision 模型即可，无需 `enableVision`。`enableVision` 是为不支持的模型准备的图片→文本降级方案。

### 环境变量（优先级高于 config.json）

| 变量 | 说明 |
|------|------|
| `CC_API_KEY` | API Key |
| `PORT` | 端口 |
| `HOST` | 监听地址 |
| `CC_API_BASE` | CC API 地址 |
| `PROJECT_SLUG` | `x-project-slug` header |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` |
| `CC_VISION_MODEL` | `visionModel` |
| `CC_ENABLE_VISION` | `enableVision` |

## API 接口

### `POST /v1/chat/completions`

OpenAI 兼容的聊天补全。支持流式和非流式、工具调用、多模态图片输入。

**请求体：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "max_tokens": 64000,
  "stream": true,
  "reasoning_effort": "medium"
}
```

`reasoning_effort` 支持 `low` / `medium` / `high` / `max`。

**多模态图片输入（需 vision 模型）：**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "描述这张图片" },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
      ]
    }
  ]
}
```

**工具调用：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "tools": [
    { "type": "function", "function": { "name": "get_weather", "description": "...", "parameters": {...} } }
  ],
  "tool_choice": "auto"
}
```

**流式响应：**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考过程"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}

data: [DONE]
```

**非流式响应：**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello!" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 }
}
```

### `POST /v1/messages`

Anthropic Messages API 兼容端点。支持流式和非流式、工具调用。

**请求体：**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "你是一个有用的助手。",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

System prompt 放在顶层（非 messages 数组中），与 Anthropic 原生格式一致。
工具调用使用 `input_schema`（非 `parameters`），`tool_choice` 使用 `{type: "auto"|"any"|"tool"}` 格式。

### `GET /v1/models`

返回可用模型列表。

### `GET /health`

健康检查。

## 错误码

| HTTP 状态 | 说明 |
|-----------|------|
| 400 | 请求格式错误 |
| 401 | API Key 无效或缺失 |
| 429 | 速率限制（含 `retry_after` 字段） |
| 502 | CC 上游错误 |
| 503 | 服务暂时不可用 |

## 可用模型

### Anthropic
| 模型 ID | 说明 |
|---------|------|
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-opus-4-8` | Claude Opus 4.8 |
| `claude-opus-4-7` | Claude Opus 4.7 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |

### OpenAI
| 模型 ID | 说明 |
|---------|------|
| `gpt-5.5` | GPT-5.5 |
| `gpt-5.4` | GPT-5.4 |
| `gpt-5.4-mini` | GPT-5.4 Mini |
| `gpt-5.3-codex` | GPT-5.3 Codex |

### DeepSeek
| 模型 ID | 说明 |
|---------|------|
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash |

### 更多
| 模型 ID | 说明 |
|---------|------|
| `moonshotai/Kimi-K2.6` | Kimi K2.6 |
| `moonshotai/Kimi-K2.5` | Kimi K2.5 |
| `zai-org/GLM-5.1` | GLM 5.1 |
| `zai-org/GLM-5` | GLM 5 |
| `MiniMaxAI/MiniMax-M3` | MiniMax M3 |
| `MiniMaxAI/MiniMax-M2.7` | MiniMax M2.7 |
| `MiniMaxAI/MiniMax-M2.5` | MiniMax M2.5 |
| `Qwen/Qwen3.6-Max-Preview` | Qwen 3.6 Max Preview |
| `Qwen/Qwen3.6-Plus` | Qwen 3.6 Plus |
| `Qwen/Qwen3.7-Max` | Qwen 3.7 Max |
| `stepfun/Step-3.7-Flash` | Step 3.7 Flash |
| `stepfun/Step-3.5-Flash` | Step 3.5 Flash |
| `xiaomi/mimo-v2.5-pro` | MiMo V2.5 Pro |
| `xiaomi/mimo-v2.5` | MiMo V2.5 |
| `google/gemini-3.5-flash` | Gemini 3.5 Flash |
| `google/gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite |

## 接入示例

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050/v1",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### cURL
```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Cursor
在 Cursor 设置中添加 Custom Provider：
- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: 从模型列表中选择

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## 反检测

基于对官方 CLI v0.32.3 的抓包逆向，实现了以下伪装：

| 机制 | 实现 |
|------|------|
| **固定 Session** | 每个进程一个 session，2h 过期 + 30min 抖动 |
| **最新版本号** | `x-command-code-version: 0.32.3` |
| **CLI 信封格式** | config/memory/taste/permissionMode/params/threadId |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **环境标识** | `x-cli-environment: production` |
| **Project Slug** | 自定义 `x-project-slug` |
| **思考强度** | `reasoning_effort` 透传 (low/medium/high/max) |

## 协议细节

CLI 发送的真实请求体结构（抓包还原）：

```json
{
  "config": {
    "workingDir": "C:\\project",
    "date": "2026-06-07",
    "environment": "win32-x64, Node.js v24.16.0",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": "",
  "taste": "",
  "skills": "",
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max"
  },
  "threadId": "<uuid>"
}
```

## 免责声明

本项目仅供**学习和研究**使用。

- **非官方**：本项目与 Command Code 无任何关联，非官方产品。
- **个人使用**：使用者应自行承担所有责任。请遵守 [Command Code 服务条款](https://commandcode.ai/tos)。
- **API Key**：本项目不会收集、上传或泄露你的 API Key。Key 仅存储在本地 `config.json` 中，已通过 `.gitignore` 排除。
- **逆向工程**：协议基于对本地 CLI 网络流量的被动观察，未对服务端进行任何未授权访问、破解或篡改。
- **账号风险**：过度使用代理可能触发 CC 的风控机制。建议和正常 CLI 使用频率保持一致，不要超高并发调用。

## 开发

```bash
# 带 watch 模式启动（文件修改自动重启）
npm run dev
```
