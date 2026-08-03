# P1-08 · CPS 同类模块只读调研（F-1 / F-2 / F-3）

**任务：`P1-08A-F1-F3 CPS Reference Investigation`**

**调研模式：`READ_ONLY_CPS_REFERENCE_RESEARCH`（调研轮已结束，本文件由后续 `DOCS_ONLY_ARCHIVAL` 轮归档）**

**调研人：Claude（Opus 5）**

**独立复核：Fable 5 — `VERDICT = AGREE_WITH_CORRECTIONS`**

**日期：2026-08-03**

**结论：`RESULT=P1_08_CPS_REFERENCE_RESEARCH_COMPLETE`**

---

## 0. 文档性质与合并说明

本文件是**唯一自洽的最终版**。它把三部分合并成一份：CPS 主调研报告、Fable 5 的
`AGREE_WITH_CORRECTIONS` 复核、以及复核后的净修订。

**Fable 5 的修订已直接覆盖主报告中对应的旧结论，本文件不保留任何被推翻的旧说法。**
被覆盖的具体条目在 §11「Fable 5 复核摘要」中逐条列出，仅作审计追溯用，不构成并行有效的结论。

---

## 1. 调研纪律与基线

### 1.1 目的

确认 F-1（账户状态与 Credential 状态）、F-2（TOTP / 恢复码 / Session Challenge）、
F-3（渠道账户上游 JWT Credential 与校验任务）三项在 CPS 短剧项目中的**真实业务语义、
状态机、约束、DTO 与 UI 接入方式**，据此决定小说项目是复用还是显式偏离。

### 1.2 方法纪律

- 禁止基于文件名或变量名直接下结论；每条结论沿真实调用链追踪：
  `UI / Action → service → database write → Worker 或外部校验 → DTO / API result → UI rendering`。
- 每条结论附文件路径、符号名、行号、调用方向、实际写入表/字段与对应测试；无法确认者明确写
  `UNKNOWN`。
- 不以小说项目当前定义作为正确答案；小说侧只是待对照对象。

### 1.3 基线

| 项 | 值 |
| --- | --- |
| CPS 只读参考仓库 | `cps项目/cps-admin-v811-search-ux` |
| CPS HEAD | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` |
| CPS 工作区 | clean（`git status --short` 为空） |
| 小说对照仓库 | `cps海阅/cps-novel-p1-08a` |
| 小说分支 | `feature/v0.1.0-p1-auth-foundation` |
| 小说 HEAD | `93459d17c0aac1d00bdcfe1ef3690cdb6b81b5c6` |
| 小说工作区 | 1 个未跟踪文件 `docs/p1/P1_08A_CLAUDE_FRONTEND_CONTRACT_REVIEW.md`（调研轮未读写未删） |

### 1.4 调研轮执行纪律（已完成，不追溯修改）

调研轮全程零写入：未 commit / push / clean / reset / checkout / stash，CPS 与小说两仓皆只读。
本文件的落盘与提交属于其后独立授权的 `DOCS_ONLY_ARCHIVAL` 轮，不改变调研轮的只读性质。

---

## 2. F-1 · 账户状态与 Credential 状态

### 2.1 真实状态转换矩阵

| 实体 | 当前状态 | 操作 | 写入表 | 写入字段 | 新状态 | 是否可逆 | Worker 行为 | UI 所属层级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ChannelAccount | — | create | `channel_account` + `channel_account_change_log` | channelId / businessId / accountName；action=`create` | `active` | — | 可被选中 | Account |
| ChannelAccount | active | **disable**（reason 必填） | `channel_account` + change_log | `status='disabled'`；action=`disable` | `disabled` | ✅ enable | 全能力拒绝 | Account |
| ChannelAccount | disabled | **enable**（reason 可选） | 同上 | `status='active'`；action=`enable` | `active` | ✅ | 恢复 | Account |
| Credential | — | **update JWT / replace**（reason 必填） | `channel_account_credential` ×2 + `channel_account` + change_log | 旧 active→`superseded`；新行 encryptedSecret / secretFingerprint / expiresAt / lastValidatedAt=now；account 的 jwtStatus / jwtExpiresAt / lastValidatedAt；action=`update_jwt` | 新行 `active`（JWT 有效）或 `expired`（JWT 已过期）；JWT invalid → 抛错**零写入** | 旧行不可逆 | 使用新 active | Credential |
| Credential | active / expired / invalid | **validate**（无 reason） | credential + account + change_log | status / expiresAt / lastValidatedAt=now；account 三字段；action=`validate` | `active` \| `expired` \| `invalid` | ✅ 幂等可重跑 | resolver 取 `status='active'` | Credential |
| Credential | active | **supersede**（reason 必填） | credential + change_log | `status='superseded'`；action=`supersede_credential` | `superseded` | ⚠️ 见 §2.2 | resolver 查不到 → `credential_missing` | Credential |
| Credential | 非 active | supersede | — | — | 抛「凭证不是 active，无需作废」**零写入** | — | — | — |

**证据**：`src/lib/channel-account/service.ts:119-505`、
`src/app/(admin)/channel-accounts/actions.ts:66-200`、
`prisma/migrations/20260607100000_channel_account_credentials/migration.sql`。
**测试**：`tests/channel-account-supersede-credential.test.ts:398-541`（6 例）、
`tests/channel-account-credentials.test.ts:323-521`。

### 2.2 ⚠️ CPS 的一条非显然缺陷（小说不得照抄）

`validateChannelAccountJwtCore` 取「**最新一条** credential，**不过滤 status**」
（`service.ts:284-296`，`findFirst` + `orderBy createdAt desc`，无 status 条件），
随后 `:324-331` 把该行写成 `nextCredentialStatus`。因此：

> 对一条刚被作废、且仍是最新的 credential 点「验证」，只要 JWT 未过期，
> 它会从 `superseded` **复活成 `active`**，且**不需要运营重新输入 JWT 明文**。

`:312-321` 还会主动把其他 active 行打成 `superseded` 给复活行让位（以保住部分唯一索引），
说明复活是未被考虑的副作用而非设计意图。

**CPS UI 文案的准确表述**：`channel-account-forms.tsx:176` 原文为
「此操作不可撤销 —— 除非运营手上仍持有该 JWT 明文，可通过重新更新 JWT 恢复。」
即：**CPS 文案已承认「持有明文时可通过重新更新恢复」这一条路径；但 validate 还存在
另一条无需重新输入明文的 superseded 复活路径，该路径未在 UI 文案中披露。**

### 2.3 逐项回答

1. **Account 状态**：`active` | `disabled`（仅 2 值，`service.ts:369` 入参类型约束）。
   另有正交第二维 `jwtStatus`：`unknown`（默认）/ `valid` / `expired` / `invalid` —— 派生健康镜像，
   只由 `service.ts:232` 与 `:336` 写；worker 与 enqueue 侧只读。
2. **Credential 状态**：实际写入 4 值 —— `active` / `superseded` / `expired` / **`invalid`**。
   `invalid` 来自 `:309-310` 的 `validation.status === "valid" ? "active" : validation.status`，
   而 `validateJwtLocally` 返回 `valid | expired | invalid`。
3. **定义位置**：Schema = 裸 `String @default("active")`，无 enum；Migration = **无 CHECK**；
   TypeScript = **无集中常量**（account 只有 `:369` 的行内 union，credential 全是散落字符串字面量）；
   DTO = `redactCredentialForOutput` 原样透传 `status: string`；UI = 原样渲染 +
   `classifyJwtCredentialStatus` 派生；Worker = `where status:'active'`。
   → **CPS 没有 credential 状态词表的单一真源，这是弱点，不是范本。**
4. **「停用」按钮作用于**：**仅 Account**。`service.ts:415-428` 有明确注释：
   `setChannelAccountStatusCore`（禁用账号）**从不触碰** `channel_account_credential` ——
   账号被禁用后凭证行仍是 `active`。
5. **「启用」如何恢复**：把 `account.status` 写回 `'active'`，别无其他。
6. **被停用时**：credential 原状态**完全保留**；同步 / 推广领取 / 收入同步 / 预览**全部停止**，
   但**不是 resolver 拒绝** —— `resolveChannelAccountBearerJwtCore`（`:540-567`）的 where 只有
   credential 层的 `status:'active'`，**不查 account.status**。account 闸由每个调用方各自重复实现：
   `changdu-getvideoinfo.ts:553` → `channel_account_disabled`；`changdu-dry-run.ts:308` →
   `permission_denied`；`changdu-promo-claim-enqueue.ts:222`；`changdu-revenue/sync.ts:306`；
   `beidou-config.ts:330`；`changdu-preview-account-resolver.ts:218` → `account_inactive`。
7. **replace 如何处理旧记录**：同事务内 `updateMany` 把旧 active 全部降为 `superseded`
   （`:205-214`），再 insert 新行。**从不删除。**
8. **词表使用情况**：`superseded` ✅、`expired` ✅、`invalid` ✅（未在字典登记）；
   **`revoked` 全仓零命中**（src / worker / prisma / migrations 全扫）；credential 从不用 `disabled`。
9. **revoked 是否可恢复**：N/A —— CPS 无此状态。
10. **superseded 归属**：**两者皆是** —— 既是 replace 的内部结果，也是显式运营操作。
    v7.10.0 新增 `supersedeChannelAccountCredentialCore` 正是因为 disable 不碰凭证这个缺口。
11. **数据库查询检查哪一层**：**只检查 `Credential.status`**（在 resolver 内部），
    `Account.status` 是**各调用点独立实现的第二道闸**。两层不在同一个查询里。
12. **UI 状态芯片与按钮的层级**：状态列 = `account.status` 原样；JWT 列 = 派生 badge +
    原始 `account.jwtStatus` + 掩码指纹；启用 / 禁用按钮 = Account 层；作废凭证按钮 =
    Credential 层，且仅当 `credential.status === 'active'` 才渲染（`page.tsx:135-161`）。
13. **账户停用 + Credential 仍 active**：**合法，且有源码注释背书**（`service.ts:420-423`）。
14. **Credential 单独停用 + 账户仍 active**：**合法**，action 返回 `owningAccountStillActive`
    并主动警告运营「其同步将因缺少凭证而失败」（`actions.ts:281-283`）。
15. **CPS 数据字典**：`docs/governance/database-governance.md:434-472` 记了两张表与字段，
    但 credential status **只写「默认 active」未枚举取值**（`:466`）；反而 `jwt_status` 枚举了（`:445`）。
    约束语义段只提加密 key 与脱敏要求，**未记录部分唯一索引**。

### 2.4 F-1 结论块

```
F1_CPS_ACCOUNT_STATUSES=active|disabled  (+正交维度 jwt_status: unknown|valid|expired|invalid)
F1_CPS_CREDENTIAL_STATUSES=active|superseded|expired|invalid   (NO revoked, NO disabled)
F1_DISABLE_TARGET=CHANNEL_ACCOUNT_ONLY
F1_ENABLE_TARGET=CHANNEL_ACCOUNT_ONLY
F1_REPLACE_TRANSITION=old_active→superseded + insert_new(active|expired)，同事务，永不删除
F1_REVOKE_TRANSITION=NOT_PRESENT_IN_CPS
F1_WORKER_GATING=TWO_INDEPENDENT_LAYERS（resolver 只管 credential.status；account.status 由各调用点重复实现）
F1_UI_OWNERSHIP=account chip=账户层；JWT badge=credential+jwtStatus 派生；enable/disable=账户按钮；supersede=凭证按钮
F1_DICTIONARY_CONSTRAINT=无 CHECK；仅部分唯一索引 (channel_account_id, credential_type) WHERE status='active'；字典未枚举 credential 状态
F1_RECOMMENDATION=FOLLOW_CPS_WITH_EXPLICIT_NOVEL_DIVERGENCE
```

**偏离理由（非「设计上更合理」）**：

- 小说 `src/lib/credentials/contracts.ts:22` 的 DTO 写 `"active" | "disabled" | "superseded" | "expired"`，
  其中 `disabled` **两头都错**：CPS 从不停用 credential，且小说自己冻结的 CHECK
  （`migration.sql:1219`，`CHECK (status IN ('active','superseded','revoked','expired'))`）也拒绝该值。
  **DTO 声明了一个数据库拒绝的状态，是硬 bug，不是设计选择。**
- 小说有 `revoked` 而 CPS 无；CPS 有 `invalid` 而小说 CHECK 无。**两边不是超集关系**，须 Owner 定稿（O1）。
- P1-08B 六操作中的 `disable` / `enable` 必须钉死为 **account 级** —— 当前文档表述含混地列在
  「Credential 后台操作」之下。

---

## 3. F-2 · TOTP、恢复码与 Session Challenge

CPS **三层俱全**，但形状与小说不同。三者必须严格区分，不得混谈。

### 3.1 A · TOTP 生命周期

Secret 存于 `User.twoFactorSecretEncrypted`（AES-256-GCM），pending 存于
`twoFactorPendingSecretEncrypted` + `twoFactorPendingExpiresAt`（TTL 10 分钟，`two-factor-settings.ts:4`）。
参数：SHA1 / 6 位 / 30 秒 / **window=1**（`totp.ts:3-7`，otpauth 库）。**单个 code 不落库。**

确认 setup 时同事务：启用 secret + 清 pending + 整体替换恢复码 + `sessionVersion` +1
（`two-factor-settings.ts:182-197`）。

### 3.2 B · Recovery Code 生命周期

表 `two_factor_recovery_codes`(id, user_id, **code_hash UNIQUE**, used_at, created_at)，
索引 `(user_id, used_at)`。默认 **10 个**（`recovery-codes.ts:4`），格式 `XXXX-XXXX-XXXX` 大写 hex，
**bcrypt cost 12**。**绑 identity（user_id），不绑 session。**
无 `rotatedAt` 字段 —— 轮换时间记在 `User.twoFactorRecoveryCodesRotatedAt`。

**消费**（`two-factor-login.ts:458-501`）：候选集为 `where { userId, usedAt: null }` →
命中则写 `usedAt = now`，**并且 `user.sessionVersion` +1**（`:485-501`）。

**轮换** `regenerateRecoveryCodesForUser`：`deleteMany` + `createMany` + `sessionVersion` +1
（**硬删除，不是标记已用**）。

### 3.3 C · Session Challenge 生命周期

表 `two_factor_challenges`(id, user_id, **token_hash UNIQUE**, expires_at, consumed_at,
attempt_count, created_ip, created_user_agent, created_at)。

**没有 `session_id` 字段。** Challenge 在**密码阶段、session 存在之前**就创建
（`two-factor-login.ts:340-352`），原始 token 放 httpOnly cookie `cps-2fa-challenge`
（path=`/login`，5 分钟，`login/actions.ts:75-81`）。TTL 5 分钟，最大尝试 5 次。

### 3.4 关键：CPS 存在两条粒度不同的路径

| 路径 | 函数 | 区分度 |
| --- | --- | --- |
| 页面渲染 | `getTwoFactorChallengeStatus`（`:362-395`） | **5 态**：missing / **consumed** / expired / locked / valid |
| 提交校验 | `completeTwoFactorChallengeLogin`（`:438-446`） | **consumed 与 expired 塌缩为同一码** `two_factor_expired`；challenge 不存在（missing）也塌缩到同码 |
| 前端渲染 | `2fa/page.tsx:29-41` | 再塌缩一层：expired \| consumed \| missing → 同一句话；locked 单独一句 |

**这直接回答任务的警示要求：**

> 「Recovery Code 已消费」与「Session Challenge 已消费」在 CPS 里是两个完全不同的东西 ——
> 前者**根本不产生任何 consumed 信号**（静默排除出候选集，落通用失败码），
> 后者有 `consumed_at` 字段，但在提交路径上被**故意**与 expired 合并。

### 3.5 事务边界

单个 `db.$transaction`（`:420-516`）内完成：challenge 查询 → TOTP 或恢复码验证 →
恢复码 `usedAt` → `sessionVersion` +1 → challenge `consumedAt`
（用 `updateMany where { id, consumedAt: null }` + `count !== 1` 做 CAS，`:503-513`）。

`attemptCount` 递增**故意置于事务之外**的 catch 块（`:517-528`），以便在回滚后仍然生效，
且**只对 `two_factor_failed` 递增**，expired / locked 不递增（`:521-522`）。

### 3.6 错误码与传播链

稳定码只有 3 个。传播链：`TwoFactorLoginError` 子类携 `.code`（`:113-138`）→
`auth.ts:34-52` / `:117-133` 转成 NextAuth `CredentialsSignin` 子类 →
前端 `2fa/actions.ts:82` 读 `error.code` 走 switch（`:39-49`）。

**CPS 前端不解析 `Error.message`，只 switch `error.code`。** 该做法值得原样复用。

### 3.7 F-2 结论块

```
F2_CPS_TOTP_MODEL=User 列存密文 + pending 列(10min TTL)；otpauth SHA1/6/30/window=1；code 不落库
F2_CPS_RECOVERY_CODE_MODEL=独立表；10 个；bcrypt(12)；code_hash UNIQUE；used_at；绑 user_id；轮换=硬删重建；使用时 sessionVersion+1
F2_CPS_CHALLENGE_MODEL=独立表；绑 user_id + httpOnly cookie；无 session_id；pre-session 创建；TTL 5min；max 5 attempts
F2_RECOVERY_CODE_CONSUMED_SEMANTICS=SILENT_MISS_GENERIC_FAILURE（排除出候选集 → two_factor_failed + attempt++，无专属码，防枚举）
F2_TOTP_EXPIRY_SEMANTICS=NOT_A_DISTINCT_STATE（window=1 即 ±30s；窗口外 → two_factor_failed）
F2_CHALLENGE_CONSUMED_SEMANTICS=数据层有独立 "consumed"（页面路径）；提交路径塌缩为 two_factor_expired
F2_CHALLENGE_EXPIRED_SEMANTICS=two_factor_expired，与 consumed 和 missing 共码
F2_ERROR_CODES=two_factor_failed | two_factor_expired | two_factor_locked（另有登录阶段 invalid_credentials | too_many_attempts | turnstile_failed）
F2_TRANSACTION_BOUNDARY=单事务{恢复码 usedAt + sessionVersion++ + challenge consumedAt(CAS)}；attemptCount 故意在事务外
F2_RECOMMENDATION=FOLLOW_CPS_WITH_EXPLICIT_NOVEL_DIVERGENCE
```

### 3.8 小说侧对照

**已与 CPS 一致、无需改动**：challenge consumed 与 expired 共用 `two_factor_expired`
（小说 `two-factor.ts:112-114`、`:184-186` 同样塌缩）；TTL 5 min / pending 10 min /
max 5 attempts / 恢复码 10 个 / TOTP window=1 · period=30 · digits=6 全部对齐。

**已登记偏离（Owner 2026-08-03 批准，不属于待决策项）**：

- `CHALLENGE_SESSION_BINDING=REQUIRED`（CPS 绑 user_id + cookie）
- `RECOVERY_CODE_HASH=VERSIONED_SCRYPT`（CPS 是 bcrypt 12）
- `ZERO_NEW_AUTH_DEPENDENCIES`（小说手写 TOTP，CPS 用 otpauth 库）

这些源于**模型级差异**：**CPS 是登录时一次性 2FA + NextAuth JWT cookie；
小说是长生命周期 DB session + step-up 2FA。CPS 根本没有 session 级的完成时间戳，也没有
`admin_session` 表。** 因此 CPS 的 challenge 表形状不能逐字段照抄。

**实现缺口（非偏离，见 §8 C2 与 NB5）**：`sessionVersion` 在「使用恢复码」时的推进，
小说规范已明确要求，当前 P1-08A 合同未强制体现。

---

## 4. F-3 · 渠道账户上游 JWT Credential 与校验任务

### 4.1 身份界定

`credential_type` 默认 `bearer_jwt`，装的是畅读 / 北斗**上游** bearer token，与后台登录 JWT 完全无关。
代码上靠模块分离区分：上游在 `src/lib/channel-account/*`，后台在 `src/lib/auth.ts` +
`two-factor-login.ts`。`jwt.ts` **只存在于 channel-account 目录下**，后台侧无同名文件 ——
**不存在命名混淆**。

### 4.2 校验模式：同步纯本地

`validateJwtLocally`（`jwt.ts:83-109`）只做 base64url 解 payload 取 `exp`，
**不验签名、不发任何网络请求**。测试背书：`tests/channel-account-credentials.test.ts:486`
「validate JWT is local-only and marks expired tokens expired」。

**没有 worker、没有 task、没有 taskId。** `credential_validation` 在 CPS 全仓零命中。

因此 `credential_validation_queued` 在 CPS **没有任何对应物**。被入队的是同步作业
（`changdu_source_sync` 等），JWT 状态只是**入队前置闸**（`sync/actions.ts:512-516`；
`changdu-promo-claim-enqueue.ts:231-234`），执行时在 adapter 层再查一次。

### 4.3 到期时间：既是 metadata 又是 status

`exp` 兼容秒 / 毫秒（阈值 1e12，`jwt.ts:11`）、拒绝年份 > 9999（`:78`）；
写入 `credential.expires_at` + 镜像到 `account.jwt_expires_at`；
同时映射成 `status='expired'`（`:194`、`:310`）。
另外在**读取时**再派生一个**不持久化**的 7 天 `expiring_soon` 预警带（`jwt.ts:10`、`35-37`）。

### 4.4 `last_validated_at` 写入时机

**只在两处写**：更新 JWT、显式点验证。**任务使用时不写、同步成功不写**
（`last_synced_at` 是另一个字段，该模块从不写它）。
UI「最近验证」列取的是 `account.lastValidatedAt`（`page.tsx:144`），不是 credential 的。

### 4.5 刷新后 UI 恢复

纯 server component + 每次 mutation 后 `revalidatePath('/channel-accounts')`
（`actions.ts:78 / 101 / 122 / 141 / 164 / 192`）。状态每次从 DB 重新派生。
**无客户端轮询、无 task handle 可续接。**

### 4.6 ⚠️ 密钥边界 —— 对小说最关键的一条

**CPS 是单体：Web 与 Worker 共用同一个 `CHANNEL_CREDENTIAL_ENCRYPTION_KEY`，
Web 完全可以 SELECT `encrypted_secret` 并解密。**
`resolveChannelAccountBearerJwtCore` 就跑在 Next server 进程里；
`src/app/api/preview/changdu/[catalogItemId]/route.ts` 直接 import preview-account-resolver，
解密发生在 Next 进程内。**没有 DB 角色分离，没有独立 Scheduler 进程。**

指纹用**同一把 key** 做 HMAC-SHA256（域分隔 `channel-account-credential:v1`），
格式 `hmac-sha256:<hex>`。

CPS 真正做到的只是**输出侧脱敏**：`redactCredentialForOutput`（`:58-76`）不返回密文、
指纹只回**末 12 位**（`maskCredentialFingerprint`，`jwt.ts:111-114`）；
change log 只存掩码指纹（`:480`）；输入框 `type="password"`；页面文案「JWT 明文不会回显」。
治理规则见 `database-governance.md:472` / `:1769`。

**结论：P1-08B 的「Worker 是唯一解密执行体 / Web 不得 SELECT 密文 / Scheduler 不持密钥」
在 CPS 没有先例，严格强于 CPS。这一条不能拿 CPS 当证据。**
该边界已由小说自身变更申请 §2（`P1_08_SCHEMA_DEPENDENCY_CHANGE_REQUEST.md:51`）明确登记，
无需新开 divergence record，仅需在 parity matrix 标注（见 §7 E4）。

### 4.7 错误码：CPS 无统一体系

三套并存且互不相通：

| 层 | 形态 |
| --- | --- |
| 后台 action | 自由中文字符串 `{ success:false, error }`，**无稳定码**（「凭证不存在」/「凭证不是 active，无需作废」/「JWT 格式无效…」） |
| adapter | `jwt_missing` / `jwt_expired` / `invalid_channel_account` / `channel_account_disabled` / `invalid_channel_app` |
| worker & preview-resolver | `credential_missing` / `credential_expired` / `credential_ambiguous`(`:234`) / `credential_invalid`(`:265`) / `decrypt_failed`(`:247`) / `account_missing` / `account_ambiguous`(`:213`) / `account_inactive`(`:218`) |

对小说 6 个 `CredentialContractCode` 的逐条对照：

| 小说码 | CPS 对应 |
| --- | --- |
| `credential_missing` | ✅ 存在（worker 层） |
| `credential_expired` | ✅ 存在 |
| `credential_validation_failed` | ≈ CPS `credential_invalid` |
| `credential_fingerprint_conflict` | ❌ 无码；CPS 只返回中文串 + DB UNIQUE 冲突 |
| `credential_validation_queued` | ❌ 无对应物（CPS 无异步校验） |
| `credential_capability_denied` | ≈ 有 `requireAdminCapability('credential:manage')` 检查，但只是消息不是码 |

**小说缺了 CPS 有的两个**：`credential_ambiguous`（>1 条 active 时的纵深防御，
是对部分唯一索引失效的兜底）与 `account_inactive`（F-1 已证账号状态是独立闸）。

### 4.8 CPS 的第二套 credential 模型（更新、更接近小说目标）

`ChangduTotalRevenueCredential`（v7.10.0）：状态
`pending_verification | active | superseded | expired | rejected`（`schema.prisma:1172` 注释），
多出 `verificationStatus` / `verifiedAt` / `verificationMessage` / `supersededAt` 四字段，
且**确实调上游 GetUserInfo 校验** —— 但**仍是同步的，仍无 worker / task**。

它另有独立的 `changdu_total_revenue_active_fingerprint` 表（`schema.prisma:1249`）用 UNIQUE 索引
做指纹闩（对应小说的 `channel_credential_active_fingerprint`），
并有 insert-before-delete 的 reservation 维护模式（`database-governance.md:1536`）——
**该模式值得小说复用。**

### 4.9 F-3 结论块

```
F3_IS_UPSTREAM_JWT_CREDENTIAL=YES
F3_CPS_METADATA_FIELDS=id, channel_account_id, credential_type, encrypted_secret, secret_fingerprint,
                       expires_at, last_validated_at, status, created_at, updated_at
                       （+镜像到账户：jwt_status, jwt_expires_at, last_validated_at, last_synced_at）
                       CPS 无 key_version、无 fingerprint_prefix（存全量指纹，读取时掩码末 12 位）
F3_LAST_VALIDATED_AT=仅「保存时」与「手工校验时」；任务使用 / 同步成功均不写
F3_EXPIRY_SOURCE=JWT 自身 exp（本地解码，不验签；兼容秒/毫秒）→ 同时落 metadata 与 status='expired'；
                 读取时再派生不持久化的 7 天 expiring_soon
F3_VALIDATION_MODE=SYNCHRONOUS_LOCAL_ONLY（无网络、无 Worker、无两阶段）
F3_ENQUEUE_RESULT=N/A（校验不入队；JWT 状态是同步作业的入队前置闸，执行时二次校验）
F3_TASK_HANDLE=N/A（校验无 taskId；同步作业返回 BatchTask id）
F3_UI_RECOVERY_AFTER_REFRESH=server component + revalidatePath，每次从 DB 重派生；无轮询无 task 续接
F3_SECRET_BOUNDARY=CPS_HAS_NO_PROCESS_SEPARATION（Web 可解密；单 key 共享；仅输出侧脱敏 + 治理规则）
F3_ERROR_CODES=三套并存不统一（action 层无码；adapter 层 5 个；worker 层 8 个）
F3_RECOMMENDATION=FOLLOW_CPS_WITH_EXPLICIT_NOVEL_DIVERGENCE
                  （密钥边界一项为 CPS_HAS_NO_EQUIVALENT / NOVEL_SECURITY_BOUNDARY_STRONGER_THAN_CPS）
```

---

## 5. CPS_REUSABLE_RULES

```
R1  单账户/类型「单 active」用部分唯一索引 WHERE status='active'（CPS 与小说已一致）
R2  replace = 同事务内 旧 active→superseded + insert 新行，永不删除
R3  凭证操作强制 reason + append-only change log，日志只存掩码指纹
R4  输出侧 redact 函数集中一处（redactCredentialForOutput），DTO 永不含密文/全量指纹
R5  前端只 switch 稳定 error.code，绝不解析 Error.message
R6  恢复码已用 → 静默排除出候选集 + 通用失败码（防枚举），不给专属码
R7  challenge 消费用 updateMany(consumedAt:null) + count!==1 做 CAS
R8  attemptCount 递增置于事务外，且只对「验码失败」递增，expired/locked 不递增
R9  到期既写 metadata 又映射 status，读取时另派生不持久化的预警带
R10 指纹闩 reservation 采用 insert-before-delete（v7.10.0 模式）
```

---

## 6. NON_REUSABLE_SQLITE_OR_LEGACY

```
N1 状态列无 CHECK、无集中常量（小说已用 CHECK + database-statuses.ts，更优，勿回退）
N2 account.status 闸在每个调用点重复手写（应收敛进 resolver / 单一 guard）
N3 validate 不过滤 status 导致 superseded 可复活（CPS 缺陷，勿抄；见 §2.2 与 NB1）
N4 三套互不相通的错误码体系
N5 Web 与 Worker 共享解密 key、无 DB 角色分离
N6 credential 全量指纹落库（小说的 fingerprint_prefix + key_version 更优）
N7 CPS 字典未枚举 credential 状态取值
```

---

## 7. 偏离登记（已应用净修订）

### 7.1 NOVEL_UNREGISTERED_DIVERGENCES

```
D1 🔴 contracts.ts:22 DTO 含 "disabled" —— CPS 无此语义，且小说自己冻结的 CHECK
      (migration.sql:1219) 拒绝该值。硬错误，须修（见 C1）。
D3 🟡 CredentialContractCode 缺 credential_ambiguous 与 account_inactive
      （CPS 两者都有且各有用途，见 §4.7）。
D4 🟡 credential_validation_queued 在 CPS 无对应物 —— 这是小说的新架构，不是 parity。
      字典应标 NOVEL_ORIGINAL 而非 CPS_PARITY。
D5 🟡 CHANGDU 侧「invalid」状态：CPS 有、小说 CHECK 无，字典未记录该取舍（见 O1）。
```

> **D2 已按最终修订移出本列表。** 原判「使用恢复码时未推进 sessionVersion = 未登记偏离 / 安全回归」
> 不成立：小说变更申请 `P1_08_SCHEMA_DEPENDENCY_CHANGE_REQUEST.md:41` 已明写
> 「注销、改密**或恢复码使用后**通过 version 前进使旧 Session 失效」。
> 规范已定，当前只是 **P1-08B 实现与验收缺口**，改列为 `REQUIRED_CODE_CHANGE / ACCEPTANCE_ITEM`（C2）。

### 7.2 EXPLICIT_DIVERGENCE_REQUIRED

```
E1 credential 状态词表最终取值（revoked 留否 / invalid 收否）—— 见 O1
E2 disable/enable 的作用层级钉死为 account 级，并在 P1-08B 文案中改掉含混表述 —— 见 C4
E3 challenge 绑 session（Owner 2026-08-03 已批准）：需在字典留 divergence record 指明 CPS 反例
   （CPS 绑 user_id + cookie、pre-session 创建）。不属于 Owner 待决策项。
E5 异步校验 + taskId：P1-08B 已登记为小说自有架构，CPS 无先例。
   按与 E4 相同的处理方式，只需 parity matrix 标注 CPS_HAS_NO_EQUIVALENT，不新开 divergence record。
```

> **E4 已按最终修订撤销。** 原要求「Web/Worker 密钥分离需新增 divergence record」不再成立：
> 小说变更申请已明确 Web 不得读取 Credential 密文、Scheduler 不持有 Credential 密钥、
> Worker 是唯一解密执行体。**只需在 CPS parity matrix 中注明：**
>
> ```
> CPS_HAS_NO_EQUIVALENT
> NOVEL_SECURITY_BOUNDARY_STRONGER_THAN_CPS
> ```
>
> 说明：Owner 明确撤销的是 E4。E5 与 E4 同属「小说规范已登记、CPS 无先例」的同型情形，
> 本报告按同一标准处理，此处显式标注该推广，供 Owner 复核。

---

## 8. REQUIRED_OWNER_DECISIONS

```
O1 Credential 状态词表：小说是否保留 revoked、是否吸收 CPS 的 invalid。
   （唯一会触发 migration 变更的决定；两边非超集关系已证实。）

O3 是否纳入以下两个错误码：
   - credential_ambiguous
   - account_inactive
   （两者在 CPS 均有实证用途，见 §4.7。）

O4 是否采用窄化治理规则：
   涉及 CPS 同类模块时，状态词表、安全边界、错误码语义如有偏离，
   必须在对应 JSONL 字典 evidence 中记录 CPS 行为及偏离理由；
   但 CPS 仍只是只读证据，不是高于小说冻结架构的权威源。
```

### 明确**不属于** Owner 决策的三项

以下已由小说规范确定，不再重复拍板：

- **使用 Recovery Code 后推进 `sessionVersion`** —— 变更申请 `:41` 已规定（落为 C2 实现 + 验收项）
- **Web / Worker Credential 密钥分离** —— 变更申请 `:51` 已规定（落为 parity matrix 标注）
- **challenge 绑定当前 Session** —— Owner 2026-08-03 决定 `CHALLENGE_SESSION_BINDING=REQUIRED`

### 关于 O4 的实证支持

小说 `docs/governance/database-governance.md:17` 已冻结冲突裁决顺序
（`Notion P1 台账 → Owner 六项修正 → 正式实施分工 → candidate-v0.2.1 → P1 shared contracts →
CPS parity matrix → CPS 只读证据`），`:21` 更写死「新项目与 CPS 零共享；CPS 只作只读证据」。

因此**不应**设立「默认复用 CPS」这类规则 —— 它会把 CPS 证据从最低位倒置为默认位，
与 `:17` / `:21` 直接冲突。本轮实证也支持现有顺序：F-3 的密钥边界上 CPS 明显弱于小说目标，
F-1 的状态词表 CPS 无 CHECK 无常量，都是不该复用的。
O4 的窄化表述既不与 `:17` / `:21` 冲突，又能防住 D1 / D5 这类「悄悄偏离且偏错方向」。

---

## 9. REQUIRED_CODE_CHANGES

> 本轮（调研 + 归档）不改代码，以下交 Codex 在后续轮执行。

```
C1 contracts.ts:22 删除 "disabled"，与冻结 CHECK 对齐。（对应 D1；无争议，不依赖任何 Owner 决策）

C2 AuthUnitOfWork.completeTwoFactorChallenge 的实现须在 recoveryCodeId ≠ null 时推进 identity
   sessionVersion，并新增验收用例。
   依据：变更申请 :41「注销、改密或恢复码使用后通过 version 前进使旧 Session 失效」。
   性质：REQUIRED_CODE_CHANGE / ACCEPTANCE_ITEM（规范已定，非 Owner 决策）。
   备注：ports.ts:63-69 的入参虽无 sessionVersion 字段，但实现方拿得到 recoveryCodeId，
        UnitOfWork 实现体可在内部完成 bump，不必然需要改端口签名。

C3 CredentialContractCode 补 credential_ambiguous / account_inactive。（对应 D3，待 O3）

C4 P1_08B_CREDENTIAL_INTEGRATION_PLAN.md 把 disable/enable 标注为 account 级。（对应 E2）
```

---

## 10. NON_BLOCKING_NOTES

```
NB1 CPS validate 在处理最新一条 superseded Credential 时，可能将其恢复为 active
    （service.ts:284-296 无 status 过滤 + :324-331 写回），且无需重新输入 JWT 明文。
    小说的 Worker 版 validate 必须显式过滤 status，否则会继承这个洞。
    ※ 不采纳「旧 Credential 顶掉更新 Credential」这一加重情形：CPS validate action 不接受
      credentialId（page.tsx:149 只传 accountId；actions.ts:112-114 签名只有 channelAccountId），
      core 永远选择最新一条，该加重路径不可达。

NB2 CPS 页面 badge 用「最新一条 credential」而非「active 那条」判断 hasActiveCredential
    (page.tsx:123 + service.ts:85-88 take:1 orderBy createdAt desc)，作废后 badge 会显示 missing ——
    语义上正确但推理链绕，小说建议直接查 active 行。

NB3 CPS v7.10.0 的 insert-before-delete 指纹 reservation（database-governance.md:1536）是现成可抄的正解，
    对应小说 channel_credential_active_fingerprint。

NB4 CPS 遗留 P2：同一指纹跨两个 credential 模型同时 active 的窗口未被 DB 关闭
    （database-governance.md:1213 / :1556）。小说只有单一 credential 模型，天然不继承该缺陷 ——
    但若未来加第二套模型需记住这个教训。

NB5 CPS 存在 user 级 twoFactorConfirmedAt（schema.prisma:1640）；小说使用的是 session 级
    twoFactorCompletedAt。两者概念不同：
      - CPS  twoFactorConfirmedAt  = 该用户已完成 2FA 配置确认（绑定 Authenticator 那一刻）
      - 小说 twoFactorCompletedAt  = 当前 Session 已完成 step-up 2FA
    实施与 DTO 中不得混用，也不得因名称相近而互相映射。
```

---

## 11. Fable 5 复核摘要

**独立复核人：Fable 5 ｜ VERDICT = `AGREE_WITH_CORRECTIONS`**

三个 `RECOMMENDATION` 方向与治理结论全部维持。抽查的三条重点
（validate 复活路径、sessionVersion、Web 可解密）证据全部确认属实。

### 11.1 确认属实（抽查通过）

- **F-1**：`findFirst` 无 status 过滤 + `orderBy createdAt desc` 属实；复活可达且无需明文；
  `:312-321` 会为复活行让位（佐证是副作用非设计）。`revoked` 全仓 0 命中；migration 无 CHECK、
  部分唯一索引在 `:46`；disable 不碰 credential 的注释在 `:415-428`；resolver 不查 account.status
  且各调用点自设闸 —— 全部逐一核到。小说 `contracts.ts:22` 与 `migration.sql:1219` 的双向错位属实，是硬 bug。
- **F-2**：三错误码类、challenge 无 session_id 且建于 session 前、cookie 属性、
  页面 5 态 vs 提交塌缩（missing 也塌进 expired）、恢复码静默排除、
  **使用恢复码 `sessionVersion` +1 在 `:485-501` 确认存在**、CAS 消费、attemptCount 事务外只对 failed 递增、
  bcrypt 12 / 10 码 / SHA1-6-30-window1 / pending 10 min —— 全部核实。
  前端只 switch code 不解析 message 属实。
- **F-3**：`validateJwtLocally` 纯本地不验签；1e12 阈值与年份 > 9999 属实；测试名逐字核实；
  `credential_validation` 全仓 0 命中；`expiring_soon` 读取时派生不落库；
  `lastValidatedAt` 只在更新 / 验证两处写；
  **Web 可解密确认** —— `src/app/api/preview/changdu/[catalogItemId]/route.ts` 直接 import
  preview-account-resolver，解密就在 Next 进程跑，`CPS_HAS_NO_EQUIVALENT` 定性正确；
  三套错误词表并存核实；小说 6 码对照与两个缺失码核实；第二套模型五态、verification 四字段、
  指纹闩表、GetUserInfo 同步验证全部属实。
- **治理层**：裁决顺序与「零共享、CPS 只作只读证据」核实。设「默认复用 CPS」会把 CPS 证据
  从最低位倒置为默认位，直接冲突。窄化为「安全边界与状态词表偏离须留 divergence record」是对的。

### 11.2 已采纳的更正（**旧结论已被本文件正文覆盖，不并行保留**）

| # | 原判（已作废） | 最终判（本文件正文） |
| --- | --- | --- |
| 1 | D2 = 未登记偏离 / 安全回归 / Owner 决策 O2 | 规范 `:41` 已登记；改列 `REQUIRED_CODE_CHANGE / ACCEPTANCE_ITEM`（C2）；O2 删除 |
| 2 | 「CPS 文案声称不可撤销」 | CPS 文案已承认持明文可恢复；未披露的是 validate 那条无需明文的复活路径（§2.2） |
| 3 | E4 需新增 divergence record | 撤销；改为 parity matrix 标注 `CPS_HAS_NO_EQUIVALENT` / `NOVEL_SECURITY_BOUNDARY_STRONGER_THAN_CPS` |
| 4 | 「CPS 没有 twoFactorCompletedAt」止步于此 | 补 NB5：CPS 有 user 级 `twoFactorConfirmedAt`，概念不同，不得混用 |
| 5 | 行号 dry-run:307 / claim-enqueue:219 / revenue:304 / beidou:327 / getvideoinfo:552 / resolver:235 | 已修正为 :308 / :222 / :306 / :330 / :553 / :234（漂移 1-4 行，不影响结论） |

### 11.3 未采纳的一条（附理由）

**Fable 提出的「validate 会用旧 Credential 顶掉更新 Credential」不成立 —— 该路径不可达。**

其设想为「作废旧凭证 → 贴新 JWT → 再对**旧行**点验证 → 新凭证被顶掉」。
但 CPS 没有「对某一行点验证」这个入口：

- UI 只传账号：`<ValidateJwtForm accountId={account.id} />`（`page.tsx:149`）
- action 签名只有账号：`validateChannelAccountJwt({ channelAccountId })`（`actions.ts:112-114`）
- core 永远取**最新一条**：`findFirst orderBy { createdAt: "desc" }`，无 `credentialId` 参数（`service.ts:285-296`）

贴了新 JWT 之后，最新一条就是新凭证本身，validate 只会作用在它上面，构造不出「旧行顶掉新行」。
故 NB1 维持原描述，**不升级严重度**。

（附带说明：Fable 建议的「validate 只允许作用于 active 行」这条约束本身仍值得小说采纳 ——
它挡的是 §2.2 那个真实可达的复活场景，只是理由不是它给出的那个。）

---

## 12. 最终净结论

```
RESULT=P1_08_CPS_REFERENCE_RESEARCH_COMPLETE

CPS_HEAD=d77c3b968285698529cf97c7f0f97b286d7a2a9c
CPS_CLEAN=YES
NOVEL_HEAD=93459d17c0aac1d00bdcfe1ef3690cdb6b81b5c6
NOVEL_BRANCH=feature/v0.1.0-p1-auth-foundation

F1_RECOMMENDATION=FOLLOW_CPS_WITH_EXPLICIT_NOVEL_DIVERGENCE
F2_RECOMMENDATION=FOLLOW_CPS_WITH_EXPLICIT_NOVEL_DIVERGENCE
F3_RECOMMENDATION=FOLLOW_CPS_WITH_EXPLICIT_NOVEL_DIVERGENCE
                  （密钥边界一项 = CPS_HAS_NO_EQUIVALENT / NOVEL_SECURITY_BOUNDARY_STRONGER_THAN_CPS）

FABLE_REVIEW=AGREE_WITH_CORRECTIONS
FABLE_CORRECTIONS_INTEGRATED=YES
CONFLICTING_OLD_CONCLUSIONS_REMOVED=YES

OWNER_DECISIONS=O1,O3,O4
NOT_OWNER_DECISIONS=recovery_code_session_version_advance, web_worker_key_separation, challenge_session_binding

REQUIRED_CODE_CHANGES=C1,C2,C3,C4
CODE_FILES_CHANGED=NO
GOVERNANCE_FILES_CHANGED=NO
SCHEMA_OR_MIGRATION_CHANGED=NO
```

**下一步**：Owner 就 O1 / O3 / O4 拍板后，由 Codex 执行 C1～C4。
C1 与 C2 不依赖任何 Owner 决策，可先行；C3 待 O3；C4 为文档修订。

---

## 13. Owner 决策落地回执（2026-08-04）

本节只记录调研完成后的 Owner 决策，不改写前述只读证据：

```text
O1=ADOPT_CPS_CREDENTIAL_STATUS_WITH_DEFECT_FIX
O3=APPROVED_BOTH
O4=APPROVED_REVISED_RULE
```

- O1：小说采用 `active | superseded | expired | invalid`，删除 Credential `disabled/revoked`；
  validate 明确拒绝 superseded，修复 CPS 的无明文复活缺陷。
- O3：补入 `credential_ambiguous` 与 `account_inactive`，两者语义不得互相替代。
- O4：CPS parity 调研成为同类模块冻结前的强制证据步骤；CPS 仍不高于小说冻结架构。
- F-2：不新增 `two_factor_consumed`；Recovery Code 成功使用时原子推进 identity 与绑定
  Session 的同一 sessionVersion，旧 Session 失效、当前 Session 保持有效。
- F-3：`CredentialQueuedResult` 与 `lastValidatedAt` 已冻结；异步 validation + taskId 保持
  `EXPLICIT_DIVERGENCE / CPS_HAS_NO_EQUIVALENT`，本轮未实现 Worker。
