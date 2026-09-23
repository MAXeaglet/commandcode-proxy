# 账号用量与额度

打开控制台「上游账号」即可自动获取每个账号的官方用量，无需额外登录或复制 Cookie。页面可见时每五分钟同步，也可手动点击「刷新额度」（服务端一分钟缓存）。

展示官方统计已用金额、月度余额、充值余额、免费余额，以及 5 小时和每周窗口已用/上限/剩余及重置时间。仅当官方 summary 明确返回 `periodBasis: billing-period` 时标为「本账期已用」，否则标为「官方统计已用」。未知字段显示「未提供」，月度总额度按官方 CLI 1.54.2 的套餐标识与配额表匹配，区分旧版 Pro 与 Pro v1；月度已用为总额度减月度剩余，不混入充值或免费用量。套餐未知、非 active 或余额超过已知总额度时显示「未确认」，不推测上限。此套餐表需随官方变更维护，不把重叠额度池相加。

## 数据来源

复用已加密保存的上游账号凭据，以 Bearer 和 `x-cli-environment: production` 读取官方 CLI 使用的接口：

- `/alpha/whoami?limits=1`：确认账号与组织范围；有组织时附加 `orgId`。
- `/alpha/billing/credits`：余额与滚动窗口。
- `/alpha/billing/subscriptions`：账期开始与结束。
- `/alpha/usage/summary`：官方已用金额；有账期开始时附加 `since`。

官方接口返回的身份信息和原始响应不保存、不回传、不写日志，仅保留展示需要的数字和时间字段。余额失败保留同凭据下上次结果并标明错误；订阅/汇总失败不影响已成功获取的余额。凭据更换或账号删除会清除缓存，读取账单不影响账号推理健康和调度。

管理接口 `POST /command/api/upstreams/:id/billing/refresh` 沿用管理员会话与 CSRF 校验。

## 从 Cookie 版本升级

移除 Cookie 授权入口和 `billing/session` API。首次刷新忽略旧 Cookie 账单缓存，并删除该账号旧的加密 Cookie。保留空的 `billing_sessions` 表以兼容旧数据库，不要求用户操作数据库或重新创建账号。
