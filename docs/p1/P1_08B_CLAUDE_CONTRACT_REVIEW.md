# P1-08B · Claude 前端契约复核（阶段 A）

**审计模式：`READ_ONLY_TARGETED_CONTRACT_REVIEW`**

**复核人：Claude（P1-09B 后台 UI 实施方 / `src/contracts` merge custodian）**

**复核分支：`feature/v0.1.0-p1-auth-credential-backend`**

**复核 HEAD：`95ea7d9c18dda579d070d9adeed9e088565612d2`**

**基线 main：`4fc7a950e9406d7d36c75da41073bc6b5d1cb471`（ahead 4 / behind 0）**

**结论：`RESULT=P1_08B_FRONTEND_CONTRACT_REVIEW_PASS_WITH_SECRET_INGRESS_GATE`**

---

## 0. 范围与纪律

只判断 P1-09B 后台 UI 能否安全消费当前后端。不审计也不重构整体后端架构。
阶段 A 全程只读：未修改文件、未 commit。CPS 参考仓库保持 `d77c3b96` 且工作区 clean。

GitHub 不可达（`REMOTE_SYNC=DEFERRED`）未作为任何判定依据。

---

## 1. 结论块

```
RESULT=P1_08B_FRONTEND_CONTRACT_REVIEW_PASS_WITH_SECRET_INGRESS_GATE
REVIEWED_HEAD=95ea7d9c18dda579d070d9adeed9e088565612d2
ADMIN_SESSION=PASS
CAPABILITY=PASS
TWO_FACTOR=PASS
ACCOUNT_OPERATIONS=PASS
CREDENTIAL_METADATA=PASS
CREDENTIAL_OPERATIONS=PASS
QUEUED_RESULT=PASS
TASK_STATUS_QUERY=PASS_WITH_REQUIRED_BACKEND_FIX
REDACTED_RESULT=PASS
ERROR_ENVELOPE=PASS
SECRET_EXPOSURE=NONE_FOUND
SECRET_INGRESS_GATE=CLEAN_DEFAULT_DENY
P1_09B_READINESS=READY_AFTER_ONE_BACKEND_LINE
REQUIRED_FIXES=1 (backend, non-contract-shape)
NEXT_GATE=CONTRACTS_MERGE
```

---

## 2. 逐项证据

### 2.1 Admin Session — PASS

前端可得：`identityId` / `username` / `role`（`AdminIdentity`）、`twoFactorCompleted`
（`AdminAuthContext`）、`absoluteExpiresAt`（直取）、`idleExpiresAt`（派生自
`lastSeenAt + ADMIN_IDLE_TIMEOUT_MS`，`src/lib/auth/session.ts:7` = 2h）。

禁止字段全部只存在于服务端类型：`tokenHash` / `sessionVersion` / session 主键 `id` /
`revokedAt` 位于 `AdminSessionRecord`，`passwordHash` 位于 `AdminLoginIdentity`，后者带有
`Never serialize or return through an Admin contract` 注释（`src/lib/auth/types.ts:12`）。

### 2.2 Capability — PASS

四项能力齐备（`src/lib/auth/capabilities.ts:4-8`），`ADMIN_CAPABILITY_CONFIG` 中四项的
`requiresTwoFactor` 均为 `true`。三态可由 `hasAdminCapability()` + `twoFactorCompleted` 计算。

`promo:claim` 与 `revenue:view` 的 `defaultRoles: []`：未配置 env 时 `allowedRoles` 为空集，
`hasAdminCapability` 返回 `false` → 判 `denied`。**默认 disabled 的 capability 不会被误显示为可用**，
且是 fail-closed 而非依赖调用方记得判断。

### 2.3 2FA — PASS

`pending_expired` 字面量在 `src/**` 中不存在，但 `TwoFactorState` 的
`enabled` / `pendingEncryptedSecret` / `pendingExpiresAt` 三字段足以派生完整四态，
派生在契约层实现（阶段 B `projectTwoFactorState`）。

`attemptsRemaining` = `TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS`(5) − `challenge.attemptCount`。

已冻结语义未被本轮改动：
- 已用 Recovery Code 再次提交 → 不在 `listUnused` 候选集 → 通用 `two_factor_failed`；
- missing / consumed / expired challenge 在提交路径统一塌缩为 `two_factor_expired`
  （`src/lib/auth/two-factor.ts:112-119`、`:184-186`）。

### 2.4 Account operations — PASS

registry（`src/server/credentials/registry.ts`）只登记
`admin.channel_account.create|disable|enable` 与 `admin.credential.validate|supersede`。

**不存在 credential 级 disable/enable**，层级干净。`ChannelAccount.status` 为
`active | disabled` 两值（`CHANNEL_ACCOUNT_STATUSES`）。账号非 active 时，
worker 与 service 均返回 `account_inactive`（`worker/handlers/credential.ts:21`、`:65`）。

### 2.5 Credential metadata — PASS

`listCredentialMetadata`（`src/server/credentials/service.ts:64-67`）以显式 `select` 取七字段并
逐字段映射，`encrypted_secret` / `secret_fingerprint` / `key_version` 均未进入 select。
`fingerprintPrefix` 是独立列（`VarChar(16)`），不是完整 HMAC 指纹的切片。

状态精确四值，由 `CREDENTIAL_STATUSES` 单一真源 + PostgreSQL CHECK 双重约束；
`disabled` / `revoked` 在数据库层即被拒绝（P1-08 增量 migration 已实库验证）。

### 2.6 Credential operations — PASS

当前可用 `validate` / `supersede`；`add / replace` 受 Secret Ingress Gate 限制。

默认拒绝是**结构性**的而非分支判断：
- `resolveAdminRoute("/api/admin/credentials/replace", "POST")` → `null`
- `resolveAdminAction("admin.credential.replace")` → `null`
- `CREDENTIAL_TASK_TYPES.replaceGated`（`credential.replace.v1`）未注册进
  `createCredentialWorkerHandlers`
- `getCredentialTaskResult` 显式拒绝 `replaceGated` 任务类型（`service.ts:106`）

测试背书：`tests/backend/auth/p1-08b-production-contracts.test.ts:34-35`。

契约层以 `unavailable_pending_owner_gate` 表达，且**Owner gate 优先于 capability** ——
即便运营持有 `credential:manage` 也不会渲染成可用入口，避免「提交后才拿到模糊 404」。

### 2.7 CredentialQueuedResult — PASS

七字段齐备（`src/lib/credentials/contracts.ts:31-39`），`taskId` 与 `mutationRequestId` 均在。
幂等由 `genericTask.requestToken`（`credential:{op}:{requestId}`）唯一约束保证，重复提交返回同一
`taskId`；`operationScopeHash` 另做同账户同操作的 active 去重。刷新后可凭 `taskId` 恢复。

### 2.8 Redacted result — PASS

`CredentialRedactedResult` 仅六字段，无 `message`。task payload 只含
`channelAccountId` / `credentialId` / `actorId` / `mutationRequestId` / `operation`，
测试以正则断言其不含 `secret|ciphertext|fingerprint|jwt`。

### 2.9 错误码 — PASS（与 §3 必修项相关）

八个稳定码齐备。传播链：`AdminAccessError.code` → HTTP status + code，前端 switch code，
不依赖自由文本。`AdminAccessError.details` 为 `Record<string,string>`，契约层只放行
`capability` 与 `retryAfterSeconds` 两个结构化键。

值得记录的一个分层事实：**`credential_expired` 与 JWT 侧的 `credential_validation_failed`
走的是 `status:"success"` + `result.code`**（`worker/handlers/credential.ts:35-40`），
不是失败路径。只有前置条件失败才走 `{status:"failed", error:{code}}`。

### 2.10 Registry 与 Admin 接入 — PASS

八条 route + 五个 action 全部登记，capability 统一 `credential:manage`。
`requireFreshAdminServiceMutation`（`src/server/auth/guards.ts:179-197`）在 service 层异步重读
Session/identity，并核对 `entryId` 与 `requestId` 绑定，构成 mutation 二次鉴权。
UI 无需 import PostgreSQL Store、Prisma client、Worker handler 或解密器。

### 2.11 Secret Ingress Gate — CLEAN_DEFAULT_DENY

边界清楚：create/replace 默认拒绝；task payload 与 audit 无明文；Web 无主密钥
（`worker/credentials/crypto.ts` 只被 worker 引用）；Scheduler 经源码扫描断言无 handler、
无解密调用、无 key 环境变量。本轮不设计也不批准 Secret Ingress 方案。

---

## 3. 必修项（1 项，不改变已冻结的契约形状）

`getCredentialTaskResult`（`src/server/credentials/service.ts:104-108`）返回
`{ state, result }`，**丢弃了 `items[0].error`**。

- `generic_task_item.error` 列存在（`prisma/schema.prisma`），worker runtime 经
  `sanitizePersistedTaskError` 写入且已脱敏（`worker/runtime/worker.ts:157`）。
- 受影响的是**前置条件失败码**：`account_inactive`、`credential_missing`、
  `credential_ambiguous`，以及 superseded 情形的 `credential_validation_failed`。
- 主反馈回路（validate 的 expired / invalid）走 `result.code`，不受影响。

**要求 Codex 在 backend 补一行**：`getCredentialTaskResult` 的 `include` 保留 `error` 并一并返回。

契约层已按该形状冻结：`CredentialTaskStatusView.failureCode` 字段就位，
`projectCredentialTaskStatus` 接受 `error` 并只取 `code`、丢弃 `message`。**契约届时无需再改。**

> 若 Owner 按「错误码无法稳定映射」严格解读，这一条是 PASS 与 REVISE 之间唯一的分歧点，
> 可以推翻本文判定。判 PASS 的理由是：主反馈回路工作正常，缺口仅在前置条件失败，
> 且修复不改变本轮冻结的契约形状。

---

## 4. 复核期间实跑的验证

```
npm run test:backend  →  16 files / 96 passed / 0 failed
```

与后端报告声称的 96/96 一致。
