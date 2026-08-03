# P1-08 · Schema / Dependency / Contract Change Request

**Requester:** Codex

**Status:** `REQUESTED_NOT_APPLIED`

**Production persistence:** `DEFERRED_PENDING_APPROVAL`

本申请不修改 `prisma/**`、package 文件或 `src/contracts/**`。P1-08A 仅提供端口化核心和
`TEST_ONLY / NOT_PRODUCTION_PERSISTENCE` 内存适配器。

## 1. PostgreSQL 数据模型建议

| 表 | 核心字段 | 约束与索引 |
| --- | --- | --- |
| `admin_identity` | `id uuid`、`username`、`password_hash`、`role`、`status`、`session_version`、timestamps | username 规范化唯一；`status, updated_at` 索引；`session_version >= 0` |
| `admin_session` | `id uuid`、`identity_id`、`token_hash char(64)`、`session_version`、`issued_at`、`last_seen_at`、`absolute_expires_at`、`two_factor_completed_at`、`revoked_at` | token hash 唯一；identity/active、idle、absolute expiry 索引；`last_seen_at >= issued_at`；绝对期限不得超过 24h |
| `admin_two_factor` | `identity_id`、`enabled`、`encrypted_secret`、`key_version`、`confirmed_at`、pending ciphertext/expiry、recovery rotation time | identity 1:1；enabled 时 active ciphertext/confirmed_at 非空；pending expiry 索引 |
| `admin_two_factor_challenge` | `id uuid`、`identity_id`、`token_hash char(64)`、`expires_at`、`consumed_at`、`attempt_count`、request metadata hashes | token hash 唯一；active expiry 索引；attempt 0–5 CHECK；消费使用 `UPDATE ... WHERE consumed_at IS NULL` |
| `admin_recovery_code` | `id uuid`、`identity_id`、`code_hash`、`used_at`、`created_at` | code hash 唯一；`identity_id, used_at` 索引；只存带参数与随机盐的 hash |
| `admin_login_attempt` | `identifier_hash char(64)`、`failure_count`、`locked_until`、`updated_at` | identifier hash 唯一；`locked_until` 索引；failure count 非负 |

Session idle timeout 由 `last_seen_at` 提供，absolute timeout 由不可滑动的
`issued_at + absolute_expires_at` 提供。Session 查询必须同时校验 identity 状态和
`session_version`，注销、改密或恢复码使用后通过 version 前进使旧 Session 失效。

## 2. 密钥与哈希要求

- TOTP secret 使用独立 `TOTP_ENCRYPTION_KEY`，32-byte base64，AES-256-GCM，版本化载荷；数据库只存密文和 key version，日志不得记录 secret、manual key 或 otpauth URI。
- Recovery Code 只存随机盐的慢哈希；P1-08A 无新依赖方案为 Node `scrypt`。每个 code 原子单次消费，轮换时旧 code 全部失效并前进 `session_version`。
- Session/challenge 原始 token 只在 cookie/调用方短暂存在，数据库只存 SHA-256 hash。
- Credential 的 `encrypted_secret` 与 Credential 解密密钥不属于 Auth 表；Web 仍无权读取，Scheduler 仍不得持有 Credential 密钥。

## 3. Dependency 建议

P1-08A 已用 Node 20 内建 `crypto` 完成 TOTP、AES-GCM、scrypt，无 package 变更。审批方可选择：

1. **保持零新增依赖（推荐当前基础）**：继续使用已由 RFC 向量测试覆盖的内建实现；QR 由 P1-09B UI 层决定。
2. **成熟库方案**：安全审核后锁定精确版本的 `otpauth`；如 UI 需服务端 QR，再单独申请 `qrcode`。
3. **密码/恢复码统一方案**：生产密码若采用 Argon2id，单独评估原生构建与容器兼容；否则保留 scrypt。不得自动执行 `npm audit fix --force`。

依赖 custodian 必须选择精确版本、更新 lockfile 并重跑 build/test；本申请不预先猜定版本。

## 4. `src/contracts` 最小变更

由 Claude custodian 审批并合并：

- Admin session DTO：identity id、username、role、capability snapshot、2FA complete 状态和 expiry；不含 token/hash。
- 2FA state/result：`disabled/pending/pending_expired/enabled`、剩余恢复码数量；manual key/recovery 明文只用于一次性成功响应。
- 统一错误 envelope：公开 401/403/404/429 与本轮冻结的 error code。
- Credential UI 契约只暴露 metadata、queued 状态和脱敏 Worker result；不含 secret/ciphertext。

## 5. PostgreSQL 接入顺序

1. Claude/SOL 审批表形状、依赖和 contracts；由 Prisma owner 新增 migration。
2. P1-06 数据库角色补授权：Web 仅 Auth 表所需列，继续 REVOKE Credential ciphertext；Scheduler 无 Auth secret/凭证密钥。
3. 实现五个 PostgreSQL Store adapter，并增加同事务 unit-of-work：2FA enable + recovery replace + sessionVersion、恢复码消费 + challenge 消费必须原子。
4. 用 PostgreSQL 并发测试验证 challenge/recovery 单次消费、session touch/revoke 竞态和 login-attempt upsert。
5. P1-09B 在 `src/app/**` 接入 registry/guards 和安全 cookie；上线前轮换正式 Auth/TOTP key。

## 6. 后续依赖

- **P1-08B**：只消费 `credential:manage` guard 和 Worker enqueue contract；必须先等 P1-07R 进入 main，不得在 Web 解密或校验 Credential。
- **P1-09B**：需要本申请的 `src/contracts` DTO 和 App wiring；页面只 AuthN，Route/Action AuthN+AuthZ，mutation service 再校验。
