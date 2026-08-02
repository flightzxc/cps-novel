# 海外阅读 v1 · 逻辑数据模型 v0.1（候选）

> 文档性质：**架构候选**，待 Owner 审核。
> **本文档只描述逻辑模型与字段责任，不是 Prisma Schema，不含 DDL，不构成 migration 依据。**
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

### 1.2 一本书的多语种关系，V1 不猜

任务问题 9.4 问：Novel 与不同语种 SourceItem 是一对一还是一对多？

**证据不支持任何一个答案。** `getlistpc` 请求体里没有 `language` 参数（`P0_BROWSER_INTERFACE_PROBE.md:47-48`），语种是返回行的属性；返回行里有 `hasMultiLanguage` 标志（`:55`），但语义未证。所以我们不知道：同一部作品的英语版和法语版，在上游是同一个 `seriesId` 的两条记录，还是两个不同的 `seriesId`。

**裁决：Schema 形状按 1:N 设计，V1 默认按 1:1 填充。**

- `NovelSourceItem.novel_id` 是可空外键，多条 SourceItem 可以指向同一个 `Novel`——**形状上支持 1:N**。
- V1 的归一化逻辑**不做跨语种自动合并**：每条来源条目建自己的 `Novel`。
- 合并成一个 canonical 作品是一个**独立的、人工发起的、可回滚的运维操作**，进 Phase 2。

这样做的代价是 V1 可能出现"同一部作品的英/法版是两个 Novel"。这个代价可接受，因为它是**可修复的**（后续合并）。反过来，如果 V1 自动合并错了，两本不同的书被并成一个 canonical 实体、共用了 slug 和 SEO 页，修复要动 URL——那是**不可修复的**（外链和索引已经建立）。

**在不确定时，选择可修复的错误方向。**

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
- **P2** = Phase 2 建
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
| `paid_from_chapter` | 上游 `payEpisFrom`（样本 8/6/6）。**收费边界，与已物化章数无关**。🔴 **下调时触发已展示章节自动下架**，见下 | 同步 |
| `split_ratio` | 上游 `splitRatio`。V1 准入门槛 ≥ 50 | 同步 |
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
| **必要索引** | 唯一键；`novel_id`；`(channel_app_id, source_locale)`；`source_updated_at`（增量）；`(channel_app_id, split_ratio)`（准入筛选） |
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
| `split_ratio` | `splitRatio` | 准入门槛字段 |
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
| **状态** | `preview`（试读）/ `locked`（付费，V1 不物化）/ `withdrawn` |
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
| `display_authorized` | 布尔 | Owner 已确认可展示（证据等级 `DOC_CONFIRMED`，Owner 声明；立项书建议补登分销协议编号与有效期） |
| `index_authorized` | 布尔，**默认 false** | 搜索引擎索引授权，**未确认**（待决 D-3） |
| `cache_authorized` | 布尔，**默认 false** | 缓存授权，**未确认**（待决 D-3） |
| `last_paid_from_chapter` | 整数 | **上一次同步看到的 `payEpisFrom`**。用于检测收费边界下调 |
| `last_refreshed_at` | 时间 | 刷新与撤回流程用 |

🔴 **收费边界下调的自动下架（立项书 §C.4 硬约束）**

> 若渠道上调 `payEpisFrom`（即把原本免费的章节改成付费），**已展示章节必须自动下架，不得靠人工盯**。

数据模型侧的支撑就是 `last_paid_from_chapter`：每次同步比对新旧值，一旦发现 `paid_from_chapter` 下调，把 `canonical_chapter_number >= 新值` 的章节置为 `withdrawn` 并删除对应正文行。这是**合规刚性**，不是优化项——继续展示已转付费的正文是实质侵权。

验收口径（立项书 §14.2 P2-04）：模拟 `payEpisFrom` 从 7 改为 2，第 2–3 章页在下一个同步周期内返回 404。

**这张表存在的唯一理由**：Owner 只确认了"可展示"，没确认"可索引"和"可缓存"（`P0_SECOND_BROWSER_PROBE.md:170`）。这三件事必须能分别开关，否则 sitemap 和 IndexNow 就会在没授权的情况下把正文推给搜索引擎。**默认 fail-closed。**

---

### 2.7 标签三表

#### `SourceLabel` — 上游原始标签

| 项 | 内容 |
| --- | --- |
| **阶段** | **V1**（Owner 裁决 `taxonomy.rawSourceLabels = REQUIRED`，第一天就存） |
| **责任** | 原样保存上游标签，不解释 |
| **唯一键** | `(channel_app_id, label_kind, external_label_value)` |
| **`label_kind`** | `series_type`（来自 `seriesTypeList`）/ `recommend`（来自 `recommendList`）/ `language`（来自 `language`+`languageName`）/ `agency` |
| **必要索引** | 唯一键；`label_kind` |
| **来源证据** | 四类来源字段全部存在但 `FIELD_PRESENT_SEMANTICS_UNCONFIRMED`（`P0_SECOND_BROWSER_PROBE.md:76-82`） |

#### `CanonicalTag` — 站内标准标签

| 项 | 内容 |
| --- | --- |
| **阶段** | **P2** |
| **责任** | 站内永久 SEO 分类。有聚合页、有 slug、有 hreflang |
| **唯一键** | `(locale, slug)` |
| **状态** | `draft` / `public` |

#### `SourceLabelMapping` — 映射关系

| 项 | 内容 |
| --- | --- |
| **阶段** | **P2** |
| **责任** | 原始标签 → 标准标签的人工/规则映射 |
| **唯一键** | `(source_label_id, canonical_tag_id)` |
| **状态** | `proposed` / `approved` / `rejected` |

**标签的三条纪律（回答任务问题 9.10）**：

1. **第一天就存原始标签**，哪怕还不知道怎么用。等到 Phase 2 再回头补，历史数据就永远缺了。
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

**canonical URL 规则（硬约束）**：每个 `Article` 的 canonical 指向它自己的 `/{locale}/novel/{slug}`。**不同 locale 的 Article 绝不共用 canonical。** 跨语种关系只用 hreflang 表达。

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

### 2.11 `PromoLink` — 推广资产

| 项 | 内容 |
| --- | --- |
| **阶段** | V1（只读取已有资源） |
| **责任** | 推广码与落地链接的资产层。canonical 实体上的推广字段只是可选投影 |
| **主键** | 代理主键 |
| **唯一键** | `idempotency_key` 全局唯一 = `(channel_app_id, external_book_id, source_language_code, channel_account_id)` |
| **外键** | `novel_source_item_id`、`channel_app_id`、`channel_account_id` |
| **状态** | `pending` / `fetched` / `failed` |
| **必要索引** | `idempotency_key` 唯一；`code`（`/go/:code` 查询）；`(status, fetched_at)`；`novel_source_item_id` |
| **jsonb 边界** | ✅ `raw_links_json` |
| **敏感字段** | **`code` 与 `web_url` 是真实值**。后台展示需能力位；审计里一律掩码 |
| **数据保留** | 长期 |
| **来源证据** | 结构对照 CPS `DramaPromoLink`（`prisma/schema.prisma:292-326`）；幂等键设计原样继承（`src/lib/changdu-promo-claim.ts:422-427`） |

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

### 2.13 任务四表

**必须区分两条任务线**——这是任务简报的显式要求，也是 CPS 的既有边界（`CLAUDE.md` §6.1）。

#### `ChannelSyncTask` / `ChannelSyncTaskItem` — 渠道同步

| 项 | `ChannelSyncTask` | `ChannelSyncTaskItem` |
| --- | --- | --- |
| **阶段** | V1 | V1 |
| **责任** | 一次渠道同步批次 | 批次里的一条来源条目 |
| **唯一键** | 同类型 active 任务**部分唯一索引**（`WHERE status IN ('pending','processing')`） | `(task_id, novel_source_item_id)` |
| **外键** | `channel_app_id`、`channel_account_id` | `task_id`、**`novel_source_item_id`** |
| **状态** | `pending` / `processing` / `completed` / `completed_with_errors` / `failed` / `disabled` | `pending` / `processing` / `success` / `skipped` / `failed` |
| **必要索引** | active 部分唯一；`(status, created_at)` | `(task_id, status)`；`(status, locked_until)`（租约恢复） |
| **jsonb 边界** | ✅ `params_json`、`result_json` | ✅ `error_json` |

**`ChannelSyncTaskItem` 的 target 一定是 `novel_source_item_id`（string FK），不是 `novel_id`。** 这条边界在 CPS 是明令的：来源条目与 canonical 实体不是一回事，同步的对象永远是来源条目。

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

**试读页是否进 outbox，取决于 `NovelPreviewPolicy.index_authorized`**（默认 false）。

---

### 2.15 `TrackingEvent`

| 项 | 内容 |
| --- | --- |
| **阶段** | V1 |
| **责任** | `/go/:code` 点击与前台页面事件 |
| **主键** | 代理主键 |
| **唯一键** | 无 |
| **必要索引** | `(promo_code, created_at)`；`(event_type, created_at)`；`(novel_id, created_at)` |
| **jsonb 边界** | ✅ `context_json` |
| **敏感字段** | **IP 与 User-Agent 必须盐哈希后存，不存原值**（CPS `cps-tracking.ts:284` 的 `hashSensitive`） |
| **数据保留** | **必须设保留期**（建议 90 天原始事件 + 长期日汇总）。这是最先撑爆表的数据 |
| **来源证据** | CPS 事件表 6 个索引设计良好，可直接参照 |

**写入策略必须重设计**：CPS 当前每事件一次 `create`（`cps-tracking.ts:147`），且**生产已整体关停埋点写入**（`docker-compose.yml:78-80` 三个开关全关）。这是 SQLite 单写者压力的直接证据。PG 下改为**批量写 + 独立 flush**，并保留同样的关停开关。

---

### 2.16 收益四表（**P4；本轮只设计逻辑模型，不建表、不写 Prisma**）

Owner 本轮明确指令：**"P4 可以设计主链，但书级归因继续标记 `PENDING_R3`"**。因此本节从"只留位置"升级为"给出逻辑模型"，但仍不产生任何 DDL。

**账户与作用域的暂定裁决**

```
ChannelAccount
  → one active credential
  → multiple RevenueSyncScope(projectType)
```

V1 **不要求**为 MoboReader / MoboReels 建两套 Credential。但必须同时记住四条限定：

1. 只证明了**技术查询账户共享**；
2. **未证明法律结算主体相同**；
3. **不按 agency 建收益账户**——当前收益合同根本不返回 agency 字段（这是已证的"不存在"，比"未知"更硬）；
4. 后续如发现独立凭证或主体字段，**模型必须支持拆分**——所以 `RevenueSyncScope` 是独立行而不是 `ChannelAccount` 上的一个列。

#### `RevenueSyncBatch`

| 项 | 内容 |
| --- | --- |
| **阶段** | P4 |
| **责任** | 一次收益回拉批次 |
| **唯一键** | `request_fingerprint`（同参数重复同步必须幂等） |
| **字段** | `channel_account_id`、`project_type`、`begin_time`、`end_time`、`request_fingerprint`、`status`、`counts`（请求数/明细行数/汇总行数）、`error` |
| **必要索引** | `request_fingerprint` 唯一；`(channel_account_id, project_type, begin_time)` |
| **状态** | `pending` / `running` / `completed` / `partial_failed` / `failed` |

#### `RevenueRawSnapshot`

| 项 | 内容 |
| --- | --- |
| **阶段** | P4 |
| **责任** | 上游返回行的原样存档，**写入时不加工** |
| **唯一键** | `dedupe_key` |
| **外键** | `sync_batch_id → RevenueSyncBatch` |
| **必要索引** | `dedupe_key` 唯一；`(project_type, dimension_key)`；`(sync_batch_id, is_total)` |
| **jsonb 边界** | ✅ `raw_payload` 存整行 |

正式列化的字段（**只展开当前 UI 与运营真正使用的核心指标**）：

```
sync_batch_id, project_type,
dimension, dimension_key, dimension_value, is_total,
real_dev_num, new_real_dev_num, real_dev_num_rate,
real_income, real_distrib_income, real_profit,
raw_payload (jsonb), dedupe_key
```

**其余 40+ 个上游字段（`activeRealIncome`、`newRealIncome`、`rmb*` 全系列、`subItems` 等）留在 `raw_payload`，不正式列化。** 理由：正式列化 60+ 指标会让表变成上游 schema 的镜子——上游一改字段就要 migration，而这些指标当前无人使用。

**`dedupe_key` 必须包含 `project_type` + 日期 + 维度。** 缺任一维度，跨品类或跨日的行会互相覆盖。

#### `RevenueDailyStat`

| 项 | 内容 |
| --- | --- |
| **阶段** | P4 |
| **责任** | T+1 日汇总（Owner 已确认 T+1 可接受） |
| **唯一键** | `(project_type, stat_date)` |
| **外键** | `source_batch_id → RevenueSyncBatch`（可追溯到哪次同步产生的） |
| **字段** | `project_type`、`stat_date`、核心指标、`source_batch_id` |

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
   │            │         └──< PromoLink
   │            │                  ▲
   └──< ChannelAccount ────────────┘
            │  │
            │  └──< ChannelAccountCredential ──< CredentialChangeLog
            │
            └──< ChannelSyncTask ──< ChannelSyncTaskItem ──> NovelSourceItem
                                            │
                                            └──> PromoClaimAudit

Novel ──1:1── NovelPreviewPolicy
Novel ──1:N── Article（每 locale 一条）──> IndexNowOutbox
Novel ──< NovelLabel >── SourceLabel ──< SourceLabelMapping >── CanonicalTag   [P2]

GenericTask ──< GenericTaskItem ──> (target_type, target_id)

PromoLink.code ──> TrackingEvent

[P4] ChannelAccount ──< RevenueRawSnapshot ──< RevenueAttributionSnapshot
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

## 5. 阶段归属汇总

| 实体 | V1 | P2 | P4 |
| --- | :---: | :---: | :---: |
| `Novel` | ✅ | | |
| `NovelSourceItem` | ✅ | | |
| `NovelChapter` | ✅ | | |
| `NovelChapterSourceItem` | ✅ | | |
| `NovelChapterContent` | ✅ | | |
| `NovelPreviewPolicy` | ✅ | | |
| `SourceLabel` | ✅ | | |
| `CanonicalTag` | | ✅ | |
| `SourceLabelMapping` | | ✅ | |
| `Article` / 页面身份 | ✅ | | |
| `Channel` / `SourceApp` / `ChannelApp` | ✅ | | |
| `ChannelAccount` | ✅ | | |
| `ChannelAccountCredential` | ✅ | | |
| `CredentialChangeLog` | ✅ | | |
| `PromoLink` | ✅ | | |
| `PromoClaimAudit` | ✅ | | |
| `ChannelSyncTask` / `Item` | ✅ | | |
| `GenericTask` / `Item` | ✅ | | |
| `IndexNowOutbox` | ✅ | | |
| `TrackingEvent` | ✅ | | |
| `HomeCarousel*` 五表（复用 CPS 形态） | ✅ | | |
| `RevenueSyncBatch` | | | ✅ 逻辑模型已定 |
| `RevenueRawSnapshot` | | | ✅ 逻辑模型已定 |
| `RevenueDailyStat` | | | ✅ 逻辑模型已定 |
| `RevenueAttributionSnapshot` | | | ✅ **占位，归因键 `PENDING_R3`** |

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
