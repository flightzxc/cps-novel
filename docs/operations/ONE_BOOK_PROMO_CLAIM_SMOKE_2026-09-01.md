# MoboReader ONE_BOOK_PROMO_CLAIM_SMOKE 报告（Book B）

## 1. 结论

`ONE_BOOK_PROMO_CLAIM_SMOKE_PASSED`。

Book B 使用已冻结的小说 `getcode` 合同完成一次真实领取，并由独立
`getlistpc` readback 确认。整轮真实上游请求为 3 次：目录 pre-read 1 次、
`getcode` mutation 1 次、领取后 readback 1 次；mutation attempt 为 1，retry 为
0。随后创建的第二个任务命中本地 `PromoLink`，新增上游请求为 0。

Book A `seriesId=124235322` 已在选择器和运行时 guard 中排除，未用于本次 Smoke。

## 2. 账号身份与 scope

| 字段 | 记录 |
|---|---|
| JWT `UserId` | `88fcfefdfac246d48408c72b749f5272` |
| 海阅 `ChannelAccount.businessId` | `88fcfefdfac246d48408c72b749f5272` |
| 海阅 ChannelAccount ID | `45e89c67-b160-4ae6-95e3-c85f98b5a010` |
| 身份精确等值 | `PASS` |
| 小说 scope 证据 | 同一枚海阅加密凭证成功完成 `projectType=1` 的 pre-read、`getcode` 和 readback；凭证链与小说 claim scope 均被正式路径接受 |
| JWT/密钥材料 | 未记录 |

该项显式核对 `UserId` 与小说专属 ChannelAccount，防止再次出现“槽位贴错 scope
的 JWT”事故。账号仅复用业务身份；海阅使用独立 ChannelAccount、数据库行、加密
密钥和仓库外源文件，未读取或写入 CPS 仓库及 CPS 凭证存储。

## 3. Book B

| 字段 | 记录 |
|---|---|
| 标题 | `Accidentally In Bed With My Ex's Uncle. Dark Alpha Nero` |
| seriesId | `118274322` |
| externalBookId | `977679639` |
| NovelSourceItem ID | `850bfd87-66dc-48dd-8166-3daed39e536f` |
| agencyId | `3366` |
| language / locale | `3 / en` |
| 领取前状态 | pre-read 未发现 promo |
| 领取后状态 | `PromoLink.status=fetched`, `origin=claimed` |
| promo 形态 | code 长度 6；URL host `eng.moboreader.com`；原值未记录 |

## 4. 请求坐标与预算

| # | Endpoint | Method | page | pageSize | projectType | 其他坐标 | maxAttempts | 实际 attempts | HTTP/parser |
|---:|---|---|---:|---:|---:|---|---:|---:|---|
| 1 | `/api/v1/res/getlistpc` | POST | 1 | 10 | 1 | `name=""`, `orderType=1` | 1 | 1 | 2xx accepted；parser pass |
| 2 | `/api/v1/res/getcode` | POST | N/A | N/A | 1 | `agencyId=3366`, `seriesId=118274322`, `language=3` | 1 | 1 | 2xx accepted；contract parser pass |
| 3 | `/api/v1/res/getlistpc` | POST | 1 | 10 | 1 | `name=""`, `orderType=1` | 1 | 1 | 2xx accepted；目标 promo readback pass |

- 上游请求预算：`3 / 3`。
- `getcode`：`1 / 1`；retry `0`。
- 跟随跳转：禁止，所有请求均使用 `redirect=error`。
- 429 / Retry-After：未发生。
- claim/readback code：一致；仅记录长度，不记录值。
- 第二任务本地 short-circuit：上游请求 `0`。

## 5. 状态机与持久化复核

- 首次 task：`1d672106-1d53-4f83-86a8-e5cd39e0dda5`，`completed`。
- 首次 item：`edce2cc2-c764-4a2f-ba0d-7b3209e89c1f`，`success`，
  `attempt_count=1`。
- rerun task：`a586fa1c-71ee-4db5-86be-cb5871744127`，`completed`。
- rerun item：`0a6a93d9-9490-4364-b4ce-26b65b20039a`，`success`，
  `attempt_count=1`；命中已有 fetched PromoLink，未发上游请求。
- PromoLink：`0fc6dab3-05f5-4844-b4b8-ece48b06615d`，`fetched/claimed`。
- SideEffectIntent：`confirmed`，确认时间
  `2026-08-31T15:44:56Z`；PromoLink/Article binding/intent confirmation 由同一 fenced
  transaction 提交。

## 6. 安全修复验收

- handler 注册和 adapter 均固定 `maxAttempts=1`，没有自动重 POST。
- lease/fence loss 的 AbortSignal 覆盖外部调用；mutation 发出后的 abort 仍进入
  readback/manual-review 语义。
- `prepared`、`claim_retry_blocked` 和旧 confirmed-but-no-PromoLink 恢复路径均为
  readback-only；readback 无法确认时进入 `manual_review_required`。
- 本轮正常返回且 readback 确认，因此没有进入 ambiguous/manual review。
- 第二任务证明已有 PromoLink 的本地 short-circuit，不会重复领取。

## 7. 收尾

- `claimPromo` capability 已恢复为 `registered_disabled`，`projectType=1`。
- ChannelAccount 保持 `active`；凭证历史共 2 条，其中仅新凭证 1 条 `active`，旧凭证
  已归档，未共享 DB 行。
- 仓库外明文源文件
  `/Users/chenweifeng/.codex-secrets/moboreader-canary.jwt` 已删除；目录仍为 `0700`，
  不能从该路径恢复。
- 两次启动前失败分别发生在 shell 初始化和数据库连接阶段；两次均未进入 Smoke
  脚本的上游调用区，消费上游请求 0。
- 未调用 `getvideoinfo`、`getbydataid`、`getchapterinfo` 或其他 mutation。
- `git diff --check` 与 TypeScript 类型检查通过；claim/fencing/worker/X8/报告模板
  定向 hermetic 测试为 `7 files / 96 tests` 全部通过。
- 变更文件敏感扫描未发现 Authorization bearer JWT 或私钥。2 个 `eyJ` 形态命中均为
  adapter 的无效 token 测试 fixture（header/payload 非 JSON、签名长度 3），不是本次
  真实凭证。
- 操作期间一次容器环境检查曾使海阅本地凭证加密键出现在工具输出中；该值未写入
  仓库、报告或命令文件。当前未执行密钥轮换，以免在没有 Owner 授权和重加密方案的
  情况下破坏现有凭证；已登记为 production release blocker
  `SEC-CREDENTIAL-KEY-ROTATION-2026-09-01`，本轮禁止顺手轮换。
- CPS SOP ACK：`c4bd2ffefd7539e3f98ac8994f5bec291c9f7e05293f64d5987d6a8da97b821a`。

## 8. 非阻塞记账

收益归属统一后，Owner 仍需确认上游收益接口能否按 `projectType` 或 promo code
区分小说与短剧收入。该项不阻塞本次 claim smoke 结论。

`BOOK_A_RESERVED_FROM_SMOKE=true`
