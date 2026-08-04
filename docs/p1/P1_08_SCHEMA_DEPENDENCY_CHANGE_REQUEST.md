# P1-08 · Schema / Dependency / Contract Change Request

**Requester:** Codex

**Status:** `OWNER_APPROVED_AND_P1_08B_IMPLEMENTED`

**Production persistence:** `IMPLEMENTED_IN_P1_08B`

P1-08B 已按 Owner 批准范围实现新的增量 Migration、六个 PostgreSQL adapter/transaction
边界和真实角色验证；未修改 package 文件或 `src/contracts/**`。P1-08A 的内存 adapter 仍仅为
`TEST_ONLY / NOT_PRODUCTION_PERSISTENCE`。

## Owner 决定（2026-08-03）

```text
DEPENDENCY_DECISION=ZERO_NEW_AUTH_DEPENDENCIES
PASSWORD_HASH=VERSIONED_SCRYPT
RECOVERY_CODE_HASH=VERSIONED_SCRYPT
TOTP_CRYPTO=AES_256_GCM_SEPARATE_VERSIONED_KEY
CHALLENGE_SESSION_BINDING=REQUIRED
AUTH_UNIT_OF_WORK=REQUIRED
LOGIN_ATTEMPT_ATOMIC_UPSERT=REQUIRED
```

六张 Auth 表及以上密码学和超时参数已获 Owner 批准，并由 P1-08B 落地为 PostgreSQL 16.14
Migration 与生产 Store。App wiring 和 secret-ingress gated 的 create/replace 入口仍未实施；
validate/supersede Credential Worker 已实现且不调用真实上游。

## 1. PostgreSQL 数据模型建议

| 表 | 核心字段 | 约束与索引 |
| --- | --- | --- |
| `admin_identity` | `id uuid`、`username`、`password_hash`、`role`、`status`、`session_version`、timestamps | username 规范化唯一；`status, updated_at` 索引；`session_version >= 0` |
| `admin_session` | `id uuid`、`identity_id`、`token_hash char(64)`、`session_version`、`issued_at`、`last_seen_at`、`absolute_expires_at`、`two_factor_completed_at`、`revoked_at` | token hash 唯一；identity/active、idle、absolute expiry 索引；`last_seen_at >= issued_at`；绝对期限不得超过 24h |
| `admin_two_factor` | `identity_id`、`enabled`、`encrypted_secret`、`key_version`、`confirmed_at`、pending ciphertext/expiry、recovery rotation time | identity 1:1；enabled 时 active ciphertext/confirmed_at 非空；pending expiry 索引 |
| `admin_two_factor_challenge` | `id uuid`、`identity_id`、`session_id uuid NOT NULL`、`token_hash char(64)`、`expires_at`、`consumed_at`、`attempt_count`、request metadata hashes | `session_id` FK → `admin_session.id`；token hash 唯一；`session_id, consumed_at, expires_at` active challenge 查询索引；identity/active expiry 索引；attempt 0–5 CHECK |
| `admin_recovery_code` | `id uuid`、`identity_id`、`code_hash`、`used_at`、`created_at` | code hash 唯一；`identity_id, used_at` 索引；只存带参数与随机盐的 hash |
| `admin_login_attempt` | `identifier_hash char(64)`、`failure_count`、`locked_until`、`updated_at` | identifier hash 唯一；`locked_until` 索引；failure count 非负 |

Session idle timeout 由 `last_seen_at` 提供，absolute timeout 由不可滑动的
`issued_at + absolute_expires_at` 提供。Session 查询必须同时校验 identity 状态和
`session_version`，注销、改密或恢复码使用后通过 version 前进使旧 Session 失效。
Challenge 必须绑定创建它的当前 Session；同一 identity 的其他 Session 不得完成或消费该
challenge。生产消费必须在事务内锁定 challenge 与其绑定 Session，并验证二者仍处于有效状态。

## 2. 密钥与哈希要求

- TOTP secret 使用独立 `TOTP_ENCRYPTION_KEY`，32-byte base64，AES-256-GCM，版本化载荷；数据库只存密文和 key version，日志不得记录 secret、manual key 或 otpauth URI。
- Admin password 使用带算法、参数和随机盐的版本化 Node `scrypt` 载荷；验证端必须支持按版本迁移，不存明文或可逆密文。
- Recovery Code 使用带算法、参数和随机盐的版本化 Node `scrypt` 载荷。每个 code 原子单次消费，轮换时旧 code 全部失效并前进 `session_version`。
- Session/challenge 原始 token 只在 cookie/调用方短暂存在，数据库只存 SHA-256 hash。
- Credential 的 `encrypted_secret` 与 Credential 解密密钥不属于 Auth 表；Web 仍无权读取，Scheduler 仍不得持有 Credential 密钥。

## 3. Dependency 决定

Owner 已选择 `ZERO_NEW_AUTH_DEPENDENCIES`。P1-08A 使用 Node 20 内建 `crypto` 完成
TOTP、AES-GCM、SHA-256 与 scrypt，不修改 package 或 lockfile。生产实现必须保持：

- TOTP secret：独立且版本化的 AES-256-GCM key，不得与 Credential key 混用；
- Session/challenge token：只存 SHA-256 hash；
- Admin password 与 Recovery Code：版本化 scrypt；
- QR 依赖如未来确需引入，必须另行申请，不属于本批准。

## 4. Auth transaction / unit-of-work 边界

P1-08A 已新增明确的 `AuthUnitOfWork` port；生产 adapter 不得用多个独立 Store 调用模拟
下列事务：

1. **确认 2FA setup**：启用 active TOTP secret、整体替换 recovery codes、前进 identity
   `session_version`，三步同成同败；提交时必须以已验证的 pending ciphertext 和
   `session_version` 作 compare-and-swap，不能启用并发替换后的未验证 secret。
2. **完成 TOTP challenge**：消费 challenge、标记其绑定 Session 的
   `two_factor_completed_at`，两步同成同败。
3. **使用 recovery code 完成 challenge**：消费 recovery code、消费 challenge、标记绑定
   Session 的 `two_factor_completed_at`，同时将 identity `session_version` 前进一版并把绑定
   Session 更新到同一新版本，五步同成同败。其他旧 Session 因版本不匹配失效，绑定 Session
   不得自我失效。challenge 消费失败不得提前烧掉 recovery code，recovery 消费失败不得产生
   Session/challenge/version 半状态。

`TEST_ONLY / NOT_PRODUCTION_PERSISTENCE` 内存 adapter 实现同一原子接口并通过故障注入测试；
这不构成生产持久化实现。

## 5. Login Attempt 原子端口

`LoginAttemptStore.recordFailure(identifierHash, now, windowMs, maxFailures)` 是原子操作。
生产 PostgreSQL adapter 必须使用 `INSERT ... ON CONFLICT ... DO UPDATE` 或等价单语句/事务：

- 窗口过期时重置计数；
- 窗口内原子增加 `failure_count`；
- 达到 5 次时设置 15 分钟 `locked_until`；
- 并发失败不得丢计数。

登录成功仅清理规范化 username bucket，不直接清空可能由多个帐号共享的 IP bucket。

## 6. `src/contracts` 最小变更

由 Claude custodian 审批并合并：

- Admin session DTO：identity id、username、role、capability snapshot、2FA complete 状态和 expiry；不含 token/hash。
- 2FA state/result：`disabled/pending/pending_expired/enabled`、剩余恢复码数量；manual key/recovery 明文只用于一次性成功响应。
- 统一错误 envelope：公开 401/403/404/429 与本轮冻结的 error code。
- Credential UI 契约只暴露 metadata、queued 状态和脱敏 Worker result；不含 secret/ciphertext。

## 7. PostgreSQL 接入顺序

1. Prisma owner 按已批准表形状新增 migration；`src/contracts` 变更仍由其 custodian 单独审批并合并。
2. P1-06 数据库角色补授权：Web 仅 Auth 表所需列，继续 REVOKE Credential ciphertext；Scheduler 无 Auth secret/凭证密钥。
3. 实现五个 PostgreSQL Store adapter 和已冻结的 `AuthUnitOfWork`：setup 三项、TOTP challenge 两项、recovery challenge 三项分别原子提交。
4. 用 PostgreSQL 并发测试验证 challenge/session 绑定、challenge/recovery 单次消费、session touch/revoke 竞态和 login-attempt atomic upsert。
5. P1-09B 在 `src/app/**` 接入 registry/guards 和安全 cookie；上线前轮换正式 Auth/TOTP key。

## 8. 后续依赖

- **P1-08B**：只消费 `credential:manage` guard 和 Worker enqueue contract；必须先等 P1-07R 进入 main，不得在 Web 解密或校验 Credential。
- **P1-09B**：需要本申请的 `src/contracts` DTO 和 App wiring；页面只 AuthN，Route/Action AuthN+AuthZ，mutation service 再校验。
