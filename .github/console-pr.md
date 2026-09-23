## Summary / 概述

Updates PR #27 from a standalone console UI to the current integrated CommandCode management console and gateway. This contribution brings the Vue frontend and Node.js backend together, based on the latest local `commandcode-proxy/master` at `22576e0` and upstream `master` at `cce214d`.

将 PR #27 从独立控制台界面更新为前后端一体的 CommandCode 管理控制台和网关；以本地 `commandcode-proxy/master` 的 `22576e0` 及上游 `master` 的 `cce214d` 为基线。

## Changes / 变更

- Adds separate management (`/command/`, `/command/api/`) and private inference (`/v1/*`) listeners, SQLite persistence, encrypted upstream credentials, administrator sessions and CSRF checks, client key lifecycle, model allowlists, scheduling, audit records, and streaming diagnostics.
- Connects the Vue console to those APIs, including official account usage, monthly allowance, per-account upstream proxy settings, and proxy exit IP/region checks.
- Builds the console inside the Node.js 24 image with pnpm 9; updates compose, documentation, and tests for the integrated runtime.
- Replaces local deployment domains, administrator email, and internal inference address with configurable values. Generated frontend assets and local secret/database files are excluded.

管理与推理分别监听；控制台接入真实管理 API，支持账号用量与月度额度、独立上游代理及出口地区检测；镜像在构建时生成前端资源。部署域名、初始管理员邮箱和展示的推理地址均可配置，不提交生成资源、密钥或本地数据库。

## Verification / 验证

- `npm test`: 48 passed (local mock upstream, no production service).
- `pnpm --dir frontend test`: 6 passed.
- `pnpm --dir frontend build`: TypeScript check and Vite build passed.
- `docker compose config` with an example `CC_ORIGIN`: passed.
- `docker compose build`: not completed because the local Docker Desktop Linux engine is not running (missing `dockerDesktopLinuxEngine` pipe).

## Deployment notes / 部署说明

Set `CC_ORIGIN` to the exact public management origin and provide `master-key` and `admin-password` files through `CC_SECRETS_DIR`. `CC_ADMIN_EMAIL` sets the initial login email; `CC_INTERNAL_BASE_URL` sets the URL shown for private inference clients. See `README.md` / `README_zh.md`. Keep the management API behind a trusted reverse proxy and the inference listener private.

本 PR 改变了启动入口和部署方式；升级已有部署时请保留 SQLite 持久卷与原主密钥。此 PR 未执行生产部署。
