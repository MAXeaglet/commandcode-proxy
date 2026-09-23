# Command Code Proxy

> [中文文档](README_zh.md)

A Command Code gateway with a Vue management console and OpenAI / Anthropic compatible inference endpoints. The gateway uses Node.js built-in modules; the frontend has build-time dependencies.

Built by analyzing official CLI network traffic to accurately replicate the Command Code API request protocol, including device-fingerprint and lifecycle pre-requests.

**Features**: OpenAI Chat Completions / **Responses API (`/v1/responses`)** + Anthropic Messages API | Streaming & non-streaming | Tool calling (tool_use) | Multimodal image input | Reasoning effort | Dynamic model list | Cache hit metrics | Device fingerprint disguise (per-key, auto-refresh) | `x-api-key` auth (Anthropic SDK) | Client disconnect detection with upstream abort | Zero-output → 429 auto-retry | Consecutive timeout → 429 auto-retry | Privacy-aware logging

**Community**: [Linux.do](https://linux.do) — a friendly Chinese tech community.

## Quick Start

The management API and console listen on port `3050`; private inference listens on port `3051`. Create a 32-byte hex master key and an administrator password of at least 12 characters in separate secret files. Keep both files outside Git. Set `CC_ORIGIN` to the exact browser origin used for management login.

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/master-key
openssl rand -base64 24 > secrets/admin-password
CC_ORIGIN=https://console.example.com docker compose up -d --build
```

Open `https://console.example.com/command/` through your reverse proxy. The initial login is `admin@example.com` unless `CC_ADMIN_EMAIL` is set. `CC_INTERNAL_BASE_URL` controls the inference URL displayed and copied by the console; set it to an address reachable by your clients. See [Management deployment](#management-deployment) for the required settings.

API Key is passed via the `Authorization` request header (or `x-api-key` for Anthropic SDKs) — no need to store it in config files. Key must start with `user_` (automatically matched with any prefix, e.g. `Bearer token_user_xxx`):

```bash
curl http://127.0.0.1:3051/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## File Structure

```
commandcode/
├── config.json           # Port / log path etc.
├── LICENSE               # MIT License
├── package.json          # npm start / npm run dev
├── protocols.mjs         # Command Code protocol conversion
├── server.mjs            # Management and inference listeners
├── lib/                  # Authentication, storage, billing, scheduling, proxy routing
├── frontend/             # Vue management console
├── Dockerfile            # Container build (node:24-alpine)
├── docker-compose.yml    # Container orchestration
├── .dockerignore         # Build context exclusions
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # release branch / v* tags → GHCR multi-arch (latest + release)
├── captured-requests/    # Captured CLI traffic (protocol analysis reference)
├── README.md             # This document (English)
└── README_zh.md          # Chinese documentation
```

## Configuration

### config.json

The following table documents protocol options inherited from the standalone proxy. In the integrated server, `PORT` and `INFERENCE_PORT` control the management and inference listeners; the legacy `config.json` `port`/`host` values do not select those listeners.

| Field | Default | Description |
|------|--------|-------------|
| `port` | `3000` | Listen port (repo config.json ships with `3050`) |
| `host` | `0.0.0.0` | Listen address |
| `apiBase` | `https://api.commandcode.ai` | CC API base URL |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `apiKey` | `""` | Optional fallback API key (requests can also send it via header) |
| `logFile` | `""` | Log file path (empty = console only) |
| `logLevel` | `info` | Log level |
| `useProviderModels` | `true` | Dynamically fetch model list from Provider API |
| `modelRefreshIntervalMs` | `300000` | Model list cache refresh interval (5 min) |
| `zdr` | `false` | Request ZDR-only routing from Command Code |
| `cliMode` | `agent` | Envelope `mode`. Upstream enum: `agent` / `learning` / `custom-agent` / `custom-agent-create` / `title-gen` / `tool-desc` / `compact` / `vision` |
| `cliSessionMode` | `interactive` | `mode` inside the lifecycle metadata (**a different enum**: `interactive` / `non-interactive`) |
| `fingerprintSalt` | `""` | Salt for the device fingerprint — use it to rotate the whole fleet's identity (one key still always reports one device) |
| `deviceProjectDir` | `""` | Faked project directory (empty = built-in `C:\Users\dev\projects\app`); changing it gives every account a different device |
| `emptySystemPlaceholder` | `true` | Send a space placeholder when there is no system prompt, preventing upstream from injecting its ~7.5K-token default ([#17](https://github.com/MAXeaglet/commandcode-proxy/issues/17)) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` (shipped config.json uses `3050`) | Listen port → `port` |
| `HOST` | `0.0.0.0` | Listen address → `host` |
| `CC_API_BASE` | `https://api.commandcode.ai` | Upstream base URL → `apiBase` |
| `CC_UPSTREAM_PROXY` | *(unset)* | Global fallback for accounts without a dedicated upstream proxy; see "Upstream proxy" below → `upstreamProxy` |
| `PROJECT_SLUG` | `cc-proxy` | `x-project-slug` → `projectSlug` |
| `LOG_FILE` | empty | Log file → `logFile` (**synchronous writes**, see [Other notes](#other-notes)) |
| `CC_USE_PROVIDER_MODELS` | `true` | Fetch the model list dynamically → `useProviderModels` |
| `CMD_ZDR` | off | `1` enables ZDR-only routing → `zdr` |
| `CC_CLI_MODE` | `agent` | Envelope `mode` → `cliMode` |
| `CC_CLI_SESSION_MODE` | `interactive` | Lifecycle metadata `mode` → `cliSessionMode` |
| `CC_FINGERPRINT_SALT` | empty | Fingerprint salt → `fingerprintSalt` |
| `CC_DEVICE_PROJECT_DIR` | empty | Faked project directory → `deviceProjectDir` |
| `CC_EMPTY_SYSTEM_PLACEHOLDER` | `true` | Space placeholder for a missing system prompt; `false` disables → `emptySystemPlaceholder` |
| `CC_MAX_BODY_MB` | `100` | Max request body size in MB; oversized requests get `413` |
| `CC_STREAM_IDLE_MS` | `30000` | Streaming upstream read idle timeout; see [Upstream idle timeouts](#upstream-idle-timeouts) |
| `CC_NONSTREAM_IDLE_MS` | `90000` | Non-streaming upstream read idle timeout |
| `CC_MAX_INFLIGHT` | `0` (unlimited) | In-process request cap; over-limit returns `503`; see [In-flight cap](#in-flight-cap-optional) |
| `CC_CLIENT_DRAIN_TIMEOUT_MS` | unset (disabled) | Drop the client once downstream backpressure blocks longer than this; see [Stalled clients](#stalled-clients-neither-reading-nor-disconnecting) |
| `CC_KEEPALIVE_TIMEOUT_MS` | `65000` | Backend keep-alive timeout (`headersTimeout` is set to +1s automatically). **Must be larger than the reverse proxy's keepalive_timeout** — see [keep-alive ordering](#suggested-nginx-front) |

When enabled, the proxy sends `x-cmd-zdr: 1` on Command Code generation requests
and the fingerprint/lifecycle initialization requests. It does not add the header
to the npm version check or the proxy's `/provider/v1/models` catalog request.
This requests Command Code's ZDR-only routing; the upstream service remains the
authority for actual retention and provider availability.

**Request body limit**: independent of `config.json` — requests larger than **100 MB** are rejected with `HTTP 413` (the connection is kept alive and drained, not reset). Override with `CC_MAX_BODY_MB` (positive integer, unit: MB).

> ⚠️ **Memory amplification**: a request body exists in several copies before it reaches upstream; measured peak ≈ body size × **5.1–7.4** (7 MB → +52 MB, 20 MB → +116 MB, while a request rejected with `413` costs only ×1.05). The default `CC_MAX_BODY_MB=100` therefore implies up to ~550 MB for a **single** request, and that limit is per-request, not global. See [Memory & Deployment](#memory--deployment).

### Upstream proxy (`upstreamProxy` / `CC_UPSTREAM_PROXY`)

In the console's upstream account editor, assign one proxy URL per account. `http://`, `https://`, and `socks5://` are supported, with optional `user:pass@` authentication. A blank value on edit keeps the existing proxy; the remove checkbox clears it. URLs are encrypted at rest, and management responses expose only the scheme, host and port.

The account list's exit-IP check follows Sub2API's proxy probe: it requests fixed IP services through that account's proxy and displays the observed exit IP, region and latency. Results are saved with the account and cleared when its proxy changes. This confirms the network route; use the account generation test to verify that a model accepts the exit region.

The global setting below is used only for accounts without a dedicated proxy:

```json
{ "upstreamProxy": "http://127.0.0.1:7890" }
```

```bash
CC_UPSTREAM_PROXY=http://127.0.0.1:7890 npm start
```

- Applies to generation, fingerprint/lifecycle pre-requests, model catalogs and billing queries.
- **Does not** touch the local listener, `/health`, or the npm version check.
- HTTP/HTTPS proxies use CONNECT tunnels; SOCKS5 uses an optional username/password handshake. No new dependency is required.
- Each upstream request opens its own tunnel connection. TLS is end-to-end: the certificate is validated against the **target hostname**, never against the proxy.
- Routing the fingerprint/lifecycle pre-requests through the same proxy matters: if they went out direct while generation went through the proxy, one account would register from two different IPs — exactly the inconsistency you are trying to avoid.
- Credentials in the proxy URL are never logged: only the scheme, host and port show up.

> Node's built-in `fetch` does **not** read `HTTPS_PROXY`/`HTTP_PROXY`. The official env-var route requires Node ≥ 22.21 / 24.5 plus `NODE_USE_ENV_PROXY=1`; this option works without either.

## API Endpoints

### `POST /v1/chat/completions`

OpenAI Chat Completions compatible. Supports streaming, non-streaming, tool calling, multimodal image input, and reasoning effort.

**Request parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `model` | Yes | Model ID (see model list) |
| `messages` | Yes | Conversation messages, supports `system/user/assistant/tool` roles |
| `max_tokens` | No | Max tokens to generate (default 64000) |
| `stream` | No | SSE streaming (default false) |
| `temperature` | No | Sampling temperature (0-2) |
| `reasoning_effort` | No | Reasoning intensity: `low`/`medium`/`high`/`max` |
| `tools` | No | Tool definitions (OpenAI function calling format) |
| `tool_choice` | No | Tool selection strategy |
| `parallel_tool_calls` | No | Allow parallel tool calls |

**Simple request:**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**Multimodal image input (vision model required):**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**Tool calling:**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "tools": [{
    "type": "function",
    "function": { "name": "get_weather", "description": "...", "parameters": {...} }
  }],
  "tool_choice": "auto"
}
```

**Streaming response (SSE):**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking..."}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**Non-streaming response (with cache hits):**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello!",
      "reasoning_content": "The user said hello, I should respond."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 7558,
    "completion_tokens": 42,
    "total_tokens": 7600,
    "prompt_tokens_details": { "cached_tokens": 7552 }
  }
}
```

### `POST /v1/messages`

Anthropic Messages API compatible endpoint. Supports streaming, non-streaming, and tool calling.

**Request body:**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "You are a helpful assistant.",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic protocol conversion (automatic):**

| Concept | Anthropic Format | Conversion |
|---------|-----------------|------------|
| System prompt | Top-level `system` field | Auto-converted to OpenAI `system` message |
| Message content | `content` array (text/tool_use/tool_result) | Auto-mapped to corresponding roles |
| Tool results | `tool_result` blocks in `user` messages | Auto-converted to `role: "tool"` |
| Tool definitions | `input_schema` | Auto-mapped to `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`, `tool`→function object |
| Reasoning | `thinking.budget_tokens` | Auto-mapped to `reasoning_effort` (≥10000→high, ≥5000→medium, ≥2000→low) |
| Stop reason | `end_turn`/`max_tokens`/`tool_use` | Auto-mapped to `stop`/`length`/`tool_calls` |
| Token usage | `input_tokens`/`output_tokens` + cache | Passed through, cache fields mapped to Anthropic format |

**Streaming response (SSE, Anthropic format):**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"...","usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10,"cache_read_input_tokens":0,"input_tokens":100}}

event: message_stop
data: {"type":"message_stop"}
```

**Non-streaming response:**
```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "deepseek/deepseek-v4-flash",
  "content": [{ "type": "text", "text": "Hello!" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 7558,
    "output_tokens": 42,
    "cache_read_input_tokens": 7552,
    "cache_creation_input_tokens": null
  }
}
```

### `POST /v1/responses`

OpenAI **Responses API** (what Codex and the newer OpenAI SDKs speak).

The request side is translated: `input` (message array; items may omit `type`), `instructions`, `max_output_tokens`, `temperature`, `top_p`, `reasoning`, `tools` and `tool_choice` all map onto the CC envelope; the response comes back in Responses shape (`object: "response"`, `output` array, `usage`, `status`). Streaming is SSE:
`response.created` / `response.in_progress` / `response.output_item.added|done` / `response.content_part.added|done` / `response.output_text.delta|done` / `response.reasoning_summary_text.delta|done` / `response.function_call_arguments.delta|done`, terminated by `response.completed` (`response.incomplete` when truncated by `max_output_tokens`, `response.failed` on error).

- **Stateless**: `previous_response_id` is not supported and answers `400` — send the full `input` every turn (the proxy stores no conversation history).
- Errors use the Responses shape: `{"error":{"message":...,"type":...}}`.
- Shares the same upstream call path, cache breakpoints and idle watchdog as `/v1/chat/completions`.

```bash
curl http://127.0.0.1:3051/v1/responses \
  -H "Authorization: Bearer user_xxxxxxxxx" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]}'
```

### `GET /v1/models`

Returns available model list. Fetched dynamically from Provider API (5 min cache), falls back to hardcoded list on failure.

### `GET /health`

Health check. Returns `OK`.

## Error Codes

Produced by the proxy itself:

| HTTP | When |
|------|------|
| `400` | Body is not valid JSON, `input` is empty, or an unsupported `previous_response_id` is used |
| `401` | API key missing / malformed (must start with `user_`; sent via `Authorization: Bearer` or `x-api-key`) |
| `404` | Unknown path |
| `413` | Body exceeds `CC_MAX_BODY_MB` (connection kept alive and drained, not reset) |
| `429` | Zero output tokens, stream idle timeout (30s streaming / 90s non-streaming), or an upstream rate-limit mapping — all carry `Retry-After` so SDKs back off; after 3 consecutive timeouts a "reduce context" hint is returned |
| `502` | CC upstream error (connection-level failures such as `fetch failed` also land here) |
| `503` | `CC_MAX_INFLIGHT` is set and the in-flight cap is exceeded (`type: server_busy`) |

Upstream CC status mapping (`CC_STATUS_MAP`; anything unlisted becomes `502 upstream_error`):

| Upstream | Downstream |
|----------|------------|
| `400` → `400 invalid_request_error` | `401` → `401 authentication_error` |
| `402` → `429 rate_limit_error` (payment failures are treated as rate limits) | `403` → `401 authentication_error` |
| `404` → `404 not_found` | `422` → `400 invalid_request_error` |
| `429` → `429 rate_limit_error` (with `retry_after: 30`) | `500` / `502` → `502 upstream_error` |
| `503` → `503 temporarily_unavailable` | anything else → `502 upstream_error` |

The machine-readable classification from the upstream error body (`error.code`, e.g. `BAD_REQUEST` / `USAGE_EXCEEDED`) is passed through as `error.code`.

## Model List

The proxy returns a live model list via `GET /v1/models`. Below are common models for reference; the actual list depends on the live API response — see [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits) for plan details.

### Common Models

| Model ID | Provider |
|----------|----------|
| `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-opus-4-7` / `claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6` / `moonshotai/Kimi-K2.5` | Kimi |
| `zai-org/GLM-5.1` / `zai-org/GLM-5` | GLM |
| `MiniMaxAI/MiniMax-M3` / `MiniMaxAI/MiniMax-M2.7` / `MiniMaxAI/MiniMax-M2.5` | MiniMax |
| `Qwen/Qwen3.7-Max` / `Qwen/Qwen3.6-Max-Preview` / `Qwen/Qwen3.6-Plus` | Qwen |
| `stepfun/Step-3.7-Flash` / `stepfun/Step-3.5-Flash` | Step |
| `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5` | Xiaomi (**image input supported**) |
| `google/gemini-3.5-flash` / `google/gemini-3.1-flash-lite` | Gemini |

> ⚠️ Some models (e.g. `deepseek-v4-flash`, `claude-sonnet-4-6`) do not support image input. Use `xiaomi/mimo-v2.5`, `Kimi-K2.5`, or other vision models for multimodal.

## Integration Examples

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3051/v1",
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
curl http://127.0.0.1:3051/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Cursor
Add a Custom Provider in Cursor settings:
- **API Base URL**: `http://127.0.0.1:3051/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: Choose from the model list

### Anthropic (Python SDK)
```python
import anthropic

client = anthropic.Anthropic(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050",
)
message = client.messages.create(
    model="deepseek/deepseek-v4-flash",
    max_tokens=1000,
    system="You are helpful.",
    messages=[{"role": "user", "content": "hello"}],
)
print(message.content[0].text)
```

The Anthropic SDK authenticates via the `x-api-key` header — supported by the proxy natively (no `Authorization` header needed).

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3051/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## Anti-Detection

Aligned line-by-line against the official npm package source (`command-code@1.53.1`; `dist/cli.mjs` is minified but **not obfuscated**). Newer npm releases only raise a drift **warning** — the proxy never silently bumps the version it claims:

| Mechanism | Implementation |
|-----------|---------------|
| **Device Fingerprint** | `POST /alpha/fingerprint/record` before first request per key; signal values (Windows MachineGuid shape, real-shaped MACs, `DESKTOP-xxxxxx` hostname) are **derived deterministically from the API key** and hashed exactly like the CLI, so one key always reports the same device — across restarts, memory reclamation and multiple instances (bulk reset via `CC_FINGERPRINT_SALT`) |
| **Lifecycle Events** | `POST /alpha/lifecycle-events` (`cli_session_exists`, metadata `{sessionId, cliVersion, mode, os}`) sent in parallel with the fingerprint on key init |
| **Per-Key Session** | One session per API key, 12h expiry + 1h random jitter |
| **Version** | `x-command-code-version` reports the **protocol version actually implemented** (currently `1.53.1`); newer npm releases only raise a drift **warning**, never a silent version bump |
| **CLI Envelope** | 9 keys: `config / memory / taste / skills / permissionMode / threadId / mode / promptCache / params` |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **Environment** | `x-cli-environment: production`, `x-taste-learning: "false"`, `User-Agent: cli` |
| **Project Slug** | `x-project-slug` = `slugify(DEVICE_PROFILE.projectDir)` — same source as `config.workingDir` (default `C:\Users\dev\projects\app`, override with `CC_DEVICE_PROJECT_DIR`) |
| **Single Source of Device Truth** | Fingerprint / `config.environment` / `config.workingDir` / `x-project-slug` / lifecycle `os` all read one `DEVICE_PROFILE` (`win32` / `x64`) — so they cannot contradict each other ("fingerprint says win32, environment says linux"), and the host's real platform, Node version and cwd are never handed upstream |
| **Reasoning Effort** | `reasoning_effort` pass-through (low/medium/high/max) |
| **Key Validation** | Regex `user_[a-zA-Z0-9_-]+` on `Authorization: Bearer` or `x-api-key`, auto-cleans extra paths/prefixes, rejects `sk-xxx` format |
| **Stream Timeout** | 30s streaming / 90s non-streaming → 429 with SDK auto-retry |
| **Consecutive Timeout** | 3 consecutive timeouts before "reduce context" hint |
| **Zero-Output Guard** | outputTokens=0 → 429 `rate_limit_error` (SDK auto-retry, anti false billing) |
| **Upstream Abort** | `AbortController` on client disconnect + all error paths |
| **Privacy Logging** | No API key fragments, no error bodies, no stack traces in logs |

## Protocol Details

### CC API Request Structure

```json
{
  "config": {
    "workingDir": "C:\\project",
    "date": "2026-06-07",
    "environment": "win32",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": null,
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max"
  }
}
```

`config.environment` and `config.workingDir` come from `DEVICE_PROFILE` (not from the host), and `skills` is `null` (not an empty string).

Conditional fields: `system` (extracted from `system` messages), `temperature`, `reasoning_effort`, `tools` (mapped to CC `input_schema` format), `tool_choice`, `parallel_tool_calls`. When a `prompt_cache_key` is present (or the client already set `cache_control`), the breakpoint lands on the last system block — caching is prefix-based and system is that prefix.

### CC API Image Message Format

The CLI sends images in this format:

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "What does this image say?" }
  ]
}
```

The proxy receives OpenAI `image_url` format and converts it to the above CC format transparently.

## Docker Deployment

### Management deployment

The compose file builds this PR's frontend and backend together. It binds management and inference to host loopback ports by default; expose only the management route through a trusted reverse proxy. The master key and initial password are mounted from `CC_SECRETS_DIR` (default `./secrets`). Do not rotate the master key without migrating encrypted account credentials.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CC_ORIGIN` | required | Public management origin used for CSRF and cookies |
| `CC_ADMIN_EMAIL` | `admin@example.com` | Initial administrator email; existing database records are unchanged |
| `CC_INTERNAL_BASE_URL` | `http://127.0.0.1:3051/v1` | Inference URL shown to clients in the console |
| `MANAGEMENT_PORT` / `INFERENCE_PORT` | `3050` / `3051` | Host loopback port bindings |
| `CC_SECRETS_DIR` | `./secrets` | Directory containing `master-key` and `admin-password` |
| `CC_DATA_VOLUME` | `commandcode-proxy-data` | Persistent SQLite volume name |

The image is built with Node.js 24. The frontend assets are built inside the Dockerfile. The management API is under `/command/api/`, and inference supports `/v1/chat/completions`, `/v1/responses`, and `/v1/messages` on the private listener. The first run creates an administrator record; subsequent runs use the database record.

### Pull from GHCR

The tags below describe the upstream project's published release image. Build this contribution locally with the compose command above until it is included in a release.

GitHub Actions publishes multi-arch images (`linux/amd64` + `linux/arm64`) to the GitHub Container Registry:

| Tag | Source | Notes |
|-----|--------|-------|
| `:release` | `release` branch | Tracks the release branch |
| `:latest` | `release` branch or `v*` tag | Same digest as `:release`. **"Only updated on version tags" was the old behaviour** — it left `:latest` users stuck on an old build where new endpoints 404'd ([#28](https://github.com/MAXeaglet/commandcode-proxy/issues/28)) |

```bash
docker pull ghcr.io/maxeaglet/commandcode-proxy:release
docker run -d --name cc-proxy -p 3050:3050 -e PORT=3050 ghcr.io/maxeaglet/commandcode-proxy:release
```

The image is public — no login required to pull. After upgrading, confirm the digest actually changed (`docker inspect --format '{{index .RepoDigests 0}}'`) rather than assuming your local cache is current.

### Quick Start (docker compose)

Use the [Quick Start](#quick-start) command after creating the secret files. `CC_ORIGIN` is required by the compose file.

### Build from Source

```bash
docker build -t commandcode-proxy:latest .
```

### Multi-Architecture Build

```bash
npm run docker:build:multi
```

### Environment Variables

Use the [Management deployment](#management-deployment) table for container settings. `PORT` defaults to `3050` for management, `INFERENCE_PORT` to `3051` for inference, and `CC_MAX_INFLIGHT` to `4` in this integrated server.

## In-flight Cap (Optional)

The integrated server defaults to 4 concurrent inference requests (`CC_MAX_INFLIGHT=4`). The protocol-only runner inherited from upstream defaults to unlimited when this variable is unset.

This project is a **pure proxy layer**; concurrency control belongs downstream — use your reverse proxy for per-IP / per-key limits (see the `limit_conn` block in [Memory & Deployment](#memory--deployment)). This option is **not** a replacement for that; it only covers running **without** a reverse proxy (which both the Dockerfile and `npm start` invite) with an in-process, **global-only** guard:

```bash
CC_MAX_INFLIGHT=32 npm start    # at most 32 concurrent requests
```

Over the limit it returns `503` + `Retry-After: 5` + `type: server_busy` — a shape the official OpenAI / Anthropic SDKs retry with backoff, instead of the client seeing a connection reset. `/health` and `/` are exempt so liveness probes and orchestrators never receive a 503 because business traffic is busy.

**Why it exists**: memory is `in-flight × (0.13 MB + 5.5 × body_MB)`. `CC_MAX_BODY_MB` bounds only the **per-request** term; nothing bounds the multiplier — at the default 100 MB, N concurrent requests can cost N × 550 MB.

> ⚠️ Enabling this is **not** the same as being memory-safe: 32 × 550 MB still exceeds a small box. For a hard bound, lower `CC_MAX_BODY_MB` **as well**.

## Upstream Idle Timeouts

Two upstream read idle watchdogs; on expiry the proxy returns `429` (with `retry_after`) so the SDK retries automatically:

| Env var | Default | Applies to |
|---|---|---|
| `CC_STREAM_IDLE_MS` | `30000` | Streaming requests |
| `CC_NONSTREAM_IDLE_MS` | `90000` | Non-streaming requests |

**Semantics**: they measure only the time spent waiting inside `reader.read()`, reset on every received chunk — **not the total request duration**. As long as upstream keeps emitting, the watchdog never fires, even for a request that has been running for tens of minutes.

**The defaults differ from the official CLI, and that is a known trade-off** ([#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)): the official CLI has **no** upstream idle timeout at all — deobfuscating `command-code@1.50.0` shows every `createApiClient({ baseUrl })` call site passes no `timeout`, and 700+ second stalls complete successfully. This proxy keeps 30 s to catch genuinely dead connections; the cost is that a reasoning model's long prefill/first-token stall can be killed.

If you see `429 Response timeout` or `zero output tokens` where the log shows `elapsedMs ≈ 30000` and `bytesReceived = 0`, the watchdog killed a healthy stall — raise it:

```bash
CC_STREAM_IDLE_MS=300000 npm start      # 5 minutes
```

> ⚠️ A false kill costs more than one failed request: the abort returns `429 + retry_after`, the SDK retries automatically, and a retry **resends the entire context** — so each false kill re-pays the full prefill on long conversations.

## Memory & Deployment

> Measurements reproduced from [issue #20](https://github.com/MAXeaglet/commandcode-proxy/issues/20) (Node v24, loopback mock upstream).

Rule of thumb for per-request memory:

```
RSS ≈ 70 MB + in-flight × (0.13 MB + 5.5 × body_MB)
```

### Streaming responses apply backpressure

When `res.write()` returns `false` (the socket write buffer passed `highWaterMark`), reading from upstream pauses, so the response no longer accumulates unbounded in memory:

| Scenario (200 MB upstream stream, client stops reading after sending) | Peak RSS delta |
|---|---|
| Before the fix | **+586 MB** (66 → 652 MB) |
| After the fix | **+4 MB** (backpressure propagates upstream, which stalls after ~8 MB) |

This is not only a hostile-client problem — throttled/mobile links, a client blocked on tool execution, or a client that already gave up but whose TCP stack has not sent RST all trigger it.

### Request body is ~5.5× its size

The body exists in several copies before being forwarded: `chunks[]` / `Buffer.concat` / utf8 string / `JSON.parse` object tree / `buildCcRequest` second object tree / `JSON.stringify` serialized body.

| body | cap | peak delta | status |
|---|---|---|---|
| 7 MB | 100 MB | +52 MB (7.4×) | 200 |
| 20 MB | 100 MB | +116 MB (5.8×) | 200 |
| 20 MB | 8 MB | +21 MB (1.05×) | **413** |

At startup a `warn` is logged when the implied worst case is ≥ 500 MB. The limit is **per request** and the proxy does no in-flight limiting of its own — a public deployment must add both at the reverse proxy.

### Suggested nginx front

Rejecting in nginx means the body is never materialized in the Node process at all:

```nginx
map $http_authorization $cc_key { default $http_authorization; "" $http_x_api_key; }
map "" $cc_global_key { default "global"; }

limit_conn_zone $binary_remote_addr zone=cc_ip:10m;
limit_conn_zone $cc_key             zone=cc_key:10m;
limit_conn_zone $cc_global_key      zone=cc_global:10m;

location /v1/ {
    client_max_body_size 4m;   # must be <= CC_MAX_BODY_MB
    limit_conn cc_ip     8;
    limit_conn cc_key    4;
    limit_conn cc_global 32;   # this *is* the memory ceiling
    limit_conn_status 429;
    proxy_pass http://127.0.0.1:3050;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 300s;   # must exceed the 30s stream idle timeout
}
```

> ⚠️ **keep-alive ordering**: `proxy_set_header Connection ""` above keeps connections to the backend alive, so the
> reverse proxy's `upstream { keepalive_timeout ...; }` **must be smaller than** the backend's `CC_KEEPALIVE_TIMEOUT_MS`
> (default 65s). Get it backwards and nginx reuses a connection the backend has already FIN'd, then hits `EPIPE` while
> writing the POST body (visible in the nginx log as `sendfile() failed (32: Broken pipe)`); POST is not idempotent and
> nginx does not retry it by default — the client gets a bare 502.

### Stalled clients (neither reading nor disconnecting)

Once backpressure is in effect, a client that **neither reads nor disconnects** keeps its request and upstream connection alive indefinitely. Measured residual cost:

| Stalled connections | RSS delta | Upstream connections held |
|---|---|---|
| 1 | +5 MB | 1 |
| 10 | +45 MB | 10 |
| 50 | +248 MB | 50 (**held forever**) |

The cost is **bounded, does not leak, and is reclaimed as soon as the client disconnects** (the RSS curve stays flat) — but the **number of connections itself is unbounded**.

This is left unhandled by default, because a stalled client is indistinguishable at the protocol level from a *legitimate* client blocked on tool execution, and the official CLI has no upstream idle timeout at all (see [#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)) — adding an aggressive timeout would repeat the mistake of killing healthy requests.

To cap it, opt in:

```bash
# only drop a client that has been blocked downstream for over 60s;
# a client that keeps making drain progress never triggers this
CC_CLIENT_DRAIN_TIMEOUT_MS=60000 npm start
```

Measured with the timeout enabled (50 stalled connections): upstream connections held goes from **50 (forever) → 0**, with **no** post-drop draining of upstream.

A more robust cap still belongs at the reverse proxy (`limit_conn`), since only it knows how much concurrency a given deployment can afford.

### Other notes

- **`logFile` uses `appendFileSync`** — synchronous writes on the event loop. Under public load they serialize the loop; prefer leaving it empty and collecting stdout.
- **systemd guard rails**: set `MemoryMax=` and `NODE_OPTIONS=--max-old-space-size=` so an overshoot kills the proxy, not `sshd`/`nginx`.
- **Multi-account + multiple instances**: `sessionStore` / `keyStateStore` are per-process `Map`s, so the same API key served by two instances gets two different sessions and **two different device fingerprints** — upstream sees one account on multiple machines. Scale with consistent hashing on the API key (`hash $cc_key consistent`), not round-robin.

## Disclaimer

This project is for **educational and research purposes** only.

- **Unofficial**: This project is not affiliated with Command Code in any way.
- **Personal Use**: Users assume all responsibility. Please comply with the [Command Code Terms of Service](https://commandcode.ai/tos).
- **API Key**: This project does not collect, upload, or leak your API Key. The key is sent per request via the `Authorization: Bearer <key>` or `x-api-key` header and is never logged; an optional `apiKey` field in `config.json` serves only as a local fallback and never leaves your machine.
- **Compliance**: The protocol is based on passive observation of local CLI network traffic. No unauthorized access, cracking, or tampering of the server has been performed.
- **Account Risk**: Keep usage frequency consistent with normal CLI usage. Extremely high concurrent calls may trigger risk controls.

---

## Development

```bash
# Start with watch mode (auto-reload on file changes)
npm run dev
```
