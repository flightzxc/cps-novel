# 海外阅读 v1 · 逻辑数据模型 v0.2.1（候选）

> 文档性质：**架构候选**，待 Owner 审核。
> **本文档只描述逻辑模型与字段责任，不是 Prisma Schema，不含 DDL，不构成 migration 依据。**
> v0.2 修订：2026-08-02。主要变更：分成比例不再是准入门槛；D-1 已由 Owner 关闭（V1 每语种版本独立 Novel）；试读章节页全量进 SEO；删除 payEpisFrom 自动下架；PromoLink 拆两码并新增 `public_redirect_code`；收益改多账户 + `RevenueSyncScope`；新增 `CatalogScanTask/Item` 与 `NovelSourceItemLabel`；active task 互斥改作用域化；阶段命名 Post-V1。逐项见 `CHANGELOG-v0.1-to-v0.2.md`。
> **v0.2.1 收口：2026-08-02。** 本文件的变更点：`NovelChapter.stale` 语义冻结（旧章未返回**立即** stale、重新返回自动恢复、正文永不自动硬删）；**删除 `consecutive_miss_count`**（K 次阈值不再是判据），`last_seen_at` 保留为可观测字段；`CatalogScanTask` 互斥改为 `(channel_account_id, channel_app_id, project_type)` 单 active，不用 page-range hash。逐项见 `CHANGELOG-v0.2-to-v0.2.1.md`。
> CPS 代码基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`
> 本轮未创建任何数据库、表、Prisma Schema 或 Migration。

---

## 1. 建模的三条主线

在逐表展开之前，先说清楚三个贯穿全局的决定。它们不是细节，是**其他所有字段设计的前提**。

### 1.1 来源实体与 canonical 实体必须分开

上游返回的一行，和站内那本"书"，不是同一个东西。

CPS 早期的北斗链路把两者混在 `drama_source_mapping` 里，结果是：上游改了一个字段，站内运营手工编辑过的内容被覆盖；同一本剧在两个剧场出现，站内身份归属不清。畅读重写时把它们彻底拆开——`drama_source_item` 只记"上游说了什么"，`dramas` 记"站内的权威版本"，两者用可空外键关联（`prisma/schema.prisma:249-289`）。

海外阅读**继承这个分离**，且更严格：

- `NovelSourceItem` 是**上游镜像**。字段含义由上游定义，站内不解释、不修正、不合并。
- `Novel` 是**站内权威**。它可以被运营编辑，可以有上游没有的字段，**上游同步只补空、不覆盖已有人工值**。

这条也是"canonical 只补空不覆盖"（继承矩阵 §5#20）在数据模型层的表达。

### 1.2 一本书的多语种关系：V1 已由 Owner 裁决（v0.2 更新）

v0.1 时这里是一个"证据不支持任何答案、选可修复方向"的临时处置。**v0.2 起它是 Owner 正式裁决（`OWNER_DECIDED`）**：

```text
一个来源语种版本 → 一个独立 Novel → 一个独立公开页面体系
```

- V1 不跨语种自动合并；不要求运营人工建立翻译关系；**不生成跨 Novel 的 hreflang**；不因标题相同或简介相似推断同一作品；每个语种版本独立 canonical。
- Owner 的理由：人工判断"是不是同一本书"工作量太大；机器无法 100% 正确；CPS 短剧也没有自动建立同剧跨语种关系。
- **CPS 复核佐证（`CPS_PARITY_CONFIRMED`）**：CPS 无跨源语种 Drama 关联机制——`DramaSourceItem` 唯一键含 `sourceLanguageCode`（`prisma/schema.prisma:279`），claim 资格把"一个 Drama 被多来源条目共享"判为不合格态（`changdu-promo-claim-eligibility.ts:6`）；其 hreflang 只连接同一 Drama 同一 slug 的自产翻译 Article（`drama-hreflang.ts:16-32`），在本模型下无对应物。详见 `novel-v1-cps-parity-review.md` §1。

Schema 形状仍保留 `NovelSourceItem.novel_id` 可空外键（1:N 形状）——不是为了 V1 合并，而是让 Post-V1 的 `NovelWork / TranslationGroup` 引入时**不需要动这两张表**。该能力明确进 Post-V1，不是 V1 Schema 硬前置。

v0.1 的"可修复错误方向"论证保留其结论价值：即使未来做合并，也必须是人工发起、可回滚的运维操作，绝不自动。

### 1.3 试读章节的三层拆分

章节相关有三张表，不是过度拆分，每张各有不可合并的理由：

| 表 | 存什么 | 为什么不能并 |
| --- | --- | --- |
| `NovelChapterSourceItem` | 上游返回的章节原始记录：`chapterID`、`i`、`chapterName`、`chapterShowName` | 上游主键 `chapterID` 的稳定性未证。它必须独立留痕，否则上游改 ID 时无法追溯 |
| `NovelChapter` | 站内章节身份：所属 Novel、canonical 章号、标题、是否试读 | 站内排序键 `(novel_id, canonical_chapter_number)` 必须独立于上游序号，否则上游乱序会污染前台 |
| `NovelChapterContent` | 正文本体 + 字符数 + 哈希 | 正文样本 3,997–11,858 字符/章（`P0_SECOND_BROWSER_PROBE.md:43-51`）。列表查询绝不该把正文拖进内存 |

**正文单独一张表，是纯性能与合规决定**：列表页、聚合页、sitemap 生成全都不需要正文；而"删除某本书的正文但保留元数据"（版权撤回场景）需要能独立删。

---

## 2. 实体清单

图例：
- **V1** = 一期建
- **Post-V1** = 一期之后建（v0.2 统一命名：不再用"Phase 2"，避免与施工阶段 P2 混淆）
- **P4** = 收益阶段建，当前只留设计
- 证据等级见 `novel-v1-evidence-reconciliation.md` §2

---

### 2.1 `Novel` — 站内权威作品实体

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | 站内唯一的作品身份。所有发布、SEO、标签、推广的落点 |
| **主键** | 代理主键（cuid 或自增） |
| **唯一键** | `business_id`（站内业务码，全局唯一，人可读）<br>`(locale, slug)` 部分唯一（仅未软删行） |
| **外键** | 无（被 `NovelSourceItem` / `NovelChapter` / `Article` 指向） |
| **状态** | `draft` / `ready` / `published` / `unpublished` / `takedown` |
| **必要索引** | `(status, updated_at)`（后台列表与增量）<br>`(locale, slug)` 部分唯一<br>`business_id` 唯一 |
| **jsonb 边界** | **不用**。Novel 是被编辑的实体，字段必须是列 |
| **敏感字段** | 无 |
| **数据保留** | 长期。`takedown` 后保留行，正文另删 |
| **来源证据** | 结构对照 CPS `Drama`（`prisma/schema.prisma:20-95`）；`business_id` 全局唯一是 CPS Phase 7 已定裁决 |

关键字段责任：

| 字段 | 责任 | 谁能写 |
| --- | --- | --- |
| `title` | 站内展示书名 | 同步补空 + 运营可改 |
| `description` | 站内简介 | 同步补空 + 运营可改 |
| `cover_url` | 封面（站内地址，非上游直链） | 同步补空 |
| `locale` | 站点语种，由**单一语种真源**映射得出。映射不到 → `unknown` 且不可发布 | 系统 |
| `slug` | URL 片段。冲突时 **suffix-or-throw，绝不静默覆盖** | 系统生成 + 运营可改 |
| `total_chapter_count` | 上游 `allEpis`（样本 186/255/468/291） | 同步 |
| `paid_from_chapter` | 上游 `payEpisFrom`（样本 8/6/6）。**纯渠道收费边界元数据**，与已物化章数无关。⛔v0.2：**不再触发任何自动下架**——试读集合完全以 `chapterList[]` 实际返回为准（Owner 裁决，证据文档 §8.4） | 同步 |
| `split_ratio` | 上游 `splitRatio`。⛔v0.2：**渠道业务属性，不是准入门槛**——供运营筛选/排序/分析；渠道级筛选配置可选且默认不启用（Owner 裁决 `ACCEPT_CHANNEL_CONTENT`，证据文档 §8.1） | 同步 |
| `status` | 发布状态机 | 运营 + 系统 |

**关于 `author` / `completion_status` / `country`——一处已修正的裁决**

本方案初稿主张**不建这三列**，理由是空列会诱导模板引用、诱导前台展示、诱导有人拿别的字段顶替。

立项书 §C.5 与 §七B Q3 给出了相反且更硬的理由：**二期要做书名/作者搜索，字段必须是独立列，塞进 jsonb 会阻断加索引**。CPS 已经为"字段藏在 JSON 里查不了"付过账。

**采纳立项书：建列。** 最终形态是"建列 + 四道封锁"：

| 列 | 建？ | 封锁 |
| --- | :---: | --- |
| `author` | ✅ 可空预留 | ① **不进模板变量白名单**（模板里写 `{author}` 保存时即报错）<br>② 前台不展示<br>③ 不建聚合页/索引页<br>④ 不进 sitemap |
| `completion_status` | ✅ 可空预留 | 同上 |
| `country` / `region` | ✅ 可空预留 | 同上，且**禁止用 `language` 或 `localType` 顶替**（立项书 §C.5 明令） |

这样两条约束同时成立：二期加索引无阻碍，V1 期间误用被机制堵死——**封锁靠的是模板白名单，不是靠"没有这个列"**。

上游现状：三者全部 `UPSTREAM_FIELD_NOT_FOUND`（`P0_SECOND_BROWSER_PROBE.md:70-72`），因此 V1 期间这些列恒为 NULL。

**同样不得强行映射的既有字段**：`isRelease`（boolean，**不得等同于完结状态**）、`localType`、`localSubType`、`seriesTypeList`、`recommendList`——语义均未证，只落 `raw_payload`。

---

### 2.2 `NovelSourceItem` — 上游来源条目

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | 上游一行记录的忠实镜像。不解释、不修正 |
| **主键** | 代理主键 |
| **唯一键** | `(channel_app_id, external_book_id, source_language_code)` |
| **外键** | `channel_app_id → ChannelApp`；`novel_id → Novel`（**可空**） |
| **状态** | `pending` / `linked` / `ignored` / `stale` |
| **必要索引** | 唯一键；`novel_id`；`(channel_app_id, source_locale)`；`source_updated_at`（增量）；`(channel_app_id, split_ratio)`（**运营筛选**，非准入） |
| **jsonb 边界** | ✅ `raw_payload` 存上游整行原文 |
| **敏感字段** | `raw_payload` **可能含推广码与完整 URL** → 见下方安全约束 |
| **数据保留** | 长期。`raw_payload` 可按保留期裁剪 |
| **来源证据** | 直接对照 CPS `DramaSourceItem`（`prisma/schema.prisma:249-289`），唯一键设计原样继承 |

字段来源映射（全部 `PRODUCTION_READ_PROVEN`）：

| 本地字段 | 上游 JSON path | 备注 |
| --- | --- | --- |
| `external_book_id` | `seriesId` | 上游主键 |
| `title` | `seriesName` | |
| `description` | `description` | |
| `cover_url` | `coverUrl` | 需 host 白名单校验后再落 |
| `source_language_code` | `language` | 数值枚举。样本 `3` = 英语；法语数值**未安全取得** |
| `source_language_name` | `languageName` | 上游文案，仅供排查 |
| `total_chapter_count` | `allEpis` | |
| `paid_from_chapter` | `payEpisFrom` | |
| `split_ratio` | `splitRatio` | 渠道业务属性（v0.2：非准入门槛） |
| `tto_split_ratio` | `ttoSplitRatio` | 存原值，语义未证 |
| `external_agency_id` | `agencyId` | 与 `ChannelApp.external_app_id` 对齐 |
| `source_created_at` | `createTime` | |
| `raw_payload` | 整行 | jsonb |

**安全约束（本模型的一处硬要求）**：`getlistpc` 返回行里含 `kocCode`（真实推广码）与 `publicUrl` / `homeLink`（完整推广链接）。这些值：

- **允许**落在 `NovelSourceItem.raw_payload` 与 `PromoLink` 的正式字段里（业务需要真实值）；
- **禁止**出现在任何审计表、任何日志、任何导出物中（审计一律 `[redacted_code:length=N]` + hostname）；
- 后台展示需经能力位控制，普通角色只见掩码。

这条直接继承 CPS 的审计脱敏刚性（`src/lib/changdu-promo-claim.ts:371-384,568-570`）。

---

### 2.3 `NovelChapter` — 站内章节身份

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | 章节的站内身份与排序 |
| **主键** | 代理主键 |
| **唯一键** | `(novel_id, canonical_chapter_number)` 部分唯一（仅未软删行） |
| **外键** | `novel_id → Novel` |
| **状态** | `preview`（试读，可见可索引）/ `locked`（付费，V1 不物化）/ `stale`（**v0.2.1 语义已冻结**：该章未出现在最近一次**可信**的权威列表中 → 立即停展、退出 sitemap；正文保留；后续重新返回则**自动恢复**为 `preview`）/ `withdrawn`（人工撤回，唯一会删正文的状态） |
| **状态转移（v0.2.1 `OWNER_DECIDED`）** | `preview → stale`：旧章未再出现在成功且非空的 `chapterList[]` 中，**立即**转（无 K 次缓冲）<br>`stale → preview`：该章重新出现在权威列表中，**自动**恢复（写审计，无需人工确认）<br>**响应失败/异常/异常空列表时不发生任何转移**——现有可见状态原样保持 |
| **必要索引** | 唯一键；`(novel_id, is_preview, canonical_chapter_number)`（前台试读列表） |
| **jsonb 边界** | 不用 |
| **敏感字段** | 无（正文在另一张表） |
| **数据保留** | 长期 |
| **来源证据** | **CPS 无对应物**（CPS 只有 `Drama.episode_count` 标量，`prisma/schema.prisma:28-29`）。新建 |

关键决定：

- `canonical_chapter_number` 由上游 `i` 归一而来，但**是站内自有的排序真源**。上游乱序或改序不直接污染前台。
- **V1 不建对外游标 API**（见证据文档冲突 5）。排序键唯一稳定这件事成本为零、收益是未来可加游标，所以保留。
- 所有章节查询必须带 `take` 上限，不写无界 `findMany`。

---

### 2.4 `NovelChapterSourceItem` — 上游章节镜像

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | 上游 `chapterList[]` 一个元素的镜像 |
| **主键** | 代理主键 |
| **唯一键** | `(novel_source_item_id, external_chapter_id)` |
| **外键** | `novel_source_item_id → NovelSourceItem`；`novel_chapter_id → NovelChapter`（可空） |
| **状态** | `pending` / `materialized` / `failed` |
| **v0.2.1 字段** | `last_seen_at`（最近一次在**可信**上游返回中出现）——**可观测字段**，用于排查与运营视图，**不是**状态判据。<br>⛔ **删除 `consecutive_miss_count`**：v0.2 曾为"连续 K 次缺失 → stale"设计该计数器；v0.2.1 关闭 D-10 后判据变为"最近一次可信响应是否包含该章"，计数器无用武之地，保留只会诱导重新引入阈值逻辑 |
| **必要索引** | 唯一键；`novel_chapter_id`；`source_updated_at` |
| **jsonb 边界** | ✅ `raw_payload`（**不含正文**，正文另存） |
| **敏感字段** | 无 |
| **数据保留** | 长期 |
| **来源证据** | 字段 `i` / `chapterID` / `chapterName` / `chapterShowName` 全部 `PRODUCTION_READ_PROVEN`（`P0_BROWSER_INTERFACE_PROBE.md:76`） |

**`external_chapter_id` 的稳定性未证**（探测报告 `:79`：章节删除/下架、卷层级、增量同步语义均未证）。因此唯一键用 `(source_item, external_chapter_id)` 而不是全局唯一——如果上游 ID 在不同书之间复用，这个键仍然安全。

---

### 2.5 `NovelChapterContent` — 试读正文

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | 正文本体与完整性元数据 |
| **主键** | 代理主键 |
| **唯一键** | `novel_chapter_id`（1:1） |
| **外键** | `novel_chapter_id → NovelChapter`（级联删除） |
| **状态** | 无独立状态（跟随 `NovelChapter`） |
| **必要索引** | 唯一键 |
| **jsonb 边界** | **不用**。正文用 `text` |
| **敏感字段** | **正文本身是版权内容**：不进日志、不进审计、不进导出、不进 Notion、不进 Git |
| **数据保留** | 跟随作品。**版权撤回时可单独整表删除该书正文而保留元数据** |
| **来源证据** | `chapterContent` 内嵌纯文本、无 HTML/图片/水印/截断标记（`P0_BROWSER_INTERFACE_PROBE.md:85,91`） |

字段：

| 字段 | 责任 |
| --- | --- |
| `body` | 正文纯文本。**必须有长度上限**，超限落审核队列而非静默截断 |
| `char_count` | 字符数。样本区间 3,997–11,858 |
| `content_hash` | SHA-256。用于判断上游是否更新、避免无意义重写 |
| `materialized_at` | 物化时间 |
| `source_fetch_id` | 指向本次物化的任务 item，便于追溯 |

**为什么用 `text` 而不是 jsonb**：正文是可搜索、可读的长文本，jsonb 会引入引号转义开销，且让字符数/哈希统计变得不准。（此判断与 PG 原型的 `P0_SCHEMA_DECISION.md` 一致，但本方案独立成立，不依赖该原型。）

---

### 2.6 `NovelPreviewPolicy` — 试读策略

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | 记录"这本书的试读是按什么策略物化的"，以及展示授权范围 |
| **主键** | 代理主键 |
| **唯一键** | `novel_id` |
| **外键** | `novel_id → Novel` |
| **状态** | — |
| **必要索引** | 唯一键 |
| **jsonb 边界** | 不用 |
| **敏感字段** | 无 |
| **来源证据** | `preview.materializationPolicy = UPSTREAM_RETURNED_PREVIEW`（`OWNER_DECIDED`） |

字段：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `materialization_policy` | `upstream_returned_preview` | 当前唯一值。**留字段是为了将来策略变化时不改结构** |
| `materialized_chapter_count` | 整数 | **结果记录，不是期望值**。样本均为 3，但不写死 |
| `display_authorized` | 布尔，**默认 true** | Owner 已确认可展示（`OWNER_CONFIRMED`；立项书建议补登分销协议编号与有效期）。保留为**单本覆盖开关**（争议/撤回处置） |
| `index_authorized` | 布尔，**默认 true** | ⛔v0.2：Owner 已裁决详情/目录/全部试读章节页进入 SEO（证据文档 §8.3），默认放行。保留为单本覆盖开关 |
| `cache_authorized` | 布尔，默认 true | 随索引裁决放行；缓存细则降为一般运维项 |
| `max_materialized_chapters` | 整数（可配） | **异常安全上限**：上游异常返回大量正文时封顶，防止无限生成章节页。是防御位，不是产品配额 |
| `last_refreshed_at` | 时间 | 刷新与撤回流程用 |

⛔ **v0.2 删除：`last_paid_from_chapter` 与"收费边界下调自动下架"机制**

v0.1 依据立项书 §C.4 在此处设计了"`payEpisFrom` 下调 → 自动置 `withdrawn` + 删正文"的触发器。**Owner v0.2 裁决删除该推断**：

- 试读集合的唯一真源是 `getchapterinfo.chapterList[]` 实际返回；
- `payEpisFrom` 只是渠道收费边界元数据，其数值变化**不得触发**任何自动删除；
- 若上游真的收回某章的试读资格，表现必然是**该章不再出现在 `chapterList[]` 里**——这正确地落入"缺失章节处置"流程（v0.2.1 已冻结：可信且非空的响应中缺失 → **立即** `stale` 停展，正文保留，重新返回自动恢复），而不是靠一个未经渠道合同证实的字段语义推断。

除非后续获得渠道正式合同（`DOC_CONFIRMED`）证明 `payEpisFrom` 变化与试读资格回收的因果关系，否则不得恢复该机制。

**这张表在 v0.2 的存在理由**：策略与安全上限的落点 + 单本覆盖开关（默认放行、例外处置时 fail-closed），不再是"等授权"的全局闸。

---

### 2.7 标签四表（v0.2：+`NovelSourceItemLabel`）

#### `SourceLabel` — 上游原始标签

| 项 | 内容 |
| --- | --- |
| **阶段** | **V1**（Owner 裁决 `taxonomy.rawSourceLabels = REQUIRED`，第一天就存） |
| **责任** | 原样保存上游标签值本身（去重后的标签字典），不解释 |
| **唯一键** | `(channel_app_id, label_kind, external_label_value)` |
| **`label_kind`** | `series_type`（来自 `seriesTypeList`）/ `recommend`（来自 `recommendList`）/ `language`（来自 `language`+`languageName`）/ `agency` |
| **必要索引** | 唯一键；`label_kind` |
| **来源证据** | 四类来源字段全部存在但 `FIELD_PRESENT_SEMANTICS_UNCONFIRMED`（`P0_SECOND_BROWSER_PROBE.md:76-82`） |

#### `NovelSourceItemLabel` — 来源条目 × 标签关系（v0.2 新增）

| 项 | 内容 |
| --- | --- |
| **阶段** | **V1** |
| **责任** | 记录"哪条来源条目在什么时候带过哪个标签"。`SourceLabel` 是字典，本表是关系——v0.1 的 ER 图引用了未定义的 `NovelLabel`，本表是其正名 |
| **唯一键** | `(novel_source_item_id, source_label_id)` |
| **外键** | `novel_source_item_id → NovelSourceItem`；`source_label_id → SourceLabel` |
| **字段** | `first_seen_at`（首次出现）、`last_seen_at`（最近出现）、`active`（本次同步是否仍带该标签） |
| **必要索引** | 唯一键；`(source_label_id, active)` |
| **为什么要 first/last_seen + active** | `recommendList` 是动态运营标签（本周爆款会轮换）——不记时间窗就无法区分"曾经上过榜"和"现在在榜"，Post-V1 做标签分析时这是唯一的历史证据 |

#### `CanonicalTag` — 站内标准标签

| 项 | 内容 |
| --- | --- |
| **阶段** | **Post-V1** |
| **责任** | 站内永久 SEO 分类。有聚合页、有 slug |
| **唯一键** | `(locale, slug)` |
| **状态** | `draft` / `public` |

#### `SourceLabelMapping` — 映射关系

| 项 | 内容 |
| --- | --- |
| **阶段** | **Post-V1** |
| **责任** | 原始标签 → 标准标签的人工/规则映射 |
| **唯一键** | `(source_label_id, canonical_tag_id)` |
| **状态** | `proposed` / `approved` / `rejected` |

**标签的三条纪律（回答任务问题 9.10）**：

1. **第一天就存原始标签**，哪怕还不知道怎么用。等到 Post-V1 再回头补，历史数据就永远缺了。
2. **`recommendList` 不得直接成为永久 SEO 分类。** 它是运营的动态推荐位，语义会变；SEO 分类一旦有 URL 就不能变。两者生命周期不同。
3. **未映射的标签不自动公开。** `CanonicalTag.status` 默认 `draft`，只有 `public` 才有前台聚合页。简介自动匹配只在来源标签缺失时作兜底，且产出物是 `proposed` 状态，需人工批准。

---

### 2.8 `Article` / `PublicPageIdentity` — 发布物与页面身份

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | 一个 `(Novel, locale)` 对应的公开页面。承载模板渲染结果、SEO 元数据、发布状态 |
| **主键** | 代理主键 |
| **唯一键** | `(novel_id, locale)`；`public_page_short_id` 全局唯一；`(locale, slug)` 部分唯一 |
| **外键** | `novel_id → Novel`；`template_id → ArticleTemplate` |
| **状态** | `draft` / `published` / `unpublished` / `takedown` |
| **必要索引** | 三个唯一键；`(status, published_at)`；`(locale, status)` |
| **jsonb 边界** | ✅ `seo_metadata_json`（结构随 SEO 需求演化） |
| **敏感字段** | 无 |
| **来源证据** | CPS `Article` + Page Identity V2 短码（`src/lib/article-public-page-id.ts:32-43`） |

**页面身份的两条继承**：

- 短码生成算法继承 CPS，**短码强制含数字**这条保留（避免纯字母短码与语义 slug 混淆）。
- slug 冲突时 **suffix-or-throw，绝不静默覆盖**——这是 CPS Phase 7 已定裁决。

**canonical URL 规则（硬约束）**：每个 `Article` 的 canonical 指向它自己。**不同语种版本绝不共用 canonical。** v0.2：V1 不存在需要表达的跨语种关系（不生成跨 Novel hreflang）；试读章节页同样 self-canonical，**不指向详情页**（Owner 裁决，证据文档 §8.3）。URL 是否含 locale 段仍是待决 D-8。

---

### 2.9 渠道注册四表

这四张表直接继承 CPS 结构（`prisma/schema.prisma:99-246`），**schema 形状零改，数据内容全换**。

| 表 | 阶段 | 责任 | 唯一键 | 关键点 |
| --- | :---: | --- | --- | --- |
| `Channel` | V1 | 渠道注册（`changdu`） | `code` | 纯注册表，渠道无关 |
| `SourceApp` | V1 | 来源应用注册（`moboreader`） | `code` | CPS 的"剧场"→ 这里的"书城" |
| `ChannelApp` | V1 | 渠道 × 来源应用绑定，`external_app_id` 承载 `agencyId` | `(channel_id, source_app_id, external_app_id)` | **`projectType` 作为该绑定的配置字段**，不写成模块常量 |
| `ChannelAccount` | V1 | 渠道账户 | `business_id` | 见下 |

**`ChannelApp` 的一处必要扩展**：CPS 的 `ChannelApp` 没有 `project_type` 字段，因为畅读短剧把 `projectType=2` 硬钉在 `adapters/changdu-getcode.ts:7`。海外阅读**必须把它提升为配置字段**——这是任务简报的明确要求，也是 `P0-X1` 解除阻塞后的直接后果。

**`ChannelAccount` 的作用域裁决（回答任务问题 9.11）**：

收益探测证明同一登录态、同一凭证可以查询两类业务，靠请求体的 `projectType` 分流（`P0_REVENUE_PROBE_AND_BACKFILL.md:152-160`）。因此：

- V1 建 **一个** `ChannelAccount`。
- `projectType` 是**请求维度**，落在 `ChannelApp` 配置上，不是账户维度。
- 但保留这个可能性：`ChannelAccount` 与 `ChannelApp` 是多对多关系的两端，将来若渠道要求分账户，只需加绑定行，不改结构。
- **法律结算主体不能按 agency 建模**——因为收益 API 根本没有 `agencyId` 字段（`:156`）。这是已证的"不存在"，比"未知"更硬。

---

### 2.10 凭证两表

| 表 | 阶段 | 责任 | 唯一键 | 敏感字段 |
| --- | :---: | --- | --- | --- |
| `ChannelAccountCredential` | V1 | 加密凭证 | `(channel_account_id, status)` 上 active 部分唯一 | `encrypted_secret`（密文列）、`secret_fingerprint` |
| `CredentialChangeLog` | V1 | 变更审计 | — | 只存指纹与操作元数据，**不存密文也不存明文** |

**四条刚性继承**：

1. **单轨**。只允许 `ChannelAccountCredential`。**禁止** `site_settings` 明文列、**禁止** env 凭证兜底、**禁止**多来源 `conflict` 解析（CPS 的三轨并存直接催生了 `conflict` 状态，是复杂度的根源，`src/lib/beidou-config.ts:7-18`）。
2. **指纹 DB 级互斥**。独立的指纹唯一表，把应用层 TOCTOU 升级为数据库原子约束（CPS `prisma/schema.prisma:1236-1258` 的模式）。
3. **换证在事务内**：旧证置 `superseded` + 新证 `active` + 写 ChangeLog，三件事同一事务。
4. **写凭证需 `credential:manage` 能力位**。

**PG 角色约束**：`web_app` 与 `analyst_ro` 对密文列 `REVOKE`。只有 `worker_app` 能读。

---

### 2.11 `PromoLink` — 推广资产（v0.2：两码分离）

| 项 | 内容 |
| --- | --- |
| **阶段** | V1（读取已有资源 + 公开短码分配，**已并入内容主链**） |
| **责任** | 推广资产层：渠道真实码/链接的唯一真身 + 我方公开跳转码的唯一落点。canonical 实体上的推广字段只是可选投影 |
| **主键** | 代理主键 |
| **唯一键** | ① `idempotency_key` 全局唯一 = `(channel_app_id, external_book_id, source_language_code, channel_account_id)`；② **`public_redirect_code` 全局唯一（部分索引排除软删）** |
| **外键** | `novel_source_item_id`、`channel_app_id`、`channel_account_id` |
| **状态** | `pending` / `fetched` / `failed` |
| **必要索引** | 两个唯一键；`(status, fetched_at)`；`novel_source_item_id` |
| **jsonb 边界** | ✅ `raw_links_json` |
| **敏感字段** | **`upstream_code` 与 `web_url` 是渠道真实值**，仅存本表与 raw 镜像；审计一律掩码；`public_redirect_code` 本身非敏感（就是设计来公开的） |
| **数据保留** | 长期 |
| **来源证据** | 结构对照 CPS `DramaPromoLink`（`prisma/schema.prisma:292-326`）；幂等键设计原样继承（`src/lib/changdu-promo-claim.ts:422-427`） |

**v0.2 核心变更：`upstream_code` 与 `public_redirect_code` 拆分（Owner 裁决）**

| 字段 | 语义 | 规则 |
| --- | --- | --- |
| `upstream_code` | 渠道真实推广码（原 v0.1 的 `code`） | 只存内部；**绝不进前台 URL**；随渠道数据可更新 |
| `public_redirect_code` | 我方公开跳转码，`/go/{public_redirect_code}` 的唯一入口 | **全项目唯一生成入口** `public-redirect-code.ts`（改造 CPS `article-public-page-id.ts:32-44` 已验证模式：字母表 + 强制含数字 + 冲突重试 + DB 唯一约束兜底）；创建后**不可变**——重跑同步、换模型、换代理不得重新生成；渠道真实码变化时公开 URL 默认不变；同一 PromoLink 只有一个 active 公开码；禁止任何 Adapter 自行生成 |

**为什么这是对 CPS 的修正而非复用**：CPS 的 `/go/:code` 直接按渠道真实码 `dramas.promo_code` 查找（`route.ts:94-98`）、前端把真实码编码进公开 URL（`drama-cta.ts:48-55`）、且该列无唯一约束（`schema.prisma:32`）。Owner 裁决拆分两码；短码**生成机制**沿用 CPS 已验证的 Page Identity 模式，不发明新算法。防"多模型重复发明短码"的机制就是上面三条：唯一入口 + DB 唯一 + 不可变，任何绕过都会在数据库层撞墙。详见 `novel-v1-cps-parity-review.md` §3。

**关键：`origin` 字段（CPS 没有，必须新增）**

| 值 | 含义 |
| --- | --- |
| `upstream_existing` | 从 `getlistpc` 的 `kocCode` / `publicUrl` / `homeLink` 直接读到的**已有资源**（**已证能力**） |
| `claimed` | 通过"生成推广资源"主动领取的（**能力合同未证，V1 不产生此值**） |

区分这两者的理由：**它们的风险等级完全不同**。读已有资源是幂等只读；主动领取是不可逆的上游副作用。混在一个字段里，将来没人能回答"这条链接当初是怎么来的"。

**幂等键含账号维度**这条必须继承：同一本书、同一语种，不同账号领到的是不同的推广链接。

---

### 2.12 `PromoClaimAudit` — 推广意图审计

| 项 | 内容 |
| --- | --- |
| **阶段** | V1（结构建好，V1 只写 `read_existing` 类记录） |
| **责任** | 有副作用的推广操作的**写前意图**与**分段结果**留痕 |
| **主键** | 代理主键 |
| **唯一键** | 无（append-only 事件流） |
| **外键** | `novel_source_item_id`、`channel_account_id`、`task_item_id` |
| **必要索引** | `(novel_source_item_id, created_at DESC)`（**反重复领取闩要查最近一条**）；`(decision, created_at)` |
| **jsonb 边界** | ✅ `request_summary_json`（脱敏请求摘要）、`response_shape_json`（**响应结构而非内容**） |
| **敏感字段** | **零**。这张表设计上就必须能安全外流 |
| **数据保留** | 长期。审计不删 |
| **来源证据** | CPS `changdu_promo_claim_audit`（`prisma/schema.prisma:330-392`），字段语义见 `novel-p0-architecture-field-dictionary.md` §3.2–3.3 |

**四段独立状态列（不可合并）**：

| 列 | 取值 |
| --- | --- |
| `pre_read_status` | `checked` / `failed` |
| `claim_status` | `not_run` / `dry_run_only` / `attempted` / `success` / `failed` / `retry_blocked` |
| `readback_status` | `not_run` / `already_available` / `success` / `failed` |
| `writeback_status` | `not_run` / `promo_link_upserted` |

`decision`：`failed` / `already_available` / `would_claim` / `claim_attempted` / `claimed`。

**`claim_attempted` 是意图态，不是结果态。** 这是整个机制的核心：它在上游调用**之前**写入并提交，所以崩溃后仍能判断"我到底发出去没有"。

**脱敏刚性（不得放宽）**：
- 推广码 → `[redacted_code:length=N]`
- 推广 URL → **只存 hostname**
- 上游错误文案 → 过清洗函数再入库（防止上游把凭证片段回显进日志）

---

### 2.13 任务六表（v0.2：+`CatalogScanTask/Item`）

**必须区分三条任务线**——渠道同步与通用任务的二分是任务简报的显式要求（CPS `CLAUDE.md` §6.1 的既有边界）；v0.2 修正了 v0.1 的一个结构漏洞：**首次目录扫描时 `NovelSourceItem` 还不存在**，`ChannelSyncTaskItem` 无物可绑，必须有页区间粒度的第三条线。

#### `CatalogScanTask` / `CatalogScanTaskItem` — 目录扫描（v0.2 新增）

| 项 | `CatalogScanTask` | `CatalogScanTaskItem` |
| --- | --- | --- |
| **阶段** | V1 | V1 |
| **责任** | 一次目录扫描批次（首扫或补扫） | **一个页码/页区间**的抓取单元 |
| **唯一键** | 🔴 **v0.2.1 专属互斥规则，见下** | `(task_id, page_index)`（或 page-range 起点） |
| **外键** | `channel_app_id`、`channel_account_id` | `task_id` |
| **字段** | `project_type`、页区间起止、`catalog_observed_total`（本次观察到的 totalCount 水位）、`batch_expected_count` / `batch_actual_count` | `page_index` / `page_range`、`request_fingerprint`、返回行数、错误 |
| **状态** | 同 ChannelSyncTask 五态 | `pending` / `processing` / `success` / `failed` |
| **完整性口径（v0.2 修正）** | **单批完整性 = `batch_actual_count` vs `batch_expected_count`（页区间应得）**；`catalog_observed_total` 只作渠道目录水位与全量扫描进度参考，**不再用本批抓取量对比全局 totalCount** | 页级：返回行数 < pageSize 且非末页 → 该 item 失败可重试 |

🔴 **目录扫描的互斥（v0.2.1 修正，与其他任务不同）**

```text
部分唯一索引 UNIQUE(channel_account_id, channel_app_id, project_type)
  WHERE status IN ('pending','processing')
```

**同一 `channel_account + channel_app + projectType` 同时只允许一个 active catalog scan。不使用 `operation_scope_hash`。**

为什么目录扫描是例外：v0.2 把所有任务统一成"账户 × 应用 × 范围指纹"互斥，对目录扫描是错的——page-range hash 不同就放行，等于**允许同一账户对同一目录并发跑多个重叠扫描**。目录是一个共享的、会随上游变动的游标空间：并发扫描会争抢上游配额、产生互相覆盖的 `NovelSourceItem` upsert、并让 `catalog_observed_total` 水位与 `batch_expected/actual` 统计互相污染。分页区间并不构成真正独立的作用域。

因此目录扫描回到**账户 × 应用 × 品类的单 active** 口径：要扫更多页，就排队跑下一个批次，不并发。

扫描产出 upsert `NovelSourceItem`；**SourceItem 存在之后**，后续针对性的同步/物化才由 `ChannelSyncTaskItem` 按 `source_item_id` 组织。

#### `ChannelSyncTask` / `ChannelSyncTaskItem` — 渠道同步（既有 SourceItem 的定向作业）

| 项 | `ChannelSyncTask` | `ChannelSyncTaskItem` |
| --- | --- | --- |
| **阶段** | V1 | V1 |
| **责任** | 一次针对已存在来源条目的同步批次（试读物化、推广读取、内容刷新） | 批次里的一条来源条目 |
| **唯一键** | active 互斥见下方 v0.2 作用域规则 | `(task_id, novel_source_item_id)` |
| **外键** | `channel_app_id`、`channel_account_id` | `task_id`、**`novel_source_item_id`** |
| **状态** | `pending` / `processing` / `completed` / `completed_with_errors` / `failed` / `disabled` | `pending` / `processing` / `success` / `skipped` / `failed` |
| **必要索引** | active 部分唯一（作用域化）；`(status, created_at)` | `(task_id, status)`；`(status, locked_until)`（租约恢复） |
| **jsonb 边界** | ✅ `params_json`、`result_json` | ✅ `error_json` |

**`ChannelSyncTaskItem` 的 target 一定是 `novel_source_item_id`（string FK），不是 `novel_id`。** 这条边界在 CPS 是明令的：来源条目与 canonical 实体不是一回事，同步的对象永远是来源条目。

**Active Task 互斥作用域（v0.2 修正，v0.2.1 划清适用边界）**：v0.1 写的"同类型 active 任务部分唯一"过宽——它会让"账户 A 处理集合甲"挡住"账户 B 处理集合乙"这类完全无关的并行。对**目录扫描以外**的任务类型，修正为：

```text
部分唯一索引 UNIQUE(task_type, channel_account_id, channel_app_id, operation_scope_hash)
  WHERE status IN ('pending','processing')
```

`operation_scope_hash` = 操作范围指纹（目标集合 / projectType 等的规范化哈希）。同一账户同一应用同一范围只许一个 active；不同账户、不同应用、不重叠范围可并行。范围重叠检测由入队工厂做应用层预检，数据库约束兜住完全相同的重复提交。

⚠️ **`CatalogScanTask` 不适用本规则**——见上文目录扫描专属互斥（账户 × 应用 × `projectType` 单 active，不用 page-range hash）。原因是分页区间不是独立作用域，详见该节说明。

#### `GenericTask` / `GenericTaskItem` — 通用任务

| 项 | `GenericTask` | `GenericTaskItem` |
| --- | --- | --- |
| **阶段** | V1 | V1 |
| **责任** | 非渠道同步的一切批量作业：文章生成、发布、IndexNow 投递、sitemap 刷新 | 单个目标 |
| **唯一键** | `(task_type, origin_task_id)` | `(task_id, target_type, target_id)` |
| **状态** | 同上 | 同上 |
| **必要索引** | `(status, task_type, created_at)`（**领取查询**）；`(status, locked_until)`（**过期租约，独立索引路径**） | `(task_id, status)` |

**`GenericTaskItem` 的 target 是 `target_type` + `target_id` 二元组**，不是单一外键——因为它要指向 Novel、Article、Chapter 等不同实体。

**任务领取的一条踩坑（来自 PG 原型 `P0_INDEX_PLAN.md`，`SANDBOX_PROVEN`）**：
领取 SQL **不得**用 `OR` 把"待领取"和"租约过期"合成一个谓词。原型 L 轮首次尝试正因此绕过了 pending 偏索引，在 1,694/100,000 处停滞；拆成两条各自可走偏索引的路径后恢复线性。**两条路径要有各自独立的索引。**

#### 任务表的通用字段（两条线共用）

| 字段 | 责任 |
| --- | --- |
| `attempt_count` | **在领取时 +1，不是失败时**。崩溃也计次，毒药 item 必然收敛 |
| `locked_by` / `locked_until` | 显式租约。替代 CPS 的 status + startedAt 隐式租约 |
| `heartbeat_at` | 长任务续租 |
| `request_token` | 防重复提交（CPS v7.9.7 为解决 504 加的） |
| `execution_token` | 跨进程续跑的所有权凭证 |

**任务状态由 item 计数派生，禁止内存累加器。** 崩溃后重算仍正确。

---

### 2.14 `IndexNowOutbox`

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | 待推送 URL 的持久化队列 |
| **主键** | 代理主键 |
| **唯一键** | `(url, revision)` — **幂等键不含 revision 之外的易变字段** |
| **状态** | `pending` / `delivering` / `delivered` / `failed` / `skipped` |
| **必要索引** | 唯一键；`(status, created_at)` |
| **jsonb 边界** | ✅ `attempt_log_json` |
| **来源证据** | CPS `IndexNowDelivery` / `IndexNowDeliveryAttempt`（`prisma/schema.prisma:1460-1519`），10 个测试覆盖 |

**outbox 模式的要点**：业务事务里只写 outbox 行，**不在请求路径上同步推送**。投递由 Worker 异步做。这样搜索引擎接口挂了不会拖垮发布操作。

**试读页是否进 outbox，取决于 `NovelPreviewPolicy.index_authorized`**（v0.2：默认 true——Owner 已裁决试读章节页全量进 SEO；字段保留为单本例外处置开关）。

---

### 2.15 `TrackingEvent`

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | `/go/:code` 点击与前台页面事件 |
| **主键** | 代理主键 |
| **唯一键** | 无 |
| **必要索引** | `(public_redirect_code, created_at)`（v0.2：事件记录的是**我方公开码**，另存 `promo_link_id` 外键；渠道真实码不进埋点表）；`(event_type, created_at)`；`(novel_id, created_at)` |
| **jsonb 边界** | ✅ `context_json` |
| **敏感字段** | **IP 与 User-Agent 必须盐哈希后存，不存原值**（CPS `cps-tracking.ts:284` 的 `hashSensitive`） |
| **数据保留** | **必须设保留期**（建议 90 天原始事件 + 长期日汇总）。这是最先撑爆表的数据 |
| **来源证据** | CPS 事件表 6 个索引设计良好，可直接参照 |

**写入策略必须重设计**：CPS 当前每事件一次 `create`（`cps-tracking.ts:147`），且**生产已整体关停埋点写入**（`docker-compose.yml:78-80` 三个开关全关）。这是 SQLite 单写者压力的直接证据。PG 下改为**批量写 + 独立 flush**，并保留同样的关停开关。

---

### 2.16 收益五表（**P4；本轮只设计逻辑模型，不建表、不写 Prisma**）

Owner 指令：**"P4 可以设计主链，但书级归因继续标记 `PENDING_R3`"**。v0.2 进一步落定 Owner 的多账户裁决（证据文档 §8.5）：

**账户与作用域模型（v0.2 · `OWNER_DECIDED`）**

```
Channel
  └─ ChannelAccount [1..N]          ← 一个渠道可有多个账户，Day 0 即为 Schema 形状
       ├─ one active Credential
       └─ RevenueSyncScope [1..N]   ← 每账户可有多个收益作用域
            └─ projectType
```

**"当前只有一个账户"是运行时事实，不是 Schema 假设。** 四条限定继续有效：

1. 只证明了**技术查询账户共享**；
2. **未证明法律结算主体相同**（系统不自动推断）；
3. **不按 agency 建收益账户**——当前收益合同根本不返回 agency 字段（这是已证的"不存在"，比"未知"更硬）；
4. 发现独立凭证或主体字段时，模型必须支持拆分——`RevenueSyncScope` 是独立行而不是 `ChannelAccount` 上的一个列，正是为此。

**金额字段一律精确 `Decimal`（PostgreSQL `numeric`），禁止浮点。**

#### `RevenueSyncScope`（v0.2 新增实体）

| 项 | 内容 |
| --- | --- |
| **阶段** | P4 |
| **责任** | 一个账户下的一个收益查询作用域（当前维度 = projectType；将来若渠道引入更多作用域维度在此扩展） |
| **唯一键** | **`UNIQUE(channel_account_id, project_type)`**（Owner 指定） |
| **外键** | `channel_account_id → ChannelAccount` |
| **状态** | `active` / `disabled` |

#### `RevenueSyncBatch`

| 项 | 内容 |
| --- | --- |
| **阶段** | P4 |
| **责任** | 一次收益回拉批次 |
| **唯一键** | `request_fingerprint`（同参数重复同步必须幂等）；指纹入参**必须含 scope** |
| **字段** | **`revenue_sync_scope_id`**（v0.2：批次挂 scope，从 scope 可溯 account 与 projectType）、`begin_time`、`end_time`、`request_fingerprint`、`status`、`counts`（请求数/明细行数/汇总行数）、`error` |
| **必要索引** | `request_fingerprint` 唯一；`(revenue_sync_scope_id, begin_time)` |
| **状态** | `pending` / `running` / `completed` / `partial_failed` / `failed` |

#### `RevenueRawSnapshot`

| 项 | 内容 |
| --- | --- |
| **阶段** | P4 |
| **责任** | 上游返回行的原样存档，**写入时不加工** |
| **唯一键** | `dedupe_key`（**v0.2：组成必须含 scope + projectType + 日期 + 维度**——相同日期相同 projectType 的**不同账户**不得互相覆盖，这是 Owner 明确要求） |
| **外键** | `sync_batch_id → RevenueSyncBatch`（经 batch 溯 scope/account） |
| **必要索引** | `dedupe_key` 唯一；`(project_type, dimension_key)`；`(sync_batch_id, is_total)` |
| **jsonb 边界** | ✅ `raw_payload` 存整行 |

正式列化的字段（**只展开当前 UI 与运营真正使用的核心指标**；金额列全部 `Decimal/numeric`）：

```
sync_batch_id, project_type,
dimension, dimension_key, dimension_value, is_total,
real_dev_num, new_real_dev_num, real_dev_num_rate,
real_income, real_distrib_income, real_profit,
raw_payload (jsonb), dedupe_key
```

**其余 40+ 个上游字段（`activeRealIncome`、`newRealIncome`、`rmb*` 全系列、`subItems` 等）留在 `raw_payload`，不正式列化。** 理由：正式列化 60+ 指标会让表变成上游 schema 的镜子——上游一改字段就要 migration，而这些指标当前无人使用。

#### `RevenueDailyStat`

| 项 | 内容 |
| --- | --- |
| **阶段** | P4 |
| **责任** | T+1 日汇总（Owner 已确认 T+1 可接受） |
| **唯一键** | **`UNIQUE(revenue_sync_scope_id, stat_date)`**（v0.2 · Owner 指定——scope 已内含 account 与 projectType，多账户天然不互撞） |
| **外键** | `revenue_sync_scope_id → RevenueSyncScope`；`source_batch_id → RevenueSyncBatch`（可追溯到哪次同步产生的） |
| **字段** | `revenue_sync_scope_id`、`stat_date`、核心指标（`Decimal/numeric`）、`source_batch_id` |

#### `RevenueAttributionSnapshot`

| 项 | 内容 |
| --- | --- |
| **阶段** | **P4，Phase 1 仅占位** |
| **合同状态** | 🔒 **`PENDING_R3`** |
| **归因键** | **不定**。在拿到 `seriesId` / `promoCode` 维度合同之前不确定 |
| **已定的设计意图** | 继承 CPS 的 `candidate_count` + `candidate_snapshot_json`——**存下归因当时的候选集**，便于事后复盘"当初为什么归到这本书" |

#### 收益解析器的四条硬要求

`GetReport` 的响应里 `isTotal=1` 是**总计行**，`isTotal=0` 是明细行，两者在同一个 `data.list[]` 数组里。这是最容易出重复计数事故的地方：

1. **汇总行与明细行分别保存，或明确标记**（`is_total` 是正式列，不是 jsonb 里的一个 key）；
2. **聚合时不得把 `isTotal=1` 再次计入明细求和**；
3. **汇总行可用于明细对账**——两边算出来的数应该相等，不等就是解析出错；
4. **解析器必须有重复计数测试**。

#### 另外五条设计原则

- 原始字段名与标准业务字段**分离**（`raw_payload` 里是上游名，正式列是站内名）；
- `project_type` 是**强制维度**，不是可选筛选；
- 所有请求带 `request_fingerprint`；
- **空 `data.list` 是合法的成功结果**，不得算接口失败（R1 网文查询就返回了空列表且 `headers` 正常）；
- **`pageSize=999` 是观察值，不得假定接口永远无分页**——响应里没有 `totalCount`，所以分页终止条件必须靠"返回行数 < pageSize"之类的保守判据，并保留分页循环与安全上限。

**回答任务问题 9.12——收益合同未全冻结时如何预留而不建错模型：**

1. **逻辑模型可以定，物理表不建。** 已证部分（接口、请求体、`projectType` 分流、`isTotal` 语义、核心指标名）足以支撑主链设计；
2. **归因键留空并显式标 `PENDING_R3`**，不猜；
3. **把不确定性挤进 jsonb**：40+ 未使用指标留 `raw_payload`，将来要用哪个再列化哪个，不需要提前赌；
4. **把确定性做成约束**：`dedupe_key` 组成、`is_total` 分离、幂等键，这三条不依赖归因维度，现在就能定死。

---

## 3. 实体关系总览

```
Channel ──< ChannelApp >── SourceApp
   │            │
   │            ├──< NovelSourceItem >───── Novel ──< NovelChapter ──1:1── NovelChapterContent
   │            │         │  1:N              │  1:1        ▲
   │            │         │                   │             │
   │            │         └──< NovelChapterSourceItem ──────┘
   │            │         │
   │            │         └──< PromoLink（upstream_code 内部 / public_redirect_code 公开·唯一·不可变）
   │            │                  ▲
   └──< ChannelAccount ────────────┘
            │  │
            │  └──< ChannelAccountCredential ──< CredentialChangeLog
            │
            ├──< CatalogScanTask ──< CatalogScanTaskItem（page_index / page_range）   [v0.2 新增]
            │
            └──< ChannelSyncTask ──< ChannelSyncTaskItem ──> NovelSourceItem
                                            │
                                            └──> PromoClaimAudit

Novel ──1:1── NovelPreviewPolicy
Novel ──1:N── Article（每语种版本各自独立；V1 无跨 Novel 关系）──> IndexNowOutbox
NovelSourceItem ──< NovelSourceItemLabel >── SourceLabel ──< SourceLabelMapping >── CanonicalTag   [映射两表 Post-V1]

GenericTask ──< GenericTaskItem ──> (target_type, target_id)

PromoLink.public_redirect_code ──> /go/{code} ──> TrackingEvent（记公开码 + promo_link_id）

[P4] ChannelAccount ──< RevenueSyncScope ──< RevenueSyncBatch ──< RevenueRawSnapshot
                              │                      └──> RevenueDailyStat（scope × stat_date 唯一）
                              └──（归因键 PENDING_R3）RevenueAttributionSnapshot

[Post-V1] NovelWork / TranslationGroup ──（人工、可回滚）──< Novel
```

---

## 4. 全局建模纪律

### 4.1 jsonb 使用边界

**允许**：上游原始快照（`raw_payload`）、请求/响应形状（`request_summary_json` / `response_shape_json`）、错误详情、任务参数与结果、SEO 元数据、水位线。

**禁止**：任何需要被查询、筛选、排序、约束的业务字段。固定形状的值一律是列。

理由：jsonb 里的字段没有 NOT NULL、没有 CHECK、没有外键、没有类型保证。一旦业务开始依赖 jsonb 里的某个 key，它就应该是列了。

### 4.2 状态列必须有 CHECK 约束

CPS 有 40+ 个状态 String 列，**一个约束都没有**。这意味着代码里的一个拼写错误可以静默写进数据库。海外阅读全部状态列加 `CHECK (status IN (...))`。

### 4.3 软删除

核心表用 `deleted_at` 软删除。**所有唯一索引必须是部分唯一索引**（`WHERE deleted_at IS NULL`），否则软删行会占着唯一键位。

### 4.4 时间字段

统一 `timestamptz`。上游时间字段（`createTime` / `promoCreateTime`）**先存原始字符串再存解析值**——上游时区语义未证，解析错了还能重算。

### 4.5 敏感数据分级

| 级别 | 内容 | 存放 | 审计 | 导出 |
| --- | --- | --- | --- | --- |
| **禁存** | 明文凭证、Cookie、完整 JWT | ❌ | ❌ | ❌ |
| **加密存** | 渠道凭证 | 密文列，角色隔离 | 只存指纹 | ❌ |
| **业务存，审计掩码** | 推广码、完整推广 URL | `PromoLink` 正式字段 | `[redacted_code:length=N]` + hostname | 需能力位 |
| **版权内容** | 试读正文 | `NovelChapterContent.body` | ❌ | ❌ |
| **哈希存** | IP、User-Agent | 盐哈希 | — | 哈希值 |

---

## 5. 阶段归属汇总（v0.2：列名改 V1 / P4 / Post-V1）

| 实体 | V1 | P4 | Post-V1 |
| --- | :---: | :---: | :---: |
| `Novel` | ✅ | | |
| `NovelSourceItem` | ✅ | | |
| `NovelChapter` | ✅ | | |
| `NovelChapterSourceItem` | ✅ | | |
| `NovelChapterContent` | ✅ | | |
| `NovelPreviewPolicy` | ✅ | | |
| `SourceLabel` | ✅ | | |
| `NovelSourceItemLabel`（v0.2 新增） | ✅ | | |
| `CanonicalTag` | | | ✅ |
| `SourceLabelMapping` | | | ✅ |
| `NovelWork` / `TranslationGroup`（跨语种作品组） | | | ✅ |
| `Article` / 页面身份 | ✅ | | |
| `Channel` / `SourceApp` / `ChannelApp` | ✅ | | |
| `ChannelAccount`（1..N / 渠道） | ✅ | | |
| `ChannelAccountCredential` | ✅ | | |
| `CredentialChangeLog` | ✅ | | |
| `PromoLink`（含 `public_redirect_code`） | ✅ | | |
| `PromoClaimAudit` | ✅ | | |
| `CatalogScanTask` / `Item`（v0.2 新增） | ✅ | | |
| `ChannelSyncTask` / `Item` | ✅ | | |
| `GenericTask` / `Item` | ✅ | | |
| `IndexNowOutbox` | ✅ | | |
| `TrackingEvent` | ✅ | | |
| `HomeCarousel*` 五表（复用 CPS 形态） | ✅ | | |
| `RevenueSyncScope`（v0.2 新增） | | ✅ | |
| `RevenueSyncBatch` | | ✅ 逻辑模型已定 | |
| `RevenueRawSnapshot` | | ✅ 逻辑模型已定 | |
| `RevenueDailyStat` | | ✅ 逻辑模型已定 | |
| `RevenueAttributionSnapshot` | | ✅ **占位，归因键 `PENDING_R3`** | |

---

## 附录 · 本文档引用的 CPS 位置

| 引用 | 位置 |
| --- | --- |
| 来源条目表结构 | `prisma/schema.prisma:249-289` |
| 推广链接表结构 | `prisma/schema.prisma:292-326` |
| 推广审计表结构 | `prisma/schema.prisma:330-392` |
| 渠道注册四表 | `prisma/schema.prisma:99-246` |
| 凭证指纹互斥模式 | `prisma/schema.prisma:1236-1258` |
| IndexNow 两表 | `prisma/schema.prisma:1460-1519` |
| 幂等键构造 | `src/lib/changdu-promo-claim.ts:422-427` |
| 审计脱敏 | `src/lib/changdu-promo-claim.ts:371-384,568-570` |
| 写前意图审计 | `src/lib/changdu-promo-claim.ts:933-946` → `:948` |
| 埋点盐哈希 | `src/lib/cps-tracking.ts:284` |
| 埋点生产关停 | `docker-compose.yml:78-80` |
| 章节无对应物 | `prisma/schema.prisma:28-29`（只有 `episode_count` 标量） |
