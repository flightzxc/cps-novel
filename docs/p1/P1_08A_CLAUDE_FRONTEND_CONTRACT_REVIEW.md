# P1-08A 前端契约复核

**任务：P1-08A-FRONTEND-CONTRACT-REVIEW**

**审计模式：`READ_ONLY_CONTRACT_REVIEW`**

**复核人：Claude（P1-09B 后台 UI 实施方 / `src/contracts` merge custodian）**

**分支：`feature/v0.1.0-p1-auth-foundation`**

**审计 HEAD：`93459d17c0aac1d00bdcfe1ef3690cdb6b81b5c6`**

**基线 main：`36c9ca6e8b39ec3041a845bb55d246412ac0ea79`**

**结论：`RESULT=P1_08A_FRONTEND_CONTRACT_REVIEW_REVISE`**

---

## 1. 复核范围与纪律

只判断当前 Auth / Credential 契约能否被 P1-09B 后台 UI 安全、明确地消费。未重新设计后端架构，未评估 TOTP/AES-GCM/scrypt 密码学实现，未审计 PostgreSQL migration、Store 实现、Worker fencing、P1-07 与前端视觉。

| 纪律项 | 状态 |
| --- | --- |
| 未修改任何代码 | ✅ 唯一写入为本文件 |
| 未提交 | ✅ |
| 未修改 `src/contracts/**` | ✅ |
| 未启动数据库 | ✅ |
| CPS 参考仓库只读 | ✅ `porcelain` = 0，HEAD = `d77c3b968285698529cf97c7f0f97b286d7a2a9c` |

独立复跑的验证（只读）：`npm run typecheck` = 0、`npm run lint` = 0、`npm test` = 0（**91 passed / 30 skipped**，跳过的是需要 PostgreSQL 的集成测试）。

---

## 2. 总体判断

Auth 内核的**安全形态**是扎实的，Owner 本轮条件确实闭环。问题集中在**前端可消费的表示层**：`src/contracts/` 目前只有一个 `README.md`，**零 DTO**；而 `P1_08_SCHEMA_DEPENDENCY_CHANGE_REQUEST.md` §6 的四行散文对其中四个 DTO 精度不足，无法据以实现。

判 `REVISE` 的依据是三项**明确的前端接入阻塞**，且三项都落在 Claude 不拥有的目录（`src/lib/credentials/`、`src/lib/auth/`），我无法通过自行新增 `src/contracts` DTO 绕开：

- **F-1** `CredentialMetadata.status` 与冻结的数据库枚举不一致——`revoked` 无法表达、`disabled` 永不出现；
- **F-2** challenge「已过期」与「已被消费」共用同一 error code，需求点名的页面态 11 与 13 在类型层面不可区分；
- **F-3** `CredentialMetadata` 缺 last validation time，且不存在任何 queued 结果类型，入队后前端无句柄可轮询。

其余缺口（AdminSession / Capability / TwoFactorState / ErrorEnvelope 等 DTO）**由我作为 `src/contracts` custodian 自行补齐即可**，因此列入 §7 变更申请而非阻塞项。

---

## 3. 已确认到位的部分

先记录做对的地方，复评时不必重查。

| 项 | 证据 |
| --- | --- |
| **challenge 绑定 sessionId** | `two-factor.ts:143-152` 显式比对 `challenge.sessionId !== context.session.id` 并抛 `two_factor_failed`；`createTwoFactorChallenge` 写入 `sessionId: context.session.id` 并回传。Owner 条件闭环 |
| **不会把 `twoFactorEnabled` 误当作本 Session 已完成 2FA** | `session.ts:53-58` 的 `twoFactorCompleted` 由 `identity.twoFactorEnabled && completedAt >= issuedAt && completedAt <= now` 独立算出；`AdminAuthContext` 同时携带两个字段，语义不重叠 |
| **manual key / recovery codes 一次性** | `startTwoFactorSetup` 返回 `{manualKey, otpauthUri, pendingExpiresAt}`；`confirmTwoFactorSetup` 返回 `{recoveryCodes}`。二者均为函数返回值，数据库只存密文与 hash，无任何读取明文的查询路径——刷新页面无法重新取回 |
| **`jwt_expired` 区分 idle / absolute** | `session.ts:15-17` 以 `details.reason = "idle_timeout" \| "absolute_timeout"` 承载 |
| **service authorization 不可伪造** | `guards.ts:32` 用模块级 `WeakSet` 登记 `Object.freeze` 后的票据，`requireAdminServiceMutation` 校验 `issuedAuthorizations.has(...)`。前端或业务层构造同形对象无法通过 |
| **默认拒绝** | `DEFAULT_ADMIN_REGISTRY.routes` / `.actions` 为空冻结数组；未登记 page/route/action 一律 404。`normalizePath` 处理 `\`、`%2f`、`%5c`、`..`、重复斜杠 |
| **四项 capability 均强制本 Session 2FA** | `ADMIN_CAPABILITY_CONFIG` 四项 `requiresTwoFactor: true`；`enforceCapability` 在 `requireAdminCapability` 之后必调 `requireAdminTwoFactor`；`requireAdminServiceMutation` 二次鉴权时再调一次 |
| **凭证模块无密钥面** | `tests/backend/auth/credential-contracts.test.ts:49-51` 断言源码中不出现 `encrypted_secret`、`decrypt`/`createDecipheriv`/`CHANNEL_CREDENTIAL_ENCRYPTION_KEY`、`node:crypto`。这是真测试，不是声明 |
| **Cookie 契约** | `__Host-` 前缀、`httpOnly`、`secure`、`sameSite: strict`、无 `domain`，且有测试断言 |

---

## 4. 七项逐条结论

### 4.1 Admin Session 前端契约 —— `ABSENT_BUT_DERIVABLE`

八项要求的可得性：

| 要求 | 可得性 | 来源 |
| --- | --- | --- |
| identity id / username / role | ✅ | `AdminIdentity` |
| capability snapshot | ⚠️ 需推导 | 见 §4.3 |
| 当前 Session 是否完成 2FA | ✅ | `AdminAuthContext.twoFactorCompleted` |
| Session idle expiry | ⚠️ 需推导 | `session.lastSeenAt + ADMIN_IDLE_TIMEOUT_MS`（常量已导出） |
| Session absolute expiry | ✅ | `session.absoluteExpiresAt` |
| revoked / expired 稳定错误语义 | ✅ | `jwt_invalid`（revoked/sessionVersion 不匹配/identity 非 active）、`jwt_expired` + `details.reason` |

**但没有任何投影函数。** guards 返回的是完整 `AdminAuthContext`，其中 `session: AdminSessionRecord` 直接携带 **`tokenHash`** 与 **`sessionVersion`** —— 正是禁止暴露的两个字段。`src/lib/auth/index.ts` 导出全部内部类型，无 DTO。

这不是 Codex 的缺陷（服务端持有完整记录是正确的），但意味着：**P1-09B 只要把 `context` 顺手传进 client component 的 props，Session token 的 SHA-256 就会进浏览器。** 因此 `src/contracts` 的 AdminSession DTO 必须是唯一出口，并在测试层面断言序列化结果不含 `tokenHash` / `sessionVersion`。这条我作为 custodian 会写死，不构成阻塞。

另注：`confirmTwoFactorSetup` 返回值携带 `nextSessionVersion`，同属内部控制字段，API 层必须剥离。

### 4.2 2FA 页面流程 —— 15 态中 14 态可实现

| # | 页面态 | 可实现 | 说明 |
| ---: | --- | --- | --- |
| 1 | 2FA disabled | ⚠️ | 状态可由 `TwoFactorState` 推出，但该类型含密文，缺脱敏投影——见下 |
| 2 | setup pending | ⚠️ | 同上（`pendingEncryptedSecret != null && pendingExpiresAt > now`） |
| 3 | setup pending expired | ⚠️ | 同上（`pendingExpiresAt <= now`） |
| 4 | setup enabled | ⚠️ | 同上（`enabled && confirmedAt != null`） |
| 5 | 一次性展示 manual key / otpauth URI | ✅ | `startTwoFactorSetup` 返回值 |
| 6 | 输入 TOTP 确认 setup | ✅ | `confirmTwoFactorSetup` |
| 7 | 一次性展示 recovery codes | ✅ | `confirmTwoFactorSetup().recoveryCodes` |
| 8 | 创建当前 Session 的 challenge | ✅ | `createTwoFactorChallenge` |
| 9 | 用 TOTP 完成 | ✅ | `completeTwoFactorChallenge({code})` |
| 10 | 用 recovery code 完成 | ✅ | `completeTwoFactorChallenge({recoveryCode})` |
| 11 | challenge expired | ⚠️ | 与 13 同码——见 **F-2** |
| 12 | challenge locked | ✅ | `two_factor_locked`（`attemptCount >= 5`） |
| 13 | challenge already consumed | ❌ | 与 11 同码——见 **F-2** |
| 14 | 当前 Session 已完成 2FA | ✅ | `twoFactorCompleted` |
| 15 | 新 Session 必须重新完成 2FA | ✅ | `completedAt >= issuedAt` 使新 Session 天然为 false |

态 1–4 的 ⚠️：判定逻辑本身可从 `TwoFactorState` 的字段推出，但 `TwoFactorStore.findByIdentityId` 返回的对象含 `encryptedSecret` 与 `pendingEncryptedSecret` 两个密文字段，**不存在脱敏读取路径**。我可以在 `src/app/**` 自行投影，但那等于把「四态派生」这段领域逻辑写在 UI 层。建议 Codex 侧提供 `getTwoFactorStateView(identityId, now)` 直接返回 `disabled | pending | pending_expired | enabled` + `pendingExpiresAt` + 剩余恢复码数量。**列为建议，不列为阻塞**（Claude 可自行绕开）。

### 4.3 Capability 与 UI 映射 —— `DERIVABLE_FROM_EXPORTED_PRIMITIVES`

四态判定所需的原语全部已导出：

| UI 态 | 判定 |
| --- | --- |
| capability 不存在 | `!(capability in ADMIN_CAPABILITY_CONFIG)` |
| 存在但当前 Session 未完成 2FA | `hasAdminCapability(...) && !twoFactorCompleted` |
| 默认 disabled | 无 env 覆盖且 `defaultRoles.length === 0`（`promo:claim`、`revenue:view` 属此类） |
| 可执行 | `hasAdminCapability(...) && twoFactorCompleted` |

**关键约束**：`hasAdminCapability` 读 `process.env`，客户端读不到。因此四态**必须**由服务端算好、经 Capability DTO 下发。这也是 §7 变更申请里 Capability DTO 必须是四态枚举而非布尔的原因。

安全边界表述无误：`enforceCapability` 在 route/action guard 上执行，`requireAdminServiceMutation` 在 service mutation 上二次执行——**前端隐藏按钮只改善 UX，不是权限控制**。P1-09B 会照此实现。

### 4.4 错误契约 —— `CODES_FROZEN_ENVELOPE_UNSPECIFIED`

16 项要求的 code 覆盖情况：

| 要求 | code | 状态 |
| --- | --- | --- |
| 401 jwt_missing / jwt_invalid | 同名 | ✅ |
| 401 jwt_expired 区分 idle/absolute | `jwt_expired` + `details.reason` | ✅（`details` 为无类型 `Record<string,string>`，DTO 需收紧） |
| 403 admin_capability_denied | 同名（`details.capability`） | ✅ |
| 403 admin_two_factor_required | 同名 | ✅ |
| 403 two_factor_failed / expired / locked | 同名 | ✅（但 expired 与 consumed 混用，见 F-2） |
| 403 Origin / mutation request id | `admin_origin_denied` / `admin_mutation_request_id_invalid` | ✅ |
| 404 未登记 page / route / action | `admin_route_not_registered` / `admin_action_not_registered` | ✅ |
| 429 admin_rate_limited | 同名（`details.retryAfterSeconds`） | ✅ |
| Credential queued / missing / expired / fingerprint conflict / validation failed / capability denied | `CredentialContractCode` 六值 | ✅ |

**但统一 envelope 不存在。** 全仓 grep `ErrorEnvelope` / `errorEnvelope` / `toEnvelope` / `NextResponse` / `toJSON` **零命中**。`AdminAccessError` 只有 `code` / `status` / `details` / 继承自 `Error` 的 `message` 与 `stack`，没有任何序列化器。

风险点：`message` 是自由文本（例如「Two-factor challenge is bound to another session」），且 `AdminAccessError` 是 `Error` 子类——直接 `JSON.stringify` 或交给框架默认错误处理，`stack` 与内部 message 都可能外泄。envelope 的形状与禁止字段清单必须冻结，见 §7。

envelope 归 `src/contracts/`（Claude custodian），**不列为阻塞**。

### 4.5 Registry 与接入 —— `OK`

| 项 | 状态 |
| --- | --- |
| Admin page registry | ✅ 14 个 frozen page roots，segment-safe 匹配，有测试 |
| `/api/admin/**` route registry | ✅ 机制完备，当前登记为空（正确的默认拒绝） |
| Server Action registry | ✅ 同上 |
| same-origin | ✅ `requireSameOrigin` 精确比对 origin，异常一律拒绝 |
| mutation request id | ✅ UUID 强校验，`x-request-id` |
| rate-limit port | ✅ `AdminRateLimitPort` 可选注入，429 携带 `retryAfterSeconds` |
| guard-issued service authorization | ✅ WeakSet 票据 |
| service mutation 二次鉴权 | ✅ `requireAdminServiceMutation` 重验 capability + 2FA |

P1-09B 的四项禁止（不直接 import Store / 不自造 authorization / 不绕 registry / 不在客户端做最终授权）在当前结构下都能自然遵守——Store 只以 port 形式注入，authorization 无法伪造，registry 是唯一入口。

**一条协作提醒**：`ADMIN_PAGE_ROOTS` 与 registry 都在 `src/server/`（Codex 独占），而页面本身在 `src/app/`（Claude 独占）。**Claude 每新增一个后台页面或 Server Action，都需要 Codex 改一次登记。** 建议现在就把这条写进分工文档并约定批量登记节奏，否则 P1-09B 会反复卡在跨 owner 的小改动上。

### 4.6 Credential UI 契约 —— `BLOCKED`

| 要求字段 | 状态 |
| --- | --- |
| credential id | ✅ `credentialId` |
| account id | ✅ `channelAccountId` |
| credential type | ✅ `credentialType` |
| status | ❌ **枚举不一致，见 F-1** |
| expiry | ✅ `expiresAt` |
| last validation time | ❌ **缺失，见 F-3** |
| fingerprint prefix | ✅ `fingerprintPrefix` |
| queued task state | ❌ **缺失，见 F-3** |
| 脱敏 validation result | ✅ `CredentialRedactedResult` |
| 脱敏错误码 | ✅ `CredentialContractCode` |

禁止暴露项全部满足：`CredentialMetadata` / `CredentialRedactedResult` / `CredentialWorkerEnqueueRequest` 三个类型中均无 `encrypted_secret`、解密密钥、完整 fingerprint、原始 token、完整上游响应、Worker 内部错误；`fingerprintPrefix` 是前缀而非全量。且有源码级测试守护。

### 4.7 `src/contracts` 变更申请精度 —— `INSUFFICIENTLY_PRECISE_FOR_4_DTOS`

`P1_08_SCHEMA_DEPENDENCY_CHANGE_REQUEST.md` §6 共四行。对照要求的 11 个 DTO：

| DTO | 申请精度 | 判定 |
| --- | --- | --- |
| AdminSession | 列了 identity id/username/role/capability snapshot/2FA 状态/expiry，禁止 token/hash | ⚠️ **`expiry` 是单数**，需拆成 idle 与 absolute 两个 |
| AdminIdentity | 折叠进 AdminSession | ✅ 可接受 |
| **Capability** | 仅「capability snapshot」 | ❌ **无形状**。四态需求表达不了 |
| TwoFactorState | `disabled/pending/pending_expired/enabled` + 剩余恢复码数量 | ✅ 足够 |
| TwoFactorSetupResult | 「manual key 只用于一次性成功响应」 | ⚠️ 无字段清单 |
| **TwoFactorChallenge** | **完全未提及** | ❌ 页面态 8–13 需要 |
| RecoveryCodes one-time | 「明文只用于一次性成功响应」 | ✅ |
| **ErrorEnvelope** | 「公开 401/403/404/429 与本轮冻结的 error code」 | ❌ **无字段形状，无禁止字段清单** |
| CredentialMetadata | 「只暴露 metadata」 | ⚠️ 见 F-1 / F-3 |
| **CredentialQueuedResult** | 仅「queued 状态」 | ❌ 无形状，无对应类型 |
| CredentialRedactedValidationResult | 「脱敏 Worker result」 | ✅ 已有实现 |

---

## 5. 阻断项（`REQUIRED_FIXES`）

### F-1 · `CredentialMetadata.status` 与冻结的数据库枚举不一致 🔴

| 项 | 内容 |
| --- | --- |
| 文件 | `src/lib/credentials/contracts.ts:22` |
| 当前定义 | `status: "active" \| "disabled" \| "superseded" \| "expired"` |
| 权威定义 | `src/domain/database-statuses.ts:5` `CREDENTIAL_STATUSES = ["active","superseded","revoked","expired"]`；字典 `db:public:channel_account_credential:status` 同值；数据库 `channel_account_credential_status_check` 同值 |
| 应改定义 | `status: "active" \| "superseded" \| "revoked" \| "expired"`，并解决下述 `disable` 语义问题 |
| 被阻塞页面 | **凭证列表页、凭证详情页**（`/channel-accounts`、`/settings` 下的凭证管理） |
| 业务原因 | 两个方向都错：`revoked` 是真实存在的数据库状态却**无法被 DTO 表达**——一条被吊销的凭证渲染不出来；`disabled` 在数据库里**永远不会出现**——UI 会写出一个死分支。<br><br>更要紧的是这不是拼写手滑：`P1_08B_CREDENTIAL_INTEGRATION_PLAN.md` 第 15 行把 **`disable` / `enable` 列为六个凭证操作中的两个**，而冻结的凭证枚举里没有任何对应状态。因此需要先回答：**`disable` 操作到底写哪张表的哪个字段？**<br>① 若写 `ChannelAccount.status`（该表确有 `active \| disabled`），那它是账户操作而非凭证操作，UI 的操作按钮应挂在账户层级；<br>② 若确实需要「凭证被停用但未吊销」这一态，则必须走 P1-05 的字典 + Migration 变更，不能只改 DTO。<br><br>这个问题不定，P1-09B 的状态芯片、操作按钮分组与二次确认文案都无法定稿。**这是三项阻断中唯一一项不是改几行代码就能解决的。** |

### F-2 · challenge「已过期」与「已被消费」共用同一 error code 🔴

| 项 | 内容 |
| --- | --- |
| 文件 | `src/lib/auth/two-factor.ts:111-119`（`validateChallenge`）与 `:184-186`（`challenge_unavailable` 分支） |
| 当前定义 | `consumedAt != null`、`expiresAt <= now`、事务返回 `challenge_unavailable` 三种情形**全部抛 `two_factor_expired`**，仅自由文本 `message` 不同（"Two-factor challenge expired" / "Two-factor challenge already consumed"） |
| 应改定义 | 二选一：① 新增 `two_factor_consumed` 到 `AdminAccessErrorCode`；② 在现有 code 上附 `details.reason = "expired" \| "consumed"`，与 `jwt_expired` 的 `details.reason` 做法保持一致 |
| 被阻塞页面 | **2FA 挑战页**的页面态 11（challenge expired）与 13（challenge already consumed） |
| 业务原因 | 两态都是需求点名的必需页面态，当前**在类型层面不可区分**。唯一的区分信号是 `message` 自由文本，而 message 恰恰是错误信封中不该原样透出、也不该被前端做逻辑判断的字段（§四 明确禁止暴露内部 message/stack）。<br><br>用户感知差异是实的：「挑战已过期，请重新发起」与「该挑战已被使用（你可能已在另一个标签页完成验证）」指向完全不同的用户动作——后者应引导刷新当前 Session 状态而非重新发起挑战。方案②的改动量是一行。 |

### F-3 · `CredentialMetadata` 缺 last validation time，且不存在 queued 结果类型 🔴

| 项 | 内容 |
| --- | --- |
| 文件 | `src/lib/credentials/contracts.ts:17-24`、`:35-42` |
| 当前定义 | `CredentialMetadata` 六个字段中无最近校验时间；`CredentialWorkerEnqueueRequest` 是**请求**不是**结果**；`CredentialRedactedResult` 中无任务 id / 入队时间 / 任务状态 |
| 应改定义 | ① `CredentialMetadata` 增 `lastValidatedAt: string \| null`（本轮即可加，是纯元数据）；② 新增 `CredentialQueuedResult`，最小字段 `{ code: "credential_validation_queued"; taskId: string; credentialId: string \| null; enqueuedAt: string; mutationRequestId: string }`（形状本轮冻结，实现可随 P1-08B 落地） |
| 被阻塞页面 | **凭证操作页**的「已排队等待 Worker 校验」态、凭证列表的「最近校验」列 |
| 业务原因 | `P1_08B_CREDENTIAL_INTEGRATION_PLAN.md` 第 16 行明确「返回 `credential_validation_queued`」，但当前契约下前端拿到的只是一个字符串码——**没有任何句柄可以轮询、展示或与审计记录对上**。运营点了「校验」之后只能看到一句「已排队」，无法知道是哪个任务、何时入队、现在到哪一步，也无法在页面刷新后恢复该状态。<br><br>`lastValidatedAt` 同理：凭证列表若不显示最近校验时间，运营无法判断某条凭证是「刚验过还好好的」还是「三个月没动过」——而这正是凭证管理页存在的主要理由。 |

---

## 6. 非阻断说明（`NON_BLOCKING_NOTES`）

1. **`AdminAuthContext` 携带 `tokenHash` / `sessionVersion`**，且无投影函数。服务端持有完整记录是正确的，但 `src/contracts` 的 AdminSession DTO 必须是唯一出口。我会在 DTO 落地时附一个断言序列化结果不含这两个键的测试。
2. **`confirmTwoFactorSetup` 返回 `nextSessionVersion`**，API 层必须剥离。
3. **缺 `getTwoFactorStateView` 之类的脱敏读取路径**：`TwoFactorState` 含两个密文字段。Claude 可在 `src/app/**` 自行投影，但四态派生属领域逻辑，放在 auth lib 更合适。建议而非要求。
4. **`AdminAccessError.details` 是无类型 `Record<string,string>`**。`jwt_expired.reason`、`admin_capability_denied.capability`、`admin_rate_limited.retryAfterSeconds` 三处语义已实际使用，建议在 DTO 层给出判别联合类型，避免前端按字符串键盲取。
5. **registry 跨 owner 协作**：见 §4.5 末段。
6. **registry 当前 routes/actions 为空**是正确的默认拒绝，不是缺陷——本条仅为避免复评时误判。

---

## 7. 最小 `src/contracts` 变更申请

以下由 Claude 作为 `src/contracts` merge custodian 实现并合并，Codex 审核。**本轮未创建任何文件。**

| DTO | 必需字段 | 禁止字段 | 不做会阻塞的页面 |
| --- | --- | --- | --- |
| `AdminSessionView` | `identityId`、`username`、`role`、`twoFactorCompleted`、`idleExpiresAt`、`absoluteExpiresAt`、`capabilities: AdminCapabilityView[]` | `tokenHash`、`sessionVersion`、`id`（Session 主键）、任何原始 token | 所有后台页面的顶栏与会话到期提示 |
| `AdminCapabilityView` | `capability`、`state: "unknown" \| "denied" \| "two_factor_required" \| "granted"` | 角色名单、env 变量名、user id 白名单 | 全部四类高风险操作入口的可见性与禁用态 |
| `TwoFactorStateView` | `state: "disabled" \| "pending" \| "pending_expired" \| "enabled"`、`pendingExpiresAt`、`remainingRecoveryCodes` | `encryptedSecret`、`pendingEncryptedSecret`、`keyVersion` | 2FA 设置页态 1–4 |
| `TwoFactorSetupResult` | `manualKey`、`otpauthUri`、`pendingExpiresAt` | 持久化后可重新读取的任何路径 | 2FA 设置页态 5–6 |
| `TwoFactorChallengeView` | `expiresAt`、`attemptsRemaining`、`boundToCurrentSession: true` | `tokenHash`、`sessionId`、`challengeId`（如非必要） | 2FA 挑战页态 8–13 |
| `RecoveryCodesOneTimeResult` | `codes: string[]`、`generatedAt` | `nextSessionVersion`、任何 hash | 2FA 设置页态 7 |
| `ErrorEnvelope` | `{ code, status, retryAfterSeconds?, reason?, capability? }` —— `code` 取 `AdminAccessErrorCode \| CredentialContractCode` 联合 | `message`（内部自由文本）、`stack`、原始 `Error`、数据库异常、token/hash、secret/ciphertext、完整 fingerprint、原始 Worker payload | 所有页面的错误处理 |
| `CredentialMetadataView` | 现有六字段 + `lastValidatedAt`；`status` 修正为四值（**依赖 F-1 定案**） | `encryptedSecret`、解密密钥、完整 fingerprint、原始 token | 凭证列表页、详情页 |
| `CredentialQueuedResultView` | `taskId`、`credentialId`、`enqueuedAt`、`mutationRequestId`（**依赖 F-3**） | Worker 内部状态、原始 payload | 凭证操作页排队态 |
| `CredentialRedactedValidationResultView` | 沿用 `CredentialRedactedResult` 五字段 | 完整上游响应、Worker 内部错误 | 凭证校验结果展示 |

`ErrorEnvelope` 的 `message` 一栏需特别说明：前端展示文案应由 `code` 在**前端侧**映射为 i18n 文案，**不透传服务端 message**。这既满足 §四 的禁止清单，也让文案归属留在 UI 层。

---

## 8. 最终输出

```text
RESULT=P1_08A_FRONTEND_CONTRACT_REVIEW_REVISE
REVIEWED_BRANCH=feature/v0.1.0-p1-auth-foundation
REVIEWED_HEAD=93459d17c0aac1d00bdcfe1ef3690cdb6b81b5c6
BASE_MAIN=36c9ca6e8b39ec3041a845bb55d246412ac0ea79
ADMIN_SESSION_DTO=ABSENT_BUT_DERIVABLE
TWO_FACTOR_STATE_DTO=ABSENT_NEEDS_REDACTED_PROJECTION
TWO_FACTOR_SETUP_FLOW=OK
SESSION_BOUND_CHALLENGE=OK_ENFORCED
RECOVERY_CODE_FLOW=OK_ONE_TIME
CAPABILITY_UI_MAPPING=DERIVABLE_FROM_EXPORTED_PRIMITIVES
ERROR_ENVELOPE=CODES_FROZEN_ENVELOPE_UNSPECIFIED
PAGE_ROUTE_ACTION_REGISTRY=OK_ROUTES_AND_ACTIONS_EMPTY_BY_DESIGN
SERVICE_AUTHORIZATION=OK_UNFORGEABLE
CREDENTIAL_METADATA=BLOCKED_STATUS_UNION_MISMATCH
CREDENTIAL_QUEUED_RESULT=ABSENT
CREDENTIAL_REDACTED_RESULT=OK
SECRET_EXPOSURE=NONE_IN_CREDENTIAL_MODULE / SESSION_RECORD_NOT_PROJECTED
SRC_CONTRACTS_CHANGE_REQUEST=INSUFFICIENTLY_PRECISE_FOR_4_DTOS
P1_09B_READINESS=BLOCKED_ON_3_ITEMS
REQUIRED_FIXES=F-1 CredentialMetadata.status 枚举对齐并定案 disable/enable 归属；F-2 challenge expired 与 consumed 可区分；F-3 lastValidatedAt 字段与 CredentialQueuedResult 形状
NON_BLOCKING_NOTES=6
NEXT_GATE=Codex 修 F-1~F-3 后复评；复评 PASS 后由 Claude 合并 §7 的 10 个 src/contracts DTO
```

---

## 9. 复核元信息

| 项 | 值 |
| --- | --- |
| 复核人 | Claude |
| 任务 | P1-08A-FRONTEND-CONTRACT-REVIEW |
| 审计模式 | `READ_ONLY_CONTRACT_REVIEW` |
| 审计 HEAD | `93459d17c0aac1d00bdcfe1ef3690cdb6b81b5c6` |
| 基线 main | `36c9ca6e8b39ec3041a845bb55d246412ac0ea79` |
| 只读验证 | typecheck 0 / lint 0 / test 0（91 passed、30 skipped） |
| `src/contracts` 现状 | 仅 `README.md`，零 DTO |
| 阻断项 | 3（F-1、F-2、F-3） |
| 非阻断说明 | 6 |
| 契约变更申请 | 10 个 DTO |
| 本轮新增文件 | `docs/p1/P1_08A_CLAUDE_FRONTEND_CONTRACT_REVIEW.md`（唯一，未提交） |
| 结论 | `RESULT=P1_08A_FRONTEND_CONTRACT_REVIEW_REVISE` |
