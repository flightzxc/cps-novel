# P1-08B · Credential Worker Integration Plan

**Status:** `NOT_STARTED`

**Entry gate:** P1-07R merged to main, P1-08A rebased and revalidated

## Objective

实现六个 Credential 后台操作，但 Web 只做 AuthN/AuthZ、参数校验、审计意图和任务入队；
Worker 是唯一密文读取、解密及校验执行体，Scheduler 永不执行 Credential 任务。

## Execution Design

1. 冻结任务类型、payload/result schema 与 allowlist；payload 只传 credential/account id、actor、request id，绝不传 secret/ciphertext。
2. 六操作映射：create account、replace secret、validate、disable、enable、supersede。所有入口登记 Admin Action/API，要求 `credential:manage` + 当前 Session 2FA。
3. Web service mutation 使用 P1-08A guard-issued ticket 再次校验 capability，然后经 P1-07 单一任务工厂入队；返回 `credential_validation_queued` 或明确失败码。
4. Worker Handler 领取时使用 P1-07R 的 `execution_token + lease_epoch` fencing；旧租约不得提交 Credential、fingerprint latch、change log 或任务结果。
5. Worker 在单事务内完成 active/superseded 切换、fingerprint 唯一 latch 与 `CredentialChangeLog`；外部调用遵守 side-effect intent 独立先提交规则。
6. Worker 输出仅含 credential id、fingerprint prefix、expiry、状态与脱敏错误；日志禁止 secret、ciphertext、完整 token/fingerprint。

## Required Tests

- Web 角色无法 SELECT `encrypted_secret`，配置中不存在 Credential 解密密钥或解密 import。
- Scheduler allowlist 即使误加任务名也因 handler registry 交集为空而零执行。
- 六操作未认证、无 capability、无 2FA、未登记、绕过入口全部拒绝。
- fingerprint 并发冲突由 PostgreSQL 唯一约束返回 `credential_fingerprint_conflict`。
- 双 Worker、旧 lease、重试和恢复场景均不产生双 active Credential 或重复外部副作用。
- `credential_missing`、`credential_expired`、validation failed 与 capability denied 全部返回脱敏结果。

## Explicit Non-goals

P1-08A 不实现 AES Credential 解密、Credential DB 写入、Worker Handler、渠道请求、真实校验任务或任务注册。本计划也不授权在 P1-07R 合并前提前修改 Worker/Scheduler。
