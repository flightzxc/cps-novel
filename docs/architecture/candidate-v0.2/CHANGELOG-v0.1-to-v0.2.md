# CHANGELOG · candidate-v0.1 → candidate-v0.2

> 修订日期：2026-08-02
> 触发：Owner 第二轮八条裁决 + 七条内部结构修正 + CPS 五项同构性只读复核
> CPS 代码基线不变：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（v8.1.1，核实前后 `git status --porcelain` 均为 0 行）
> candidate-v0.1（GitHub `docs/architecture/candidate-v0.1/` @ `cb94981`）**未修改**；本目录为增量修订版。

---

## 一、Owner 裁决驱动的变更（8 条，`OWNER_DECIDED`）

| # | 变更 | v0.1 口径 | v0.2 口径 | 影响文件 |
| ---: | --- | --- | --- | --- |
| 1 | **分成比例退出准入** | `splitRatio >= 50` 为全局准入门槛：不满足 → `skipped`、不建 SourceItem | `ACCEPT_CHANNEL_CONTENT`：所有正常返回内容保存来源实体并允许建站内实体；splitRatio 只是渠道业务属性；渠道级筛选可选、默认关、不影响镜像落库 | 证据 §8.1；数据模型 `Novel.split_ratio` / SourceItem 索引；契约 §3.1 写入规则；计划 P2 任务二；验收 +2 条 |
| 2 | **跨语种不关联** | D-1 OPEN，临时按"形状 1:N、填充 1:1"处置；发布门槛含 hreflang 验证；硬约束"跨语种关系用 hreflang 表达" | Owner 正式裁决：一语种版本一 Novel 一页面体系；**不生成跨 Novel hreflang**；`NovelWork/TranslationGroup` 进 Post-V1。CPS 复核 `CPS_PARITY_CONFIRMED` | 证据 §8.2、D-1 关闭；架构 §4（门槛五项改、hreflang 行改、硬约束改）；数据模型 §1.2、§2.8；计划排除项 |
| 3 | **章节页全量进 SEO** | 仅第 1 章可索引；第 2+ noindex；试读页 canonical 指向详情页；`index_authorized` 默认 false | 详情 + 目录 + 全部物化章节页可索引、**self-canonical**、进 sitemap/IndexNow；结构要求（链回/导航/CTA/标记所属/标题去重）；N 章生成 N 页 + `max_materialized_chapters` 异常上限；授权位默认翻转 true 转为单本例外开关 | 证据 §8.3、D-3 大部关闭；架构 §6.1；数据模型 `NovelPreviewPolicy`；契约 §3.8 |
| 4 | **删除 payEpisFrom 自动下架** | "收费边界下调 → 自动置 withdrawn + 删正文"整条流程 + `last_paid_from_chapter` 触发字段 + P2-04 验收 | `chapterList[]` 是唯一真源；payEpisFrom 仅元数据；刷新 = hash 增量；缺失章节不得单次即删——推荐"连续 K 次 → `stale` 停展 + 人工，不硬删"（`CANDIDATE`，D-10 待冻结）。新增未知项 U-13 | 证据 §8.4；数据模型 `NovelPreviewPolicy`（删触发器）、`NovelChapter` +`stale` 态、SourceItem +miss 字段；契约 §3.3 刷新语义、§3.14 场景表 |
| 5 | **收益多账户** | "V1 建一个 ChannelAccount"；`RevenueDailyStat UNIQUE(project_type, stat_date)` | `Channel → ChannelAccount[1..N] → RevenueSyncScope[1..N]`；新增 `RevenueSyncScope` 实体；`UNIQUE(channel_account_id, project_type)` 与 `UNIQUE(revenue_sync_scope_id, stat_date)`；批次/快照键含 scope；金额 `Decimal/numeric` | 证据 §8.5；数据模型 §2.16（四表 → 五表）；计划 P4 冻结表更新 |
| 6 | **`/go` 公开短码** | PromoLink 单一 `code` 字段；`/go/:code` 按 code 查 | `upstream_code` / `public_redirect_code` 拆分；公开码唯一生成入口（改造 CPS `article-public-page-id.ts:32-44`）、DB 唯一、不可变、码变 URL 不变、禁 Adapter 自造；埋点记公开码。**CPS 复核如实登记：CPS 现状把真实码放公开 URL（`route.ts:94-98`）且无唯一约束——本条是修正而非复用** | parity §3；数据模型 §2.11、TrackingEvent；契约 §3.9/§3.11；架构矩阵 tracking 行 |
| 7 | **存储遵循 CPS（方案 A 推荐）** | "普通角色只见掩码"（超出 CPS 实践） | `CPS_CURRENT_STORAGE_BEHAVIOR` 实证后推荐方案 A：raw 镜像保留原文、后台明文、写路径锁、审计掩码；掩码表述撤回；方案 B 仅当出现读侧事故再议（`CANDIDATE`，D-11 待确认） | parity §4；数据模型 §2.11 敏感字段行；开放决策 D-11 |
| 8 | **无逐条人工审核** | §3.5 内容审核（`pending_review → approved/rejected`）；发布门禁"内容审核已通过" | 机器门禁 + 批量生成/发布 + 异常人工队列；九类异常清单；发布门禁改五道全机器。CPS 复核 `CPS_PARITY_CONFIRMED`（四态无审核态、批量直发、机器门禁） | parity §2；契约 §3.5/§3.7；架构 §6.2；计划任务与验收 |

## 二、内部结构修正（7 条，无需 Owner 仲裁）

| # | 修正 | 变更 |
| ---: | --- | --- |
| 1 | 单批完整性 | 拆 `catalog_observed_total` / `batch_expected_count` / `batch_actual_count`；单批判据 = 后两者对比；废除"本批抓取量 vs 全局 totalCount" |
| 2 | 首扫任务项 | 新增 `CatalogScanTask / CatalogScanTaskItem`（item = 页/页区间 + request_fingerprint）；SourceItem 存在后才用 `ChannelSyncTaskItem` |
| 3 | P2/P3 循环依赖 | 已有推广提取、PromoLink、公开码、`/go`、基础埋点移入 P2；P3 只剩主动生成（W9 门控）；V1 商业闭环在 P2 成立 |
| 4 | 标签关系表 | 新增 `NovelSourceItemLabel`（first/last_seen_at + active）；废除 ER 图中未定义的 `NovelLabel` |
| 5 | Active 互斥作用域 | 全局同类型 → `(task_type, channel_account_id, channel_app_id, operation_scope_hash)` 部分唯一 |
| 6 | dry-run 定义 | 统一为"零上游副作用 + 零正式业务资产写入；允许写 Task/Audit/ProbeResult"；废除"完全零写库" |
| 7 | 阶段命名 | P1–P4 = V1 施工阶段；"Phase 2" 全部改称 **Post-V1** |

## 三、CPS 同构性复核结论（新文档 `novel-v1-cps-parity-review.md`）

| 项 | 结论 | 决定性证据 |
| --- | --- | --- |
| 1 · 跨语种关联/hreflang | `CPS_PARITY_CONFIRMED`（无跨源语种关联；hreflang 只连自产翻译文章） | `drama-hreflang.ts:16-32`；`schema.prisma:279`；`eligibility.ts:6` |
| 2 · 逐条人工审核 | `CPS_PARITY_CONFIRMED`（不存在审核态；机器门禁 + 批量） | `constants.ts:6-11`；`article-generation.ts:63-90`；`article-actions.ts:563-576` |
| 3 · `/go` 码 | ⚠️ **CPS 与 Owner 认知不符**：真实码进公开 URL、无唯一约束、无不可变保护；短码生成机制单一真源在 `article-public-page-id.ts` | `route.ts:94-130`；`drama-cta.ts:48-55`；`schema.prisma:32` |
| 4 · 存储分布 | `CPS_CURRENT_STORAGE_BEHAVIOR`：4 处受控真实值 + 后台明文 + 写锁 + 审计掩码 → 推荐方案 A | `adapters/changdu.ts:131`；`changdu-links/page.tsx:168-169`；`changdu-promo-claim.ts:371-384` |
| 5 · 缺失内容下架 | 纯 upsert 状态标记、无删除路径、`stale` 预留未用 → 推荐连续缺失 + stale + 人工 | `preview-sync.ts:379-409,25-30,81/92/427` |

## 四、文件对照

| v0.2 文件 | 相对 v0.1 |
| --- | --- |
| `novel-v1-evidence-reconciliation.md` | 增量修订：头部口径、splitRatio/试读/SEO 行被替代标记、D-1/D-3 状态、新增 §8（v0.2 裁决回灌 + 结构修正清单） |
| `novel-v1-system-architecture-v0.2.md` | 多语言 §4（门槛/hreflang/硬约束）、§6.1 SEO 口径重写、§6.2 后台、矩阵 tracking 行、排除项 |
| `novel-v1-logical-data-model-v0.2.md` | §1.2 重写（D-1 关闭）；`Novel`/`SourceItem` 分成字段；`NovelChapter` +stale；SourceItem +miss 候选字段；`NovelPreviewPolicy` 重写；标签四表（+`NovelSourceItemLabel`）；任务六表（+`CatalogScanTask`、互斥作用域）；`PromoLink` 两码；`TrackingEvent` 公开码；收益五表（+`RevenueSyncScope`、Decimal）；ER 图与阶段表重绘 |
| `novel-v1-adapter-and-workflow-v0.2.md` | §3.1 重写（CatalogScanTask/ACCEPT/完整性拆分/dry-run）；§3.3 +刷新语义与缺失推荐；§3.5 重写（机器门禁）；§3.7 门禁改五道；§3.8 索引口径；§3.9 +公开码分配；§3.11 只认公开码；§3.14 删自动下架；§4.6 互斥作用域；§6 验收 8→12 条；附录 +U-13 |
| `novel-v1-implementation-plan-v0.2.md` | 阶段映射重排（P3 前半并入 P2）；P2 任务/验收/Gate 重写；P3 重写（仅生成）；P4 多账户；Post-V1 更名；附录 A/B 重绘 |
| `novel-v1-open-decisions.md` | D-1/D-3 关闭；ChannelAccount 裁决化；新增 D-10/D-11；v0.2 追加闭合表 |
| `novel-v1-cps-parity-review.md` | **新增** |
| 两个 outbox jsonl | **重写**：Owner 裁决标 `OWNER_DECIDED`、推荐标 `CANDIDATE`、被替代条目带 supersedes 指针（v0.1 outbox 条目不删除，由指针替代） |

## 五、本轮未做

未创建正式项目 / Prisma / Migration / 数据库 / Worker / Adapter / 页面代码；未调用渠道接口；未连接生产；未修改 CPS（前后 `git status --porcelain` = 0）；未修改 candidate-v0.1（本地 v0.1 源文件与 GitHub 归档均未动）；未写回 Notion（无 MCP，仅 outbox）。
