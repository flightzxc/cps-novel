# MoboReader 金丝雀 Path A 验收报告（2026-08-31）

## 结论

**Path A 失效，已按第一枪硬停。** CPS 短剧现用畅读账号可以读取 `projectType=1` 的小说目录，凭证链和 parser 均正常，但本次固定一页返回的 20 条记录中没有任何完整 promo：`0/20 = 0%`。本账号亦无可供海阅复用的小说品类 claim 记录。

未执行 linked refresh、preview、claim/getcode 或 publish。真实上游请求总数为 **1/4**。

Owner 下一步需在以下两项之间重新决策：

1. 另寻具有小说品类 claim 记录的畅读账号；
2. 解冻 `claimPromo`，并先完成 W9、副作用协议修复和端点取证。

## 账号身份与 scope 验证

| 字段 | 记录 |
|---|---|
| CPS 登录账号 | `chenweifeng2020@qq.com` |
| JWT `UserId` / 海阅 `ChannelAccount.businessId` | `88fcfefdfac246d48408c72b749f5272` |
| JWT `AccountId` | `235604992` |
| JWT `InstitutionId` | `48` |
| JWT `StarId` | `335788` |
| 海阅 ChannelAccount ID | `45e89c67-b160-4ae6-95e3-c85f98b5a010` |
| 身份比对 | Owner 确认 CPS 登录账号映射的畅读 JWT；新 token 离线解码后 `UserId` 与预期值精确相等 |
| JWT 显式 scope claim | 无独立 scope/projectType claim |
| 小说 scope 的正式证据 | 同一枚导入凭证成功完成 `projectType=1` catalog-one，返回并解析 20 条；因此小说目录请求 scope、凭证链和 parser 可用，但 promo 命中为零 |

该验证显式记录了账号主体，避免再次发生“UserId 与槽位 scope 不对应”的同类事故。报告未记录 JWT、签名、密文、完整指纹或其他密钥材料。

## 请求坐标与预算

| # | endpoint | page | pageSize | projectType | maxAttempts | 实际 attempts | 结果 |
|---:|---|---:|---:|---:|---:|---:|---|
| 1 | `getlistpc`（catalog-one） | 1 | 20 | 1 | 1 | 1 | 成功返回并解析 20 条；完整 promo `0` |

- Transport：上游响应被 adapter 接受（HTTP 2xx）并完成 wrapper/parser；当前红线日志不持久化精确数字状态码，因此不将未落证的 `200` 数字写成直接证据。
- `promoCapture.fetched=0`
- `promoCapture.deferredUntilLinked=0`
- `promoCapture.incomplete=0`
- `promoCapture.articlesBound=0`
- `promoCapture.articlesConflicted=0`
- `observedTotal=97061`
- promo 命中率：`0 / 20 = 0%`
- 预算使用：`1 / 4`；因 promo 为零触发硬停，剩余 3 次未使用。

任务证据：

- Catalog task：`540d6b30-6e6a-4a38-ac8e-d29c5c982d7e`
- Catalog item：`fc95786b-6ec7-46d3-b531-67858c6d84b4`
- mode：`apply`
- item terminal status：`success`
- `attempt_count=1`
- 执行时间：`2026-08-31T07:16:01Z`

## 隔离与收尾

- 在海阅数据库创建了新的小说专属 ChannelAccount；未复用 CPS DB 行。
- JWT 只从仓库外 0600 文件进入海阅凭证替换入口，并以海阅自己的密钥加密落库；未读取或写入 CPS 凭证文件。
- 离线 credential validate 成功，任务 `attempt_count=1`。
- promo=0 后立即关闭 catalog gate；`FEATURE_NOVEL_CATALOG_SYNC=false`、`NOVEL_CATALOG_SYNC_ALLOW_WRITE=false`。
- `FEATURE_PROMO_LINK_CLAIM=false`、`PROMO_LINK_CLAIM_ALLOW_WRITE=false`；claim/getcode 从未调用。
- 常驻 worker 已停止。
- 导入凭证已作废为 `superseded`，Path A ChannelAccount 已停用。
- 仓库外源 JWT 文件 `/Users/chenweifeng/.codex-secrets/moboreader-canary.jwt` 已删除，不能从该路径恢复。
- PromoLink 写入数：`0`；未进入 preview/publish，也未产生 published 金丝雀。

## 流程修复

真实上游诊断/验收的永久模板已新增以下必填项：

1. 账号身份：JWT subject/account claim 或本地 ChannelAccount businessId，只记录标识；
2. 请求坐标：`page / pageSize / projectType`，并记录 attempt 预算与实际次数。

模板：`docs/governance/REAL_UPSTREAM_DIAGNOSTIC_REPORT_TEMPLATE.md`。

## 非阻塞记账

收益归属统一后，仍需 Owner 后续确认：上游收益接口能否按 `projectType` 或 promo code 区分小说与短剧收入。若不能区分，按 Owner 决策可接受，但应在对账前明确记录。
