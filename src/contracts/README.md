# src/contracts/

**Merge custodian: Claude；Codex 通过审查或 PR 提出契约修改。**

## 用途

跨所有权边界的契约层：Claude 与 Codex 两侧实现相互依赖的类型定义、接口形状（API 请求/响应结构、Server Action 入参出参、能力位常量、任务 payload 形状等）。任何一方需要对方目录背后的能力，都通过在此提契约 PR 的方式对齐，而不是越界直接读写对方目录。

## 本轮范围

P1-08B 已落地首批 Admin / Credential DTO 与投影函数（见下「已落地契约」）。P1-04 的
「只建目录、不写类型」阶段已结束。

### 已落地契约（P1-08B）

| 文件 | 内容 |
| --- | --- |
| `errors.ts` | `ErrorEnvelope`、`AdminErrorCode`、`projectErrorEnvelope` |
| `admin-session.ts` | `AdminSessionView`、`AdminCapabilityView`、`AdminCapabilityState` 及投影 |
| `two-factor.ts` | `TwoFactorStateView`、`TwoFactorSetupResult`、`TwoFactorChallengeView`、`RecoveryCodesOneTimeResult` 及投影 |
| `channel-accounts.ts` | `ChannelAccountView` 及投影 |
| `credentials.ts` | `CredentialMetadataView`、`CredentialOperationAvailability`、`CredentialQueuedResultView`、`CredentialTaskStatusView`、`CredentialRedactedValidationResultView` 及投影 |

### 两条使本层可被机器校验的规则

1. **零运行时依赖**：只允许 `import type` 引用 `src/lib/**` 与 `src/server/**`。
   `@/lib/auth/session` 顶层 import 了 `node:crypto`，值引用会把 Node 内建模块带进浏览器包。
   唯一放行的值引用是 `@/domain/database-statuses`（零 import 的叶子模块）。
2. **投影逐字段装配**：任何投影都不得 spread 数据库行、`AdminAuthContext` 或 `Error`。
   `tokenHash` / `sessionVersion` / `passwordHash` / `encryptedSecret` / 完整 fingerprint /
   TOTP 密文 / recovery code hash / stack 因此没有出口。

两条规则均由 `tests/backend/contracts/no-sensitive-fields.test.ts` 静态 + 运行时守卫。

## 硬纪律

1. 🔴 **不提前猜写未经调研的渠道接口**——契约必须有依据（既有 P1 架构文档、CPS 只读参考实测证据、或明确的产品需求），不得凭空拍脑袋定字段；
2. 🔴 **契约必须对应已实施的后端形状**——新增 DTO 前须有后端实现或冻结设计为依据；
3. 契约变更走 **PR + custodian 合并**流程：非 custodian 一方提 PR，Claude 合并前需取得 Codex（审核方）确认；
4. 🔴 **FROZEN 级契约的变更需 Owner 确认**，不得由执行体单方面改动已冻结的契约。

## 未来填充目录（本轮仅列主题，不写内容）

以下是已知会在后续任务中落地为具体契约文件的主题，供后续任务参考规划，**本轮不创建任何对应的类型文件**：

1. 数据读取契约（前台读接口的数据形状）
2. Locale（语言/地区）契约
3. URL 构造契约
4. 公开短码（`public_redirect_code`）契约
5. SEO 收录状态契约
6. Feature Flag 契约
7. 任务入队契约
8. 埋点（analytics/tracking）契约
9. 内容状态（草稿/发布/软删等）契约
10. 渠道无关性契约（渠道特定字段不得泄漏到通用层）

## 填充任务

首批契约已随 **P1-08B** 落地（Admin Session / Capability / 2FA / ChannelAccount / Credential）；
**P1-09** 消费它们实现后台 UI；正式契约联调在 **P1-12**。

前台读取、Locale、URL 构造、公开短码、SEO 收录、Feature Flag、埋点等主题仍未落地。
