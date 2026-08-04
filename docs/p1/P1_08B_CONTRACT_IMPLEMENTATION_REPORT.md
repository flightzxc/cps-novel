# P1-08B · `src/contracts` 实施报告（阶段 B）

**实施人：Claude（`src/contracts` merge custodian）**

**分支：`feature/v0.1.0-p1-08b-contracts`**

**基线 HEAD：`95ea7d9c18dda579d070d9adeed9e088565612d2`**

**前置：阶段 A = `P1_08B_FRONTEND_CONTRACT_REVIEW_PASS_WITH_SECRET_INGRESS_GATE`
（见 `P1_08B_CLAUDE_CONTRACT_REVIEW.md`）**

**结论：`RESULT=P1_08B_CLAUDE_CONTRACTS_READY`**

---

## 1. 变更范围

只修改授权的四类路径：

| 路径 | 动作 |
| --- | --- |
| `src/contracts/**` | 新增 5 个 DTO 模块 + `index.ts`；更新 `README.md` |
| `tests/backend/contracts/**` | 新增 2 个测试文件 |
| `docs/p1/P1_08B_CLAUDE_CONTRACT_REVIEW.md` | 新增（阶段 A 结论） |
| `docs/p1/P1_08B_CONTRACT_IMPLEMENTATION_REPORT.md` | 本文件 |

未修改：`prisma/**`、`src/lib/**`、`src/server/**`、`worker/**`、`scheduler/**`、
`infra/**`、`scripts/**`、package 文件、CPS 参考仓库。

---

## 2. 落地的 DTO

| 模块 | DTO | 投影函数 |
| --- | --- | --- |
| `errors.ts` | `ErrorEnvelope`、`AdminErrorCode`、`ErrorEnvelopeDetails` | `projectErrorEnvelope` |
| `admin-session.ts` | `AdminSessionView`、`AdminCapabilityView`、`AdminCapabilityState` | `projectAdminSession`、`projectAdminCapability` |
| `two-factor.ts` | `TwoFactorStateView`、`TwoFactorSetupResult`、`TwoFactorChallengeView`、`RecoveryCodesOneTimeResult` | `projectTwoFactorState`、`projectTwoFactorSetup`、`projectTwoFactorChallenge`、`projectRecoveryCodes` |
| `channel-accounts.ts` | `ChannelAccountView` | `projectChannelAccount` |
| `credentials.ts` | `CredentialMetadataView`、`CredentialOperationAvailability`、`CredentialQueuedResultView`、`CredentialTaskStatusView`、`CredentialRedactedValidationResultView` | `projectCredentialMetadata`、`projectCredentialOperationAvailability`、`projectCredentialQueuedResult`、`projectCredentialTaskStatus` |

13 个要求的 DTO 全部落地。

---

## 3. 关键设计决定

### 3.1 两条使「DTO 是浏览器唯一出口」可机器校验的规则

1. **零运行时依赖**：`src/contracts/**` 只以 `import type` 引用 `src/lib/**`。
   起因是 `@/lib/auth/session` 顶层 `import { createHash } from "node:crypto"` ——
   值引用会把 Node 内建模块拖进客户端包。因此 `ADMIN_IDLE_TIMEOUT_MS` 不被 import，
   而由服务端调用方作为 `idleTimeoutMs` 参数传入：既不重复定义常量，也不产生漂移。
   唯一放行的值引用是 `@/domain/database-statuses`（零 import 的叶子模块，测试断言其无 import）。

2. **投影逐字段装配**：没有任何投影 spread 数据库行、`AdminAuthContext` 或 `Error`。
   这不是风格问题——spread 会让 `tokenHash`、`passwordHash`、`stack`、Prisma 驱动元数据
   一次性越界。逐字段装配使「没写就出不去」成为结构性保证。

### 3.2 可用性与生命周期是两条正交轴

阶段 A 的要求把 `supported / queued / completed / failed / unavailable_pending_owner_gate`
列在一起，但它们属于两个维度，合并会导致 UI 无法表达「操作可用但这次任务失败了」：

- **入口轴** `CredentialOperationAvailabilityState`：
  `supported` | `unavailable_pending_owner_gate` | `unavailable_capability_denied` |
  `unavailable_two_factor_required`
- **生命周期轴** `CredentialTaskState`：
  `queued` | `running` | `completed` | `completed_with_errors` | `failed` | `disabled` | `unknown`

`unknown` 是兜底：未知的 task status 不会被当成 `completed` 渲染。

### 3.3 Owner gate 优先于 capability

`projectCredentialOperationAvailability` 对 `add_or_replace_credential` 恒返回
`unavailable_pending_owner_gate`，即便运营持有 `credential:manage`。
理由是后端 route/action 根本未登记，提交只会得到 404；先按 capability 显示为可用、
提交后再报错，正是本轮明令禁止的行为。

### 3.4 解析而非信任 jsonb

`generic_task_item.result` / `.error` 是 `jsonb`，形状不受编译期保护。
`projectCredentialTaskStatus` 对每个字段做类型校验后重新装配，未知 code 收敛为 `null`。
效果是：将来 Worker 往 result 里多写一个 `rawUpstreamResponse` 或 `stack`，也不会顺流到浏览器。

### 3.5 错误信封无自由文本

`ErrorEnvelope` 无 `message` 字段。`AdminAccessError.details` 只放行
`capability` 与 `retryAfterSeconds` 两个结构化键，其余（包括服务端写入的 `message`/`stack`）
一律丢弃。

### 3.6 契约已为待修的 backend 一行预留

阶段 A 记录的唯一必修项是 `getCredentialTaskResult` 丢弃了 `items[0].error`。
`CredentialTaskStatusView.failureCode` 与 `projectCredentialTaskStatus(input.error)` 已就位，
Codex 补上返回 `error` 后**契约无需再改**。

---

## 4. 测试

`tests/backend/contracts/admin-contracts.test.ts`（20 例）——形状与行为：
四个 2FA 状态派生、capability 三态、`attemptsRemaining` 归零钳制、
credential 四值状态、`disabled`/`revoked` 收敛为 `invalid`、Owner gate 优先级、
task status 全量映射、queued 七字段、错误信封白名单与 status 兜底。

`tests/backend/contracts/no-sensitive-fields.test.ts`（8 例）——泄漏守卫：

- 向投影塞入**完整内部记录**（含 `tokenHash`、`sessionVersion`、`passwordHash`、
  session 主键、TOTP 明密文、challenge 绑定、完整 HMAC 指纹、`encryptedSecret`、
  `keyVersion`、`stack`、上游原始响应、服务端 message），断言序列化结果中一个都不出现；
- 静态断言 `src/contracts/**` 无 `node:` import；
- 静态断言除白名单叶子外无值引用服务端模块，并断言该叶子自身零 import。

---

## 5. 门禁结果

| 门禁 | 结果 |
| --- | --- |
| `npm run build` | **EXIT=0**（Next.js 16.1.6 Turbopack，编译 1728ms，3/3 静态页） |
| `npm run typecheck` | **EXIT=0** |
| `npm run lint` | **EXIT=0** |
| `npm run test:backend` | **EXIT=0** — 18 files / **124 passed**（96 基线 + 28 新增） |

---

## 6. 结论块

```
RESULT=P1_08B_CLAUDE_CONTRACTS_READY
BASE_HEAD=95ea7d9c18dda579d070d9adeed9e088565612d2
DTOS=13
PROJECTIONS=11
SECRET_FIELD_TESTS=8
ADD_REPLACE_AVAILABILITY=unavailable_pending_owner_gate
BUILD=PASS
TYPECHECK=PASS
LINT=PASS
TESTS=124_PASSED
REMOTE_SYNC=DEFERRED
NEXT_GATE=CODEX_BACKEND_REVIEW_AND_LOCAL_INTEGRATION
```

## 7. 交给 Codex 的一项 backend 修改

`src/server/credentials/service.ts:104-108` 的 `getCredentialTaskResult` 需一并返回
`items[0].error`（数据已持久化且已脱敏）。这是 P1-09B 能渲染
`account_inactive` / `credential_missing` / `credential_ambiguous` 失败原因的前提。
