# P2-05 修订执行包（Owner REVISE 定稿）

> 本文件是 P2-05 在 Owner `REVISE` 决策后的**唯一执行口径**。与 `P2_05_CPS_PARITY_MATRIX.md`
> （随 HEAD `3493485` 交付）冲突之处，一律以本文件为准；该矩阵在本轮修订完成后需同步更新。
>
> 最高原则：**CPS parity**。CPS 没有的限制模型与调度模型，不得为工程完整性自行新增。

```text
基线 HEAD      = 349348587815d5e7e7e85ebe891df29c8d760aa7（不回退、不重做）
分支           = feature/p2-05-moboreader-sync
BASE           = 892c1a8aabc617b6b9172777e3200fe81a08b82f
CPS 只读基线   = d77c3b968285698529cf97c7f0f97b286d7a2a9c
执行方         = Codex（本包涉及路径全部为 Codex 独占写入，见 CLAUDE.md §3.2）
MERGE          = 禁止，直至全量验收通过
```

---

## 0. Owner 冻结项清单

| # | 冻结内容 | 本包状态 |
| ---: | --- | --- |
| 1 | 取消 1000 部 / 2000 页**业务上限**；只保留真正的技术安全保护 | 需改动，见 §2.1 |
| 2 | checkpoint / 续跑机制保留 | 保留，语义修正见 §2.2 |
| 3 | P2-05 不拆分验收；书目同步 + 试读物化整体闭环才算 DONE | 见 §5 阻塞链 |
| 4 | `paid_from_chapter` 继续只存不动 | 已合规，加回归断言 |
| 5 | `maxMaterializedChapters=3` 是默认值不是硬上限，按书可配 | 已合规，加回归断言 |
| 6 | 自动排程前移到 P2-05；复用同一 Task/worker/双闸/幂等/租约/checkpoint | 需新增，见 §3 |
| 7 | 公开试读继续匿名，不增加读者登录要求 | 已合规，加护栏断言 |
| S1 | Preview 自动触发挂在**书目同步之后**，范围继承本次同步集合 | 需新增，见 §3 |

撤回项（前一版本执行包的错误前提，不再执行）：**1000 部唯一小说配额**、**task-scoped 去重表**、
**全目录 cursor 轮转（C1/C2/C3）**。撤回依据见 §1。

---

## 1. CPS parity 取证结论

本轮全部改动的依据。行号相对 CPS 只读基线 `d77c3b9`。

### 1.1 只读镜像类同步：无业务配额

畅读书目同步 `changdu_source_sync`（与海阅 catalog sync 同形态）**不存在** max items /
max dramas / 单任务数量上限。唯一的页相关常量是显式命名的安全保护：

```text
worker/handlers/changdu-source-sync.ts:26-27
  CHANGDU_SOURCE_SYNC_DEFAULT_SAFETY_MAX_PAGES = 2000
  env 覆盖键 CHANGDU_SOURCE_SYNC_SAFETY_MAX_PAGES
worker/handlers/changdu-source-sync.ts:199-203   normalizeSafetyMaxPages() 读 env
worker/handlers/changdu-source-sync.ts:241       stop_reason==="safety_limit" → "partial_failed"
```

判定它是技术保护而非业务上限的三条同时成立的依据：① 常量名与停止原因均为 `SAFETY` /
`safety_limit`；② 可由环境变量覆盖，不是产品口径；③ 触发后任务收为 **`partial_failed`**
（「没跑完，回头继续」），而业务上限的正确语义应是「这批到此为止，成功」。

完整性判定不靠配额，靠「实得 vs 预期」：

```text
worker/handlers/changdu-source-sync.ts:54-68
  审计字段 expected_total / expected_pages / upstream_total
          / fetched_raw / fetched_unique / duplicate_count
worker/handlers/changdu-source-sync.ts:47-52     停止原因六项枚举
worker/handlers/changdu-source-sync.ts:254-259   itemsReturned===0 → empty_page
                                                 fetchedRaw>=expectedTotal → expected_total_reached
```

配额只出现在**有副作用的动作**上，与只读同步分离：

| 常量 | 值 | 作用对象 | 证据 |
| --- | ---: | --- | --- |
| `CHANGDU_PROMOTE_ON_SYNC_DEFAULT_MAX_PER_TASK` | 50（env 可覆盖） | 同步后自动提级 | `changdu-source-sync.ts:29-30,206-210` |
| `CHANGDU_PROMO_CLAIM_MAX_SOURCE_ITEM_IDS` | 1000 | 人工勾选领推广码 | `changdu-promo-claim-limits.ts:1-3,23-28` |
| `MAX_PAGE_SIZE` | 20 | 单页请求 | `changdu-dry-run.ts:28,143` |

反证检索范围：`changdu-source-sync.ts` 全文无 `maxItems` / `maxDramas` / 任何条数配额概念。

**结论**：`1000` 在 CPS 里只用于「人工勾选、消耗上游配额」的领码动作，从不用于只读目录镜像。
海阅 catalog sync 是只读镜像，**不设业务上限**。

### 1.2 Preview 触发：范围继承调用批次，无全站游标

CPS 有两条 Preview 管线，都不是独立调度，都由上游批次收尾时挂载：

**管线一 · 北斗（挂在剧目列表同步之后）—— 本包采用的 S1 形态**

```text
worker/handlers/beidou-list-sync.ts:44        导入 enqueuePostDramaSyncJobs
src/lib/post-drama-sync-jobs.ts:262-311       逐部按 dramaId 建 preview_sync 任务
                                              params.dramaIds = [dramaId]
src/lib/post-drama-sync-jobs.ts:297           hasActivePreviewSyncTask 去重
```

即：本次同步到哪些剧，就为哪些剧建 preview 任务。**与 Owner 表述完全一致。**

**管线二 · 畅读（挂在文章发布之后）—— 本包不采用**

```text
worker/handlers/batch-generate.ts:151         enqueueChangduPreviewCatalogForArticleBatch
src/lib/changdu-preview-catalog-enqueue.ts    originTaskId + articleIds → sourceItemIds
worker/handlers/changdu-source-sync.ts        全文零 preview 引用（畅读书目同步不触发预览）
```

**范围与幂等**：

```text
changdu-preview-catalog-enqueue.ts:200-213    originTaskId 查重
changdu-preview-catalog-enqueue.ts:330-341    P2002 → already_enqueued
changdu-preview-catalog-enqueue.ts:311        totalCount = sourceItemIds.length（不截断、不分批）
```

准入过滤全部是**准入判定**而非配额：文章已发布/未删/非 hidden（`:96-100`）、剧 active 且非
restricted/takedown 且有推广链接（`:102-107`）、账号可路由：恰好 1 账号 + 恰好 1 份有效凭证
（`:109-134`）、剧场在自动白名单内（`:284-287`）、目录新鲜则跳过（`:292-295`）。

**全站游标：不存在。** 全域检索无跨执行持久游标、无 offset 记忆、无「上次扫到哪」状态。
唯一命中 `cursor` 的是 `worker/handlers/changdu-preview-catalog-sync.ts:67-71` 的
`let cursor = 0` —— 对本次传入 `sourceItemIds` 做并发遍历的内存数组下标，函数返回即消失。

**调度模型**：CPS 无 scheduler 目录、无独立调度进程。唯一定时器是
`src/instrumentation.ts:10-18` 的 `node-cron`（每分钟），职责是把到点文章翻成已发布
（`source: "scheduled_publish"`，`:58`），不请求上游、不扫目录、不枚举剧库。
`worker/index.ts:42-60` 的 `TASK_TIMEOUT_MS_BY_TYPE` 是僵尸任务回收超时表，不是排程表。
**不存在**增量 scheduler 与全量 scheduler 的双轨设计。

### 1.3 Preview 侧可直接对齐的常量

```text
src/lib/changdu-preview-catalog-task.ts:2-5
  CHANGDU_PREVIEW_CATALOG_FRESH_MS   = 24 * 60 * 60 * 1000   新鲜度窗口
  CHANGDU_PREVIEW_CATALOG_CHUNK_SIZE = 25                    分块
  CHANGDU_PREVIEW_CATALOG_CONCURRENCY= 2                     并发
  CHANGDU_PREVIEW_SOURCE_TIMEOUT_MS  = 20_000                单来源超时
src/lib/changdu-preview-catalog-task.ts:29                   params 数组上限 5_000 → 拒绝
```

⚠️ 关于 `5_000`：它是 **params 合法性边界**（超出直接判定 params 非法并拒绝整个任务，
**不截断、不分批**），与 `sourceItemIds` 的业务规模无关。海阅可对齐同形态的
params 卫生校验，但不得把它当作业务配额，也不得用它替代 §2.1 删除的业务上限。

---

## 2. 书目同步改动

### 2.1 删除业务上限，保留技术保护

**现状**（需改动）：

```text
src/lib/tasks/moboreader.ts:14-15
  MOBOREADER_CATALOG_LIMITS = { maxPages: 2_000, maxItems: 1_000, ... }
src/lib/tasks/moboreader.ts:104-116
  入队期算术预判：(pageEnd-pageStart+1) > maxPages → 拒
                 maxItems > 上限 → 拒
                 (pageEnd-pageStart+1) * pageSize > maxItems → 拒
src/lib/tasks/moboreader.ts:189            maxPages 进 payload
worker/handlers/moboreader.ts:24-25,40-41  payload 校验 max_pages_exceeded / max_items_exceeded
worker/handlers/moboreader.ts:83-91        pageCount 与 pageCount*pageSize > maxItems 复核
worker/handlers/moboreader.ts:175          SUM(returned_count) > maxItems → 抛
worker/handlers/moboreader.ts:300          response.items.length > maxItems → 抛
```

**改动**：

1. **删除 `maxItems` 全部业务语义**。删除 `src/lib/tasks/moboreader.ts:105,113,116`、
   `worker/handlers/moboreader.ts:41,87,175` 六处判定；`worker/handlers/moboreader.ts:300`
   保留但只留 `response.items.length > payload.pageSize` 这一半（协议一致性检查），
   删掉 `|| response.items.length > payload.maxItems`。
2. **删除入队期算术预判** `(pageEnd-pageStart+1)*pageSize > maxItems`。页数不再是业务上限，
   这个乘法失去依据。
3. **`maxPages` 降级为技术保护并改名**：`maxPages` → `safetyMaxPages`，默认 `2_000`，
   **必须支持环境变量覆盖**（键名 `MOBOREADER_CATALOG_SAFETY_MAX_PAGES`，对齐 CPS
   `CHANGDU_SOURCE_SYNC_SAFETY_MAX_PAGES` 形态）。
4. **错误码改名并改语义**：`max_pages_exceeded` → `safety_limit`。触发后任务收为
   **`partial_failed`**，不是 `failed`，不是成功终态（对齐 `changdu-source-sync.ts:241`）。
5. **停止原因枚举对齐 CPS 六项**，写入任务 `result`：

   ```text
   expected_total_reached | expected_pages_reached | empty_page
   | short_page | safety_limit | upstream_error
   ```

   其中 `empty_page`（本页零返回）与 `short_page`（返回数 < pageSize）即 Owner 所说的
   「空页 / 分页不前进」防死循环保护，CPS 已实装，逐项对齐
   （`changdu-source-sync.ts:47-52,254-259`）。

**明确不做**：不新建 `catalog_scan_task_novel` 或任何 quota 去重表；不做唯一小说计数；
不做全目录 cursor。重复数据继续依赖既有幂等——`novel_source_identity_key`
（`prisma/schema.prisma:349`，唯一键 `(channelAppId, externalBookId, sourceLanguageCode)`）
配合 upsert。

### 2.2 checkpoint 与完整性判定

**checkpoint 机制保留不动**：`CatalogScanTaskItem` 的 `executionToken` / `leaseEpoch` /
`lockedUntil` / `heartbeatAt` / `returnedCount`、父任务 `lastCompletedPage` 与跨进程续跑，
均已通过 P1 验收，本轮不重写。

**完整性判定改为「实得 vs 预期」**，落到既有列，零 migration：

| 海阅既有列 | 语义 | CPS 对应 |
| --- | --- | --- |
| `catalog_scan_task.batch_expected_count` | 本批预期条数 | `expected_total` |
| `catalog_scan_task.batch_actual_count` | 本批实得条数 | `fetched_raw` |
| `catalog_scan_task.catalog_observed_total` | 上游 `totalCount` 水位，**只记录不判定** | `upstream_total` |

`batch_actual < batch_expected` → `partial_failed`（施工规划 P2 验收第 2 条已有此口径）。

---

## 3. Preview 自动触发（S1）

### 3.1 落点

Owner 已确认 **S1**：Preview 挂在书目同步之后，范围继承本次同步集合。

海阅 schema 早已为此预留，无需新表：

```text
prisma/schema.prisma:604-633  ChannelSyncTask
    taskType / channelAccountId / channelAppId / operationScopeHash
    requestToken(unique) / mode / status / totalCount / params
prisma/schema.prisma:635-663  ChannelSyncTaskItem
    novelSourceItemId + 租约四件套 + @@unique([taskId, novelSourceItemId])
prisma/schema.prisma:402-418  NovelChapterContent.sourceFetchId → ChannelSyncTaskItem
```

`ChannelSyncTask` 当前在 `src/` 与 `worker/` 中**零引用**（仅 schema 存在），本轮启用它。
`materializeChangduPreview()` 的入参 `sourceFetchId` 正是 `ChannelSyncTaskItem.id`
（`src/lib/preview/changdu-materialization.ts:85`），接线天然吻合。

### 3.2 触发链

```text
catalog_scan 任务全部页提交完成（终态 completed 或 partial_failed）
  └─ 收集本次实际 upsert 命中的 NovelSourceItem.id 集合 S
     └─ 逐项施加准入过滤（§3.3）得到 S'
        └─ S' 非空 → 在同一事务内创建 1 个 ChannelSyncTask
                     + |S'| 个 ChannelSyncTaskItem
           └─ worker 领取 → 调用 getchapterinfo → materializeChangduPreview()
```

**硬约束**：

- 复用**同一个** worker 进程与 handler registry（`worker/handlers/moboreader.ts:326-335`
  的 `createHandlerRegistry`，新增一个 family，不新建 worker）；
- 复用**同一对** feature flag：`FEATURE_NOVEL_CATALOG_SYNC` + `NOVEL_CATALOG_SYNC_ALLOW_WRITE`。
  只开第一把 → 可入队但零业务写入；
- 复用既有租约 / `execution_token` / `lease_epoch` / 心跳 / 僵尸回收；
- **禁止**新建第二套同步逻辑、第二个 worker、第二套 flag。

**幂等**：`ChannelSyncTask.requestToken` 由父任务确定性派生：

```text
requestToken = "moboreader.preview_refresh.v1:" + <catalogScanTaskId>
```

对齐 CPS `originTaskId` 唯一的形态（`changdu-preview-catalog-enqueue.ts:200-213,330-341`）。
唯一键冲突 → 返回 `already_enqueued`，**不是错误**，父任务不因此失败。

### 3.3 准入过滤（是准入判定，不是配额）

逐项对齐 CPS `changdu-preview-catalog-enqueue.ts`：

| 过滤项 | 规则 | CPS 对应 |
| --- | --- | --- |
| 来源有效 | `NovelSourceItem.deletedAt IS NULL` 且已绑定 `novelId` | `:102-107` |
| 渠道链路 active | `ChannelApp` / `Channel` / `SourceApp` 均 active | `:110-118` |
| 账号可路由 | 该来源恰好解析出 1 个 active `ChannelAccount` 且恰好 1 份有效凭证 | `:119-134` |
| 剧场白名单 | `SourceApp.code` 在自动白名单内，env 可配，**未设时 fail-closed** | `:284-287` |
| 新鲜度跳过 | `NovelPreviewPolicy.lastRefreshedAt` 在 24h 窗口内则跳过 | `:292-295` + `FRESH_MS` |
| 可选 allowlist | 环境变量给定时只放行清单内来源 | `:296` |

跳过原因必须计数并写入父任务 `result`（对齐 CPS `skipReasonCounts`），便于运维定位。

**不做**：不设 `sourceItemIds` 条数业务上限；不截断；不分批投递。本次同步命中多少就是多少
（对齐 `:311` `totalCount: sourceItemIds.length`）。params 可加与 CPS 同形态的合法性边界
（数组非空、元素为合法 uuid、长度上限用于拒绝畸形 params），但该边界不得表现为业务配额。

### 3.4 执行参数

对齐 §1.3 的 CPS 常量，全部 env 可覆盖：

```text
分块         25    ← CHANGDU_PREVIEW_CATALOG_CHUNK_SIZE
并发          2    ← CHANGDU_PREVIEW_CATALOG_CONCURRENCY
单来源超时  20s    ← CHANGDU_PREVIEW_SOURCE_TIMEOUT_MS
新鲜度窗口  24h    ← CHANGDU_PREVIEW_CATALOG_FRESH_MS
```

### 3.5 人工触发

`createMoboreaderPreviewRefreshTask()`（`src/lib/tasks/moboreader.ts:275-288`）改为建同一张
`ChannelSyncTask`，与自动触发**完全同路**，仅 `params.trigger` 取值不同（`manual` / `auto`）。
人工触发的 `requestToken` 由调用方显式提供。

单 active 约束对二者一视同仁：同账号 × 应用 × 任务类型已有 active 任务时，后到者被拒，不排队。

---

## 4. 无需改动项（加回归断言防回退）

| 冻结项 | 现状证据 | 断言 |
| --- | --- | --- |
| 4 · `paid_from_chapter` 只存不动 | `src/contracts/publish-gate.ts:133-139` 四字段恒 `false` 且对象冻结；写入点 `changdu-materialization.ts` 仅落库无分支 | 见验收 28 |
| 5 · cap=3 是默认值 | `changdu-materialization.ts:6` 仅用于首次建策略行；`:122-128` 每次刷新重读 `policy.maxMaterializedChapters` | 见验收 30 |
| 7 · 匿名试读 | 全仓零公开路由、零 session 检查；schema 无读者账户模型（仅 `AdminIdentity`/`AdminSession`） | 见验收 29 |

---

## 5. 阻塞链

```text
P2-05 整体 DONE（冻结 3：不拆分验收）
  └─ 依赖 试读物化生产链路闭环
      └─ 依赖 getbydataid 可调用
          └─ 依赖 materialType 的「值」与「来源」
              └─ 依赖 一次 Owner 授权的生产只读浏览器捕获   ← 唯一解
```

取证结论 `P2_05_MATERIALTYPE_EVIDENCE_NOT_PROVEN` 未变：字段名已证
（`P0_BROWSER_INTERFACE_PROBE.md:61` 请求侧、`P0_SECOND_BROWSER_PROBE.md:110` 响应侧 `number`），
**值与来源零证据**；本地全域无副本；CPS 全仓零命中；git 历史从未出现过该值。

工程侧无路可走：不得猜枚举、不得由字段名推断、不得类推短剧默认值。

**下次捕获必须拿到**（`materialType` 是数字不是密钥，可原值保留；`kocCode` / `publicUrl` /
正文照旧脱敏）：

1. `materialType` 字面值 ← 硬阻断
2. `dataId` 字面值 + 同一本书 `getlistpc` 行的 `id` / `seriesId`（`dataId` 来源同样未证，是并列缺口）
3. 同次调用的 `agencyId` / `projectType` / `language` 取值
4. 该 `getlistpc` 行的完整 key 集合，判定 `materialType` 是否 per-item 存在
5. 响应侧 `data.materialType` 字面值，验证请求值与响应值是否相等

样本量 **≥3 本书 × ≥2 语种**。只抓 1 本无法区分「每本不同 / 渠道内固定 / 协议常量」。

**执行顺序建议**：§2 与 §3 不依赖 `materialType`，可先行实现并自测；但按冻结 3，
**完成也不得报 DONE**，须等物化链路接通后整体验收。

---

## 6. 验收清单

施工规划 v0.2.1 P2 既有 20 条继续有效。本轮**替换**原执行包的 21–30 条：

| # | 验收项 |
| ---: | --- |
| 21 | 全仓不存在 catalog sync 的条数业务上限；`maxItems` 业务语义已删除 |
| 22 | 页预算耗尽 → `stop_reason=safety_limit` 且任务为 `partial_failed`，不是 `failed`、不是成功终态 |
| 23 | `SAFETY_MAX_PAGES` 可由环境变量覆盖，代码中无不可配置的硬常量 |
| 24 | 停止原因六项枚举齐备并写入任务 `result`；`empty_page` / `short_page` 可被构造触发 |
| 25 | `batch_actual < batch_expected` → `partial_failed`；`catalog_observed_total` 只记录不参与判定 |
| 26 | 重复数据仅靠 `novel_source_identity_key` + upsert 收敛；全仓无 quota 去重表、无唯一计数逻辑 |
| 27 | 全仓无跨执行持久游标、无全目录轮转、无增量/全量双轨 scheduler |
| 28 | `PAID_FROM_CHAPTER_POLICY` 四字段恒 `false` 且对象冻结（回归断言） |
| 29 | 公开面零 session / 零读者鉴权 / 零 RBAC 判定（护栏断言） |
| 30 | 改数据库 `maxMaterializedChapters` 后下次刷新立即生效，无需重启或发版 |
| 31 | catalog sync 终态后自动创建 Preview 任务，范围**恰好等于**本次同步命中的来源集合减去被跳过项 |
| 32 | 自动触发与人工触发落到**同一张** `ChannelSyncTask`、同一 worker handler、同一双闸；全仓无第二条同步执行路径 |
| 33 | 自动触发同样受双闸约束：只开 `FEATURE_NOVEL_CATALOG_SYNC` 不开 `ALLOW_WRITE` → 可入队、零业务写入 |
| 34 | 同一父 catalog 任务重复收尾（重试/续跑）只产生一个 Preview 任务，第二次返回 `already_enqueued` 且父任务不失败 |
| 35 | 24h 内已刷新过的来源被跳过，跳过原因计数写入父任务 `result` |
| 36 | 剧场白名单未配置时 fail-closed（零来源入选），不是全放行 |
| 37 | Preview 任务不设条数业务上限；本次同步命中多少即投递多少，不截断不分批 |
| 38 | 分块 25 / 并发 2 / 单来源超时 20s / 新鲜度 24h 均可由环境变量覆盖 |

---

## 7. 边界

**本包不授权**：

- merge（Owner 明令禁止，直至全量验收通过）
- 任何 Schema / migration 改动（§2 §3 全部落在既有列与既有表）
- 公开路由、canonical、sitemap、IndexNow（P2-03 / P2-07 / P2-08）
- 发布评估器（P2-07）
- `claimPromo`、`public_redirect_code`、`/go`（P3 / 另有归属）
- 后台 UI 页面（P2-04）
- C 端登录、付费、章节解锁
- `payEpisFrom` 的任何自动反应
- AI 补章节、占位正文、按 `allEpis` 造章

**路径归属**：本包涉及 `src/lib/tasks/`、`src/lib/adapters/`、`src/lib/preview/`、`worker/`
——全部为 Codex 独占写入（CLAUDE.md §3.2）。

---

```text
RESULT=P2_05_REVISION_SPEC_FINAL
OWNER_DECISIONS=7 项冻结 + S1
OVERDESIGN_REMOVED=1000 配额 / 去重表 / 全目录 cursor / C1-C2-C3 轮转
BLOCKING=materialType + dataId（需 Owner 授权生产只读浏览器捕获）
NEXT_GATE=CODEX_EXECUTE_SECTION_2_AND_3
```
