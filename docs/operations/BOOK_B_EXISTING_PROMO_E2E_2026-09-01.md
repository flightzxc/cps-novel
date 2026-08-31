# Book B 已有 PromoLink 完整 E2E（2026-09-01）

## 1. 结论

`BOOK_B_EXISTING_PROMO_E2E_PASSED`。

Book B 基于已存在的 `fetched/claimed` PromoLink 完成：

`Preview reads → materialize → publish gate → publish → public page → /go → TrackingEvent`

本轮没有导入或调用 promo claim handler；`getcode=0`，claim 双闸和 capability 全程
关闭。真实上游只读请求严格为 `getbydataid=1`、`getchapterinfo=1`，两者均
`maxAttempts=1`、retry `0`、`redirect=error`。

## 2. 固定对象

| 字段 | 值 |
|---|---|
| Book B title | `Accidentally In Bed With My Ex's Uncle. Dark Alpha Nero` |
| seriesId | `118274322` |
| NovelSourceItem | `850bfd87-66dc-48dd-8166-3daed39e536f` |
| Novel | `d22a6048-9872-497d-b542-478f89f713eb` |
| Article | `d8d005be-4488-48e8-ba52-8cfebae6b1e2` |
| PromoLink | `0fc6dab3-05f5-4844-b4b8-ece48b06615d` |
| ChannelAccount | `45e89c67-b160-4ae6-95e3-c85f98b5a010` |
| ChannelApp | `5e9aa528-88ab-43d4-97de-a0d9ff5e9862` |
| projectType | `1` |

## 3. Preview 请求坐标

| # | Endpoint | Method | page | pageSize | projectType | 坐标 | maxAttempts | 实际 attempts | 结果 |
|---:|---|---|---:|---:|---:|---|---:|---:|---|
| 1 | `/api/v1/material/getbydataid` | POST | N/A | N/A | 1 | `agencyId=3366`, `dataId=118274322`, `language=3`, `materialType=1` | 1 | 1 | parser pass |
| 2 | `/api/v1/res/getchapterinfo` | POST | N/A | N/A | 1 | `agencyId=3366`, `seriesId=118274322`, `language=3` | 1 | 1 | parser pass；返回 3 条 preview |

- 总请求：`2/2`。
- `getcode`：`0`。
- retry：`0`。
- redirect follow：`0`。
- transport allowlist 仅接受上述两条路径；任何 `/api/v1/res/getcode` 在调用 fetch
  前抛出 `getcode_forbidden`。

## 4. Materialize 与任务证据

- 成功 task：`273c9ebc-865a-4194-9e1e-8883ca73dbfe`，`completed`。
- 成功 item：`54573d6d-c393-4042-9412-b5193d6588aa`，`success`，
  `attempt_count=1`，`upstreamCount=3`。
- `NovelPreviewPolicy.materializedChapterCount=3`，cap `3`。
- 3 个 preview chapter 均存在非空 `NovelChapterContent.body`。

## 5. Publish gate 与 publish

- Preview 前 gate：`publishable=false`，唯一 reason 为
  `preview_chapter_missing`。PromoLink 已绑定且 ready，因此没有
  `promo_link_missing` 或 `promo_link_not_ready`。
- Preview/materialize 后 gate：`publishable=true`，reasons `[]`。
- Publish 只经过 `applyPublishTransition`。
- publish request：`16ccda19-497b-46f9-9bf5-549d0b5ebe6c`。
- `article.publish` audit：恰好 1 条。
- Novel 与 Article 终态均为 `published`；Article 仍绑定同一个 PromoLink。
- publishedAt：`2026-08-31T16:59:05.132Z`。

## 6. 公网页面、/go 与 TrackingEvent

- 公网页面：
  `/novel/accidentally-in-bed-with-my-exs-uncle-dark-alpha-nero-p4b4qznui`，HTTP 200。
- `/go/8fhksjt5bg`：HTTP 302；未跟随外部跳转；Location host 为
  `eng.moboreader.com`，完整目标 URL 未写入报告。
- `/go` 实际访问次数：1。
- 新增 `TrackingEvent`：恰好 1 条，`eventType=go_redirect`，Novel/PromoLink/public
  redirect code 关联均正确；User-Agent 仅保存 hash，不记录原始值。

## 7. E2E 发现并修复的权限缺口

真实预检发现 `web_app` 不能读取 `promo_link.web_url/app_url`，而 publish gate 和
公开 `/go` route 都需要这两个列，导致真实 Web 发布/跳转路径在权限层不可执行。

最小修复：`infra/postgres/grants.sql` 仅向 `web_app` 增加这两个目的 URL 列的
`SELECT`；`analyst_ro` 仍无权读取，`upstream_code` 仍为 Worker-only。修复已应用到
本地 X8，并验证：Web 两列 `true/true`，Analyst `false/false`。

## 8. 受控失败记账

1. 首次 operator 启动在 database preflight 失败：未创建 task、上游请求 0。该失败
   暴露 Web destination URL grant 缺口。
2. 权限修复后创建的 task
   `8455fc92-a28f-4099-8134-63539a4ac9df` 在 capability 检查处失败，item
   `1184defc-2bb5-4ce5-b39b-61c83d3d3eae`，`attempt_count=1`；持久化错误为
   `preview_read_capability_unavailable`，上游请求 0。
3. 依据既有真实 preview 证据
   `docs/operations/CANARY_PREFLIGHT_2026-08-27.md`，通过正式受审计 CLI 启用
   `getbydataid` 与 `getchapterinfo` 两个非副作用只读能力（audit `112/113`）。
4. 随后成功 task 是第一次实际发出 preview 上游请求；没有重放任何 mutation。

## 9. 最终闸门与发布阻断

- `FEATURE_PROMO_LINK_CLAIM=false`。
- `PROMO_LINK_CLAIM_ALLOW_WRITE=false`。
- `claimPromo=registered_disabled`。
- `getbydataid=enabled`、`getchapterinfo=enabled`；两者均为 read-only capability。
- 密钥未轮换。`SEC-CREDENTIAL-KEY-ROTATION-2026-09-01` 保持 `OPEN`，只阻断
  production release，不阻断本地 E2E。

## 10. 实现与验证

- Promo Claim 轮次先行提交：`31d4723`。
- E2E 使用 commit-matched 镜像 `cps-novel:0.1.0-31d4723`；Web health 200，镜像
  revision 与 commit 精确相等。
- E2E operator：`scripts/book-b-existing-promo-e2e.ts`。
- 定向验证覆盖 no-bypass、getcode fail-closed、固定两请求预算及数据库 grant 静态
  契约。
- TypeScript 与 lint 通过（lint 仅 3 条既有 IndexNow test warning、0 error）；全量
  hermetic suite 为 `214 files / 2562 tests` 通过，另有 10 files / 111 tests 按环境
  条件跳过。
- JWT、凭证密文、密钥、完整目标 URL、推广码均未写入本报告。
