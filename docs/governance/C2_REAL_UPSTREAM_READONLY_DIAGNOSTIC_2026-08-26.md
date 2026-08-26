# C2 真上游只读诊断报告（2026-08-26）

> 本报告取代 2026-08-21 的 HTTP 401 阻断报告作为 C2 业务结论；执行基线为 `feature/v0.2.0-acceptance` @ `d103cf2`（修复后 parser：`chapterID` 使用 `requiredIdentifier`）。

## 结论

两次授权只读请求均完成，无重试、无硬停止、无上游写副作用。`getlistpc` 正式 parser 为 `SUCCESS`；`getchapterinfo` 收到并完成脱敏形态统计，但正式 parser 仍返回 `malformed_payload`（非重试型、无 HTTP 状态），说明 D-1 之外仍有另一处响应合同不兼容，不能把“D-1 已闭环”等同于“整个章节 parser 已闭环”。

| 请求 | 结果 | 限流响应头 |
|---|---|---|
| `POST getlistpc` | HTTP 成功；正式 parser `SUCCESS` | limit `60`，remaining `59`，via `kong/3.4.2` |
| `POST getchapterinfo` | HTTP 成功；正式 parser `malformed_payload` | limit `60`，remaining `59`，via `kong/3.4.2` |

实际请求计数：**2/2**。目录返回 `totalCount=96,980`，仅作为本次动态事实记录，未与历史常量 `95,479` 作等值断言。选书记录 `labelSnapshotComplete=true`，但该字段未作为准入门槛。

## 问题 1：`chapterID` 形态与 D-1

`$.data.chapterList[*].chapterID` 共 3 条：`number=3`，`string=0`，`null=0`，`empty_string=0`，`missing=0`。

**技术判断：D-1 修法对真实 `chapterID` 形态已闭环。** 真上游返回数字，`requiredIdentifier` 的数字安全转字符串正是所需修法。与此同时，正式章节 parser 仍报 `malformed_payload`，而本工单只采集了 `chapterID` 的逐字段形态，无法安全归因另一处失败字段；应另立最小脱敏形态诊断，不能回退或继续放宽 `chapterID`。

## 问题 2：推广字段与 §3.9 路线

样本 20 条；四字段均只记录形态，未记录任何值：

| 字段 | string | null | 空串/缺失 | 特别说明 |
|---|---:|---:|---:|---|
| `kocCode` | 5 | 15 | 0 | 值未落盘 |
| `publicUrl` | 5 | 15 | 0 | 值未落盘 |
| `homeLink` | 5 | 15 | 0 | 值未落盘 |
| `onlineUrl` | 0 | 20 | 0 | 无非 null 样本，不能证实其到 `appUrl` 的解释 |

满足“`kocCode` 非空且（`publicUrl` 或 `homeLink`）非空”的记录为 **5/20（25%）**。`promotionalText` 非空也为 **5/20（25%）**，仅记录存在性，正文及其中 code 均未持久化。

**技术判断：§3.9 正解应走同步侧脱敏前提取。** 25% 是可观的活路径；应从原始响应进入 `toApprovedRawEvidence` 之前提取推广码并直写 `PromoLink.upstreamCode`，保持 `rawPayload` 脱敏与现有 schema 不变。`claimPromo` 仍保持冻结，不应作为当前唯一路径。另将 `promotionalText` 旁路泄漏修复列为生产同步开闸前必修项。

## 问题 3：语言枚举

| JSON Path | 类型/空值 | 本次标量集合 |
|---|---|---|
| `$.data.list[*].language` | number 20；null/空串 0 | `{3, 7}` |
| `$.data.list[*].languageName` | string 20；null/空串 0 | `{英语, 俄语}` |
| `$.data.currentLanguage` | number 1；null/空串 0 | `{3}` |

本次集合与已归档 Lane B 成对证据一致：`3 → 英语 → en`，`7 → 俄语 → ru`。因此 `UPSTREAM_LANGUAGE_REGISTRY` 可先增加 `3 → en`、`7 → ru`；这只是本页 20 条样本覆盖到的子集，不代表上游完整语种枚举。

## 安全核验

正式 adapter 与正式请求构造器、`maxAttempts=1`、固定域名/路径/方法/顺序、禁跳转与总请求数门禁均生效。合成分桶、枚举、推广聚合、`promotionalText` 不落值、两请求计数、第三请求拦截及假 JWT 检出全部通过。凭证源文件在正式本地校验为 active 后立即删除；原始响应未落盘；产物完成 Lane B 扫描并确认零凭证命中后，仅保留本报告。
