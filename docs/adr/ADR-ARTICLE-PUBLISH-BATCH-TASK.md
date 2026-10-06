# ADR：文章「全选 → 后台批量发布」任务

- 日期：2026-10-06（北京时间）
- 状态：已实现，待复核发布（并入 v0.5.9，Owner 2026-10-06 同意）
- 开发单：`开发单_Sonnet_文章批量发布后台任务_全选拆分_2026-10-06.md`
- 分支：`feat/article-batch-publish-task`，基线 `integration/v0.5.9-2026-10-06@5ef9ecb`
- 相关：`ADR-PUBLICATION-PREVIEW-ENQUEUE.md`（试读按批合并入队）、`ADR-SITEMAP-MANUAL-ENTRYPOINTS.md`、
  `ADR-WO6-INDEXNOW-LIGHT-FAIRNESS.md`（轻量通道）、`ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`（批次级控制的先例）

## 1. 背景

后台「批量发布」原先是在点按钮的那次网页请求里**同步逐篇**发布，服务端上限 200 篇
（`MAX_BATCH_SIZE`）；跨页「全选当前筛选」是前端按 200 一批循环调用同步 action。要发 2.9 万篇就是
146 次往返，页面要一直开着，没有进度、不能暂停、不能中止，也没有失败汇总。运营需要的是
**一次全选、后台排队、看得到进度、能暂停或中止、失败能重试**。

CPS 短剧站的做法不照搬：跨页超过 500 篇时直接按筛选 `updateMany` 改状态，没有后台任务，会漏掉评论生成与
预览同步，还会改写已发布文章的发布时间。海阅已经有现成的模子——「批量生成草稿」
（`article.generate.batch.v2`）：父任务按筛选枚举、再拆成每 200 篇一个子任务。批量发布照这个结构做。

## 2. 决定

### 2.1 任务结构（照搬 `article.generate.batch.v2`）

| 层 | 类型 | 说明 |
| --- | --- | --- |
| 父任务 | `article.publish.batch.v1` | 只有一条枚举条目；worker 在一个 RepeatableRead 事务里按筛选快照枚举**草稿**，每 200 篇建一个子任务。登记进 `PARENT_BATCH_TASK_TYPES`，进度/状态从子任务汇总。 |
| 子任务 | `article.publish.v1` | 每个条目一篇文章；worker 逐条目调用与按钮**同一个**发布核心 `applyPublishTransition`。 |

- 筛选快照是文章列表的筛选轴去掉 `status`（枚举处固定为 `draft`）；枚举复用文章列表页同一个 WHERE
  （`listArticleIdsForFilter`，按 `id` 键集游标翻页，不会因为"发布改了 `updatedAt`"而漏行或重复），
  提交时用同一个 WHERE 数草稿（`countArticlesForFilter`）做上限（50,000）与非空校验。
- 筛选里明确选了非草稿状态 → 交集恒空 → 入队拒绝（`filter_status_not_draft`），不静默改写。
- 提交人写进任务参数，worker 以该管理员身份发布，发布审计 `actor` 就是提交人。权限与按钮一致：
  `content:publish` + 两步验证的 fresh 授权；新增 action id `admin.article.publish_batch_task`
  （单独一个 id，限流与审计里能区分"提交了后台任务"和"同步逐篇发布"）。
- 父任务 `expiresAt = submittedAt + 6h` 只约束"多久内必须被领取并完成枚举"；**子任务不过期**——条目执行时
  仍会重新判定文章状态与发布检查，一个暂停了几天再恢复的批次不会发布掉已经变化的文章，而"重试失败项"
  也不会被一个过期时间卡死。
- 子任务的 `operation_scope_hash` 带父任务编号：活跃 scope 唯一索引不会因为两个批次恰好枚举出同一组文章
  而让后一个批次的整个枚举事务失败。

### 2.2 发布核心只加一个可选参数

`applyPublishTransition(db, input, batchPreviewArticleIds?, options?)` 的第四个参数
`{ deferSitemapRefresh?: boolean }`：缺省行为**逐字不变**（同步按钮、同步批量发布从不传它）；传 `true`
时首次发布不逐篇触发站点地图，IndexNow 派发不受影响。发布检查规则、写库、审计、缓存失效都没动
（`tests/backend/publish-gate/defer-sitemap-option.test.ts` 把两种姿势逐项对照）。

### 2.3 请求编号与重放

每篇用 `publishBatchItemRequestId(批次编号, 文章编号)`，批次编号是入队的 `requestId`：稳定、不含序号或随机数。
条目被重放（租约过期重领、重试失败项、提交与落库之间进程死掉）时，`applyPublishTransition` 的重放检查能认出
"这一篇已经用这个编号发布过"，返回 `published` 但 `wrote = false`，**不重复触发首次发布副作用**，也不会
撞 `operation_audit_admin_request_action_uidx`。

### 2.4 执行时先看一眼文章状态

按钮路径没有这层保护（人点的是眼前这一行），后台任务必须有：从提交到执行可能隔了很久，文章可能已经被人发布、
下线或删除。条目执行时先读文章状态：
- 已删除/不存在 → 跳过（`not_found`）；
- 不是草稿，且**不是本条目自己（同一个稳定请求编号）发布过的重放** → 跳过（`not_draft`），不调用发布核心——
  否则一个过期批次会把已下线的文章重新发布出去；
- 是本条目自己的重放 → 照样走发布核心，拿到与第一次一致的结果。

发布检查不通过 → 条目 `failed`，`error.code = publish_gate_rejected`，原因码数组写在 `result.reasons`
（对外汇总见 §2.7）。并发冲突（发布核心已回滚）→ `retry`，不是失败。未预期的异常不吞，交给 worker 运行时
记成条目失败，由运营"重试失败项"。

### 2.5 发布后的副作用：只改触发的次数与时机

| 副作用 | 做法 |
| --- | --- |
| 试读抓取 | 每个子任务结束后，把这个子任务**已发布的文章**合并交给 `dispatchPublicationPreviews` 派发一次（按渠道账号 × 应用分组，每组一个任务；试读任务的 scope hash 是这批书的摘要，所以相邻子任务各建各的、互不冲突）。勾「发布时暂不抓试读」则一个都不建，子任务记 `previewDispatch.skipped`，父任务 `result.previewSkippedBookCount` 记录跳过的本数（按书去重）。默认不勾，和按钮一致。 |
| 站点地图 | 逐篇不触发（`deferSitemapRefresh`）；整批没有任何 `pending`/`processing` 条目之后触发**一次**。用水位线 `sitemapRefresh.coveredPublishedCount` 判断"还差没差"：一次完整跑完只触发一次，暂停/恢复或重试失败项之后新增的发布才补一次。实测：全选 1,000 篇触发 **1** 次（每篇都触发的变异版是 1001 次，场景 D 变红）。 |
| IndexNow | 沿用现有首次发布的派发口径（逐篇 `enqueueIndexNow`），不改。**但见 §4.1 的已知差异**。 |

**收尾的触发与健壮性。** 触发点是子任务 handler 注册的 `afterItemCommit`（每个条目落库提交之后）。它是"尽力而为"的
观察者——进程恰好死在"条目提交"与"收尾"之间，这一轮收尾就丢了。所以收尾**不靠一次性标记**，而是每次都从条目行重新
推导，并用计数水位线判断（子任务 `previewDispatch.publishedCount`、父任务 `sitemapRefresh.coveredPublishedCount`）：
丢过的收尾会被下一次补上；派发本身都是幂等的（试读按书加锁、请求令牌含文章集合；站点地图自带合并/跟进机制），重复
调用最坏是一次空转。整批收尾在父任务行锁内完成，双 worker 不会各触发一次。"整批中止"在提交之后也主动收尾一次——
中止时若恰好没有在途条目，就不会再有条目提交来触发收尾，已发布的那部分就没人补站点地图与试读。

### 2.6 跑在 worker-light

发布只做数据库操作、不调上游，符合轻量通道规则（`worker-lanes.mjs` 禁止的是上游类任务）。主 worker 每一轮都先处理
试读抓取，如果发布任务跑在主 worker 上，前面子任务建出来的试读任务会插队，后面的发布要等十几个小时。

- 两个类型加进 `APPROVED_LIGHT_TASK_TYPES`；`WORKER_LIGHT_TASK_ALLOWLIST` 的四份 env 样例、本地 compose 环境脚本
  默认值、X8 级别表同步；**主通道白名单不得出现**（重叠被 `worker_lane_allowlist_overlap` 拒绝）。
- main 通道的配置校验行为与现有规则一致：不为这两个类型单列禁令（与 `sitemap_refresh` 等轻量类型同口径，只有
  IndexNow 两个类型是 main 禁用的）；部署配置层的硬约束是两条白名单互斥。
- 预检脚本（`scripts/preproduction/lib.sh`）里没有任何断言枚举或限定轻量白名单的内容：只有 `indexnow_delivery`
  成员判定与交给 `validateWorkerLaneEnvironment` 的同一份 env；写闸登记制（`PREPROD_APPROVED_OPEN_WRITE_GATES`）
  是六个封闭枚举，**不新增写闸**——后台批量发布和按钮一样由管理员带两步验证主动发起，按钮本身也没有写闸。
- 不加迁移、不新增环境变量；`WORKER_LIGHT_TASK_ALLOWLIST` 本来就透传进 worker-light 容器。

### 2.7 任务中心

- 进度：父任务从子任务汇总（`PARENT_BATCH_TASK_TYPES`）。
- **整批暂停 / 恢复 / 中止 / 重试失败项**：父任务枚举结束后原始状态是 `completed`，真正在跑的是名下子任务；建稿批次的做法
  是让运营到子任务列表逐个点（146 个子任务就点 146 次），对暂停/中止来说等于没有。所以**只对这一种父任务类型**，
  现有的四个动作级联到名下子任务（`src/lib/tasks/article-publish-batch-control.ts`，由任务管理服务调用，沿用同一组
  审计动作与幂等重放）；其它任务类型的行为一个字不变。枚举阶段（父任务自己还是 `pending`/`processing`/`paused`）
  走原有单任务路径。语义与单任务版本一致：暂停时 `pending` 条目原样保留、在途条目跑完；中止不可逆，剩余
  `pending` 条目标记为 `skipped`（`task_manually_aborted`，"中止前未尝试"），已发布的保持；重试失败项只重置 `failed`
  条目，已发布的文章靠稳定请求编号不会重复发布。
- 父任务详情新增「发布结果」：已发布 / 发布检查未通过（按原因汇总，用发布检查自己的中文文案）/ 执行时已不是草稿 /
  已不存在 / 中止后未尝试 / 待处理，以及试读与站点地图的收尾情况。全部由条目行用聚合 SQL 推导，对外只暴露计数与
  白名单化的原因码。

## 3. 数据库与授权

- **零迁移、零索引、零 grants 变更、零新环境变量。** JSON 键登记见 `docs/governance/database-governance.md` §3.4
  本日小节与 §12 改动日志。
- 发布核心原本只在 web 进程里跑（`web_app`），现在由 worker-light（`worker_app`）执行。这个项目出过两次"单测与复核
  都测不出来的 worker 缺授权"事故，所以验收用真实角色：入队与任务控制走 `web_app`，枚举、逐篇发布、IndexNow 出站、
  试读合并入队、站点地图入队全部走 `worker_app`，一次性 postgres:16.14 + 真实迁移 + `grants.sql`
  （`scripts/run-article-publish-batch-postgres-verification.sh`），整条路径无 `permission denied`。`worker_app` 既有授权
  已覆盖：`article`/`novel`/`promo_link`/`novel_chapter(_content)` 的 SELECT，`article`/`novel`/`generic_task(_item)`/
  `channel_sync_task(_item)`/`indexnow_outbox` 的 INSERT/UPDATE，`operation_audit` 的 INSERT + SELECT（RETURNING 用到
  的列）。

## 4. 已知差异与限制（需要主控/Owner 知晓）

### 4.1 IndexNow 出站开关在 worker 容器里没有透传（与既有 compose 契约冲突，**未擅自改**）

`enqueueIndexNow` 读的是**当前进程**的 `FEATURE_INDEXNOW_OUTBOX` / `INDEXNOW_OUTBOX_ALLOW_WRITE`。现有 compose 只把这
两个开关透传给 web（"发布"按钮在 web 进程里发布），并且 `tests/backend/runtime/p1-12-compose-contract.test.ts` 把
"worker 不得带 INDEXNOW_OUTBOX"钉成了契约（"only to their relevant processes"）。后台批量发布挪到 worker-light 之后，
这条设计前提不再成立：**一旦 Owner 打开 `indexnow_outbox` 写闸（两个开关在 web 上为 true），后台任务发布的文章不会写
IndexNow 出站队列，与按钮不一致**。

- 仓库内的现状：`x8-levels.json` 三个级别、预生产与 UAT 的 env 样例里这两个开关都是 `false`（IndexNow 出站闸默认硬关），
  这种状态下后台任务与按钮行为一致（都不入队）。生产机上这两个开关的实际取值在仓库内无法核实，**发版前请主控在目标机
  env 里确认它们仍是 `false`**；若已经是 `true`，本次发版就会出现差异，必须先按下面的办法处理。
- 开发单的红线（"不新增环境变量，只追加 `WORKER_LIGHT_TASK_ALLOWLIST` 的取值""现有契约不改"）与这条差异无法同时满足，
  按施工纪律停下来说明而不是自行扩大范围。**需要决定的是**：在 IndexNow 出站闸打开**之前**，把这两个开关透传给
  worker 与 worker-light（取值与 web 同源，没有新增变量；`worker-light-compose-contract.test.ts` 要求 worker 与
  worker-light 环境逐项一致，所以要两个服务同时加），同步修改 p1-12 契约里"worker 不带 OUTBOX"的断言，
  并在 `x8-validate-compose.mjs` 里补断言。这一步应并入 WO6（IndexNow 生产开闸）的变更，而不是本次发版。

### 4.2 worker 里没有 Next 请求上下文，发布后的缓存失效是空操作

`applyPublishTransition` 提交后调用的 `revalidatePath`/`revalidateTag` 在 worker 进程里必然抛出，被
`safeRevalidatePath`/`safeInvalidatePublicCache` 吞掉（该模块的既有"隔离契约"）。所有公开路由都是
`force-dynamic`，没有 Full Route Cache 可失效；唯一受影响的是 `getActiveLocales()` 的 300 秒
`unstable_cache`——最长 5 分钟后自然过期。2026-10-06 的命令行全量发布面对的是同一情况。

### 4.3 轻量通道按创建时间公平排队

`claimPendingItem` 按条目 `created_at` 取最早的待处理条目。一个 2.9 万篇的批次，条目在枚举时一次性建好，期间其它
轻量任务（站点地图刷新、每日兜底、首页轮播、IndexNow 扫描）如果是更晚创建的，会排在这批条目之后（实测约 17–30 毫秒/篇，
2.9 万篇约 8–15 分钟）。本批自己的站点地图刷新任务也是最后建的，天然排在最后。

### 4.4 其它

- 中止时若恰好有在途条目，收尾由那个条目提交后的 `afterItemCommit` 完成；若没有在途条目，由中止动作提交之后主动
  收尾（§2.5）。暂停期间不收尾（仍有 `pending` 条目）；暂停很久不恢复的话，已发布部分的站点地图要等恢复/中止，或
  等每日兜底（`sitemap.daily_fallback.v1`）。
- worker 不复核提交人此刻是否仍有 `content:publish` 能力或是否已被停用（与建稿批次同一取舍）；需要撤销只能中止批次。
- 校验：条目逐篇独立事务，系统性故障（数据库不可用）会让条目快速失败，需要运营修复后"重试失败项"——失败不破坏数据，
  重试幂等。

## 5. 部署与回滚

- **部署**：服务器 env 里 `WORKER_LIGHT_TASK_ALLOWLIST` 追加 `article.publish.batch.v1,article.publish.v1`，完整新值为
  `sitemap_refresh,sitemap.daily_fallback.v1,home_carousel.compute.v1,indexnow.sweep.v1,article.publish.batch.v1,article.publish.v1`
  （以当前服务器值为准，只追加这两个；`WORKER_TASK_ALLOWLIST` 一个字不动）。
- **回滚到 v0.5.8**：v0.5.8 的 `APPROVED_LIGHT_TASK_TYPES` 不认识这两个类型。实际推演：
  1. 白名单未恢复就回滚 → v0.5.8 的预检 `preprod_assert_worker_lanes` 以
     `worker_light_task_unapproved: article.publish.batch.v1,article.publish.v1` 退出 65，**回滚在改动任何东西之前就被拦下**
     （fail closed）；
  2. 绕过预检直接起 v0.5.8 的 worker-light → 启动不会被拒绝，而是把这两个类型当作"未注册"排除并打一行 error 级别的
     `worker_task_allowlist` 日志（`invalid` 里列出），按剩余四个类型继续跑；
  3. 结论：**回滚时必须同时把 env 恢复**（从 `WORKER_LIGHT_TASK_ALLOWLIST` 摘掉这两个类型），再执行 v0.5.8 的回滚。
  4. 库里遗留的 `article.publish.*` 任务不会被 v0.5.8 消费（待处理条目原样保留，没有数据损坏，也没有 schema 差异）；
     回到 v0.5.9 并恢复 env 后会继续跑；如需放弃，在 v0.5.9 的任务中心对父任务整批中止。
- **部署后只读验收要点**（全部只读，不提交任何后台任务）：
  1. worker-light 启动日志里 `worker_task_allowlist` 事件 `level: info`，`effective` 含两个新类型、`invalid` 为空；
     worker（主通道）同一事件里**没有**这两个类型；
  2. `docker compose config`（或容器内 `env`）确认 worker-light 的 `WORKER_TASK_ALLOWLIST` 带两个新类型、worker 的不带；
  3. 后台「文章」列表：只勾当前页时没有「后台批量发布」入口，同步「批量发布」照旧；点「选择符合当前筛选条件的全部 N 条」后
     出现「后台批量发布（N 篇）」与「发布时暂不抓试读」（只看见，不要点）；
  4. 目标机 env 里 `FEATURE_INDEXNOW_OUTBOX`/`INDEXNOW_OUTBOX_ALLOW_WRITE` 仍是 `false`（§4.1）；
  5. 任务中心列表/详情页对既有的建稿批次（`article.generate.batch.v2`）仍显示"到子任务列表逐个操作"的提示，没有出现发布结果区块。
