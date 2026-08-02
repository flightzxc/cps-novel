# P1-05A · Claude 领域模型与数据字典评审

**Reviewer：Claude（架构设计总工程师 / 前后台 UI 领域模型消费者 / P1-05 Schema 领域 Reviewer）**

**评审日期：2026-08-03**

```text
RESULT=P1_05A_DOMAIN_REVIEW_REVISE
MIGRATION_GATE=CLOSED
```

---

## 1. 评审对象

| 项 | 值 |
| --- | --- |
| 审查分支 | `feature/v0.1.0-p1-schema` |
| Reviewed commit | `4b6aa8e40ec9c1b56cc1fee93ff82f98e8969f5b` |
| 基线（P1-04 skeleton） | `527a890cf0fec5bdde1654412ee3855e0eb92192` — 已核实为本 commit 祖先 |
| Schema models | **37** |
| Dictionary records | **797**（JSON 全部可解析） |
| 评审期间仓库工作树 | 0 行改动 |

### 1.1 实际读取文件与 SHA-256 前 16 位

| 文件 | SHA-256(16) |
| --- | --- |
| `prisma/schema.prisma` | `93f8dfa4739fdfcb` |
| `docs/governance/database-governance.md` | `10fc44c322616954` |
| `docs/governance/database-schema-dictionary.jsonl` | `1245aa1b2b1f864e` |
| `docs/p1/P1_05_SCHEMA_REVIEW_PACKAGE.md` | `aae0c5c318fe0d1f` |
| `docs/p1/P1_05_CPS_SCHEMA_EVIDENCE.md` | `685d8f7c0ee6b15e` |
| `docs/p1/P1_05_DEPENDENCY_CHANGE_REQUEST.md` | `b49eb7a2b7472306` |
| `src/domain/database-invariants.ts` | `40759880593f13d0` |
| `src/domain/database-statuses.ts` | `60dbdb6c6867eb3b` |

对照文档：`P1_OWNER_MINIMUM_CORRECTIONS.md`、`P1_IMPLEMENTATION_ASSIGNMENT.md`、`P1_SHARED_CONTRACTS.md`、`candidate-v0.2.1/novel-v1-logical-data-model-v0.2.1.md`、`candidate-v0.2.1/novel-v1-adapter-and-workflow-v0.2.1.md`。

### 1.2 评审纪律遵守声明

本轮**未修改**：`prisma/schema.prisma`、`src/domain/**`、`src/lib/db/**`、`database-governance.md`、`database-schema-dictionary.jsonl`。**未创建 Migration，未运行 `prisma db push`，未启动或连接数据库，未生成 Prisma Client。** 唯一新增文件为本文件。

---

## 2. 总体判断

这份 Schema 的**机械质量很高**：797 条字典与 37 个 model 双向零孤儿、零幽灵字段（字段维度），55 个 FK、38 个唯一约束、69 个具名索引、37 个主键、软删策略、JSON schema version 标注全部与 Prisma 源逐条吻合；22 个跨表抽样字段的类型/可空/默认/约束零错配。Owner 六项修正中与 Schema 直接相关的部分——`execution_token` + `lease_epoch` 双字段 fencing、`side_effect_intent` 与 `operation_audit` 双表分离、`public_redirect_code` 全局非部分 UNIQUE、`encrypted_secret` 仅 `worker_app` 可读——**逐条落地正确**。CPS 证据文档也表现出应有的诚实：明确记录 CPS 的 `locked_until` 命中的是登录风控而非 Worker item lease，"不能冒充任务租约证据"。

Prisma 无法表达的部分（部分唯一索引、CHECK、不可变 trigger、append-only 权限）被系统性登记在 `database-governance.md` §5「Migration-only 物理约束清单」14 条中，这是正确的分层——我初读 Schema 时标记的「`novel(locale,slug)` / `novel_chapter(novel_id,canonical_chapter_number)` / `article(locale,slug)` 缺唯一约束」三项，在该清单中均已覆盖。

**判为 REVISE 而非 PASS，原因是三条 PASS 条件中有两条未达成**：

1. **「零阻断领域错误」未达成** —— 逻辑数据模型 §1.1 的三条建模主线之一「上游同步只补空、不覆盖已有人工值」，在 Schema、governance、`database-invariants.ts`、字典 `llm_constraints` **四处全部无表达**（R-01）。这同时是本轮评审任务 二.1 明确要求确认的五项之一。
2. **「字典可作为后续大模型写库记忆基线」未达成** —— `article.body` 的 `business_meaning` 是从 `novel_chapter_content.body` 逐字复制的错误语义，且 `read_roles` 排除了 `web_app`（R-02）；`fingerprint_prefix` 记录自相矛盾（R-03）；24 处 `status` 字段共用同一句无信息量的「实体当前状态」，`stale`/`withdrawn` 的语义与转移条件在字典中不可查（R-08）。

第 2 条尤其关键：字典的立身之本是「让后续大模型不必回头猜」。当一条记录自相矛盾、或与同类字段矛盾时，模型无法在不回读 `schema.prisma` 的情况下自行仲裁——这恰好取消了字典存在的意义。

**所有必须修订项都是局部的**，无一要求重新设计整体结构。修完即可复评。

---

## 3. 领域检查表

### 3.1 Novel 与 NovelSourceItem — **PASS**

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 一个来源语种版本 → 一个独立 Novel | ✅ | `NovelSourceItem` 唯一键 `(channel_app_id, external_book_id, source_language_code)`（`novel_source_identity_key`）；`Novel.locale` 非空单值 |
| 形状支持 1:N，V1 填 1:1 | ✅ | `NovelSourceItem.novel_id` 可空 + `onDelete: SetNull`；governance §3.2 DROP 列明确列出「跨语言自动合并」 |
| 多渠道、多账户 Day 0 可容纳 | ✅ | `ChannelAccount.channel_id` 无 1:1 约束；governance §3.1 明确「不得建 Channel 1:1 Account」；`PromoLink` 幂等键含 `channel_account_id` |
| `split_ratio` 不是准入门槛 | ✅ | `Novel.split_ratio` / `NovelSourceItem.split_ratio` 均为可空 `Decimal(9,4)`，无 CHECK 下限；字典 `llm_constraints` 显式禁止用作准入闸 |
| 未知 locale 时 SourceItem 可留、不得错误发布 | ✅ | `NovelSourceItem.source_locale` 可空、`novel_id` 可空；`Novel.locale` 非空 → 未知语种物理上无法建出 Novel，天然阻断发布 |
| 上游同步只补空、不覆盖 canonical | ❌ | **R-01**，见 §5 |

### 3.2 章节三表 — **PASS（语义正确）／字典侧有缺口**

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 三表责任不混淆 | ✅ | SourceItem 存上游身份 + `raw_payload`（**不含正文**）；`NovelChapter` 存站内章号/状态；`NovelChapterContent` 1:1 存正文 + `char_count` + `content_hash` |
| `chapterList[]` 是物化真源 | ✅ | `database-invariants.ts:5` `previewTruth`；governance §3.2 DROP 列「用 `allEpis` 生成章节占位」 |
| `paid_from_chapter` 仅元数据 | ✅ | `Novel` / `NovelSourceItem` 上均为可空 Int；字典 `llm_constraints` 显式禁止触发删除；governance §3.2 DROP 列「paid_from_chapter 触发删除」 |
| 不因 `payEpisFrom` 变化删章 | ✅ | 同上，且 `NovelPreviewPolicy` **没有** `last_paid_from_chapter` 触发器字段（v0.2.1 已删该机制） |
| 可信响应缺席 → stale | ✅ | 状态枚举含 `stale`；`NovelChapterSourceItem.last_seen_at` 承载「最近出现」 |
| 不可信响应 → 不改状态 | ⚠️ | 语义正确但**字典未记录**，见 R-08 |
| stale 重现 → 自动恢复 | ⚠️ | 同上 |
| 正文不因 stale 硬删 | ✅ | governance §8「`withdrawn` 保留元数据但删除 `novel_chapter_content`；`stale` 只停展，正文保留」 |
| 删除 `consecutive_miss_count` | ✅ | governance §3.2 DROP 列显式列出；Schema 中确无该字段 |

**正确的设计决定**：「最近是否出现」记在 `NovelChapterSourceItem.last_seen_at`（上游镜像层），而展示状态记在 `NovelChapter.status`（站内身份层）。两个关注点分层干净，未混进同一张表。

### 3.3 状态枚举 — **PASS**

`src/domain/database-statuses.ts` 与 governance §4 逐条一致，**无 `pending`/`offline` 与 `published`/`unpublished` 混用**：

| 实体 | 枚举 | 与 shared contracts §9 一致 |
| --- | --- | --- |
| Novel | `draft / ready / published / unpublished / takedown` | ✅ |
| Article | `draft / published / unpublished / takedown` | ✅ **未移植 CPS 的 `pending`/`offline`** |
| NovelChapter | `preview / locked / stale / withdrawn` | ✅ |
| NovelSourceItem | `pending / linked / ignored / stale` | ✅ |
| PromoLink | `pending / fetched / failed / registered_disabled` | ✅ |
| Task / Item | 六态 / 五态（Catalog Item 四态） | ✅ |

- **`unpublished` 与 `takedown` 区分**：governance §8 + shared contracts §9 —— `unpublished` 稳定下架页、正文保留；`takedown` 返回 410、删除 `novel_chapter_content`。已分离。✅
- **定时发布**：Article 无 `pending` 态，改由 `publish_at` + ScheduleRun/Task 表达。这是比 CPS 更干净的建模——状态机不因调度而膨胀。✅
- **`stale`/`withdrawn`/`locked` 的前台与 SEO 行为**：语义在 governance 中正确，但**字典层不可查**（R-08）。

### 3.4 Locale — **PASS**

| 检查项 | 结论 |
| --- | --- |
| `locale` 使用站点 canonical locale | ✅ `Novel.locale` / `Article.locale` 非空 |
| 上游值原样保留 | ✅ `source_language_code`（非空）、`source_language_name`（可空）、`source_locale`（可空，站点 locale 解析结果） |
| 数据库层无第二套语言映射 | ✅ 全 Schema 无映射表、无 CHECK 枚举 locale 值——映射唯一真源仍是 `src/lib/locale/locale-canonical.ts` |
| 未知语种不被猜测 | ⚠️ 结构上正确（`source_locale` 可空、Novel 无法建出），但**无显式 `llm_constraints`**，见 R-10 |
| 发布白名单 ≠ 语言映射 | ✅ 数据库不含白名单，白名单是应用层概念。两者未被混为一谈 |

### 3.5 PromoLink — **PASS（选链问题已解决）**

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 两码完全分离 | ✅ | `upstream_code`（`Text`，可空）与 `public_redirect_code`（`VarChar(32)`，非空）是两个独立列 |
| 公开码全局唯一 | ✅ | `@unique(map: "promo_link_public_redirect_code_key")` |
| **唯一约束不排除软删** | ✅ | 使用 Prisma 普通 `@unique` → 生成**全表** UNIQUE，软删行继续占位。governance §5.10 明确「全局非部分 UNIQUE…软删行继续占位」+ 计划不可变 trigger。**这条与其他表「部分唯一排除软删」的通例相反，Codex 正确识别并单独处理了这个特例** |
| 不可变 | ✅ | governance §5.10 计划不可变 trigger（Prisma 无法表达，登记正确） |
| 真实码不进公开 URL | ✅ | `TrackingEvent` 存 `public_redirect_code` + `promo_link_id`，**无** `upstream_code` 列 |
| **CTA 选链确定性** | ✅ | **`Article.promo_link_id` 显式定链**。`Article` 有 `@@unique([novel_id, locale])`，故「一部 Novel 在某 locale 下用哪条 PromoLink」由一行 Article 唯一确定，**不依赖 `findFirst` 的偶然顺序**。这正面回答了评审任务 二.5 的核心问题 |
| 多账户多来源下的可表达性 | ✅ | 幂等键 `(channel_app, external_book, source_language, channel_account)` 允许同书多账户并存多条 PromoLink，而 Article 单选其一 |

⚠️ 但选链存在**跨 Novel 一致性缺口**：见 R-07。

### 3.6 前台读模型与 SEO — **PASS**

| 前台需求 | 支撑 | 结论 |
| --- | --- | --- |
| 小说详情不加载章节正文 | 正文在 `novel_chapter_content` 独立表，详情页不 join | ✅ |
| 试读目录按 canonical 章号排序 | `@@index([novel_id, status, canonical_chapter_number])` | ✅ 一条复合索引同时支撑「按状态过滤 + 按章号排序」 |
| 章节页取上下章 | 同一索引支持范围扫描（`> n` / `< n` + limit 1） | ✅ 无需额外索引 |
| self-canonical 页面身份 | `article.public_page_short_id` 全局唯一；`(locale, slug)` 活跃部分唯一（governance §5.5） | ✅ |
| Sitemap / IndexNow 状态与时间 | `article(status, published_at)`、`novel(status, updated_at)`、`indexnow_outbox(url, revision)` 唯一 + 两条状态索引 | ✅ |
| locale / slug / page id 唯一性 | governance §5.3/§5.5 + `public_page_short_id @unique` | ✅ |
| published 页面必须有公开跳转码 | governance §5.11 要求，但**仅靠写事务保证** | ⚠️ R-05 |
| 无明显 N+1 或正文误加载结构 | 未发现结构性 N+1；正文与列表已分表 | ✅（一条查询层提示见 §6） |

### 3.7 数据字典 — **REVISE**

机械一致性（详见 §4）优秀；**语义质量有四处必须修订**（R-02、R-03、R-04、R-08）。

---

## 4. 数据字典检查结果

### 4.1 机械一致性 — 全部通过

| 检查 | 结果 |
| --- | --- |
| 797 条记录键集一致（同为 29 键） | ✅ 无缺键/多键 |
| `stable_key` 唯一且稳定 | ✅ 797/797 唯一，格式 `db:public:{table}[:{field_or_constraint}]`，不含序号/索引名等易变来源 |
| 记录构成 | ✅ 37 table + 496 field + 264 constraint = 797，表数与 37 model 吻合 |
| **幽灵字段**（字典有、Schema 无） | ✅ **字段维度 0 条** |
| **孤儿字段**（Schema 有、字典无） | ✅ **0 条**，496 个 scalar 列全覆盖 |
| 55 个 FK（含 `onDelete`） | ✅ 双向零错配 |
| 38 个唯一约束 | ✅ 全覆盖，含 18 个 Prisma 隐式命名 |
| 69 具名索引 + 9 计划部分索引 | ✅ 部分索引为 Prisma 不可表达项，登记合理 |
| 40 个 CHECK | ✅ 枚举列表均含该字段 `@default` 值（1 例外见 R-04） |
| 软删策略 vs 实际 `deleted_at` 列 | ✅ 37 表 100% 一致 |
| `json_schema_version` vs `Json` 列 | ✅ 恰好覆盖 36 个 Json 列 |
| 内部交叉引用无悬空 | ✅ |
| 物理索引细节与业务语义分离 | ✅ 索引记录独立成 constraint-kind，未混入字段 `business_meaning` |
| 22 字段跨 12 表抽样（类型/可空/默认/约束） | ✅ 零错配 |

### 4.2 关键字段语义 — 七项正确，两项错误

| 字段 | 结论 |
| --- | --- |
| `public_redirect_code` | ✅ 全局唯一、不可变、永不复用、不排除软删，`llm_constraints` 显式 |
| `upstream_code` | ✅ 仅内部，禁入公开 URL 与埋点 |
| `lease_epoch` | ✅ 单调世代号、仅易主时 +1、心跳不改；另有 `*_fenced_result_contract` / `*_lease_shape_check` 专项约束记录 |
| `execution_token` | ✅ 与 `lease_epoch` 成对 fencing |
| `paid_from_chapter` | ✅ 显式禁止触发删除 |
| `split_ratio` | ✅ 显式禁止用作准入闸 |
| `encrypted_secret` | ✅ `read_roles: ["worker_app"]`，无 `web_app`、无 `scheduler_app` |
| `article.body` | ❌ **R-02**：语义错误 + 角色错误 |
| `channel_account_credential.fingerprint_prefix` | ❌ **R-03**：记录自相矛盾 |

### 4.3 元数据质量

- **`source` 字段是「假朋友」**：其值为 `CPS_PARITY` / `CPS_PARITY_ADAPTED` / `ORIGINAL_REQUIRED`，编码的是**相对 CPS 的设计血统**，而非评审任务 二.7 所要求的「上游字段 / 站内字段 / 派生字段」数据来源分类。后者目前只以中文自由文本存在于 `business_meaning`，**不可机器查询**。见 R-06（建议项）。
- **`llm_constraints` 覆盖 5/6 条 Owner 禁令**：`paid_from_chapter` 不触发删除、公开码不复用、`split_ratio` 不作准入、不写未证协议字段、结果提交前必须 fencing —— 五条显式且正确；**「未知 locale 不得猜测」仅隐含**（R-10）。
- **`deprecated`/`superseded` 机制**：`status` 与 `supersedes` 两键已定义，但 797 条中 `status` 恒为 `planned`、`supersedes` 恒为 `[]` —— 机制已声明、尚未行使。当前阶段合理，无需修订。
- **`sensitive_level` / `read_roles` / `write_roles`**：字段齐备，绝大多数合理；两处确认错误见 R-02、R-03。

---

## 5. 必须修订项（REQUIRED REVISIONS）

以下 10 项须由 Codex 修订后复评。**Claude 未修改任何 Codex 文件。**

### R-01 · canonical「只补空不覆盖」不变量全链路无表达 🔴 阻断

| 项 | 内容 |
| --- | --- |
| table | `novel`（同类风险及于 `novel.title` / `description` / `cover_url` / `slug` / `author` 等运营可编辑字段） |
| field / constraint | 无（正是问题所在） |
| stable_key | `db:public:novel:title`、`db:public:novel:description`、`db:public:novel:cover_url`、`db:public:novel:slug` |
| 当前定义 | `business_meaning` 分别为「展示标题」「展示或来源简介」「经校验并归一化的封面地址」「稳定 URL 语义片段」；**四者 `llm_constraints` 均为 `[]`**。`database-invariants.ts` 12 条不变量中无对应条目；`database-governance.md` 全文无「补空」「不覆盖」表述 |
| 应改定义 | ① 在 `database-invariants.ts` 增补不变量，例如 `canonicalFillOnly: "Upstream sync fills empty canonical fields only; it never overwrites an operator-maintained value."`；② 在上述字段的 `llm_constraints` 中显式写入「上游同步只允许在字段为空时写入，禁止覆盖非空值」；③ 在 `database-governance.md` 增加一节说明该不变量由哪一层保证（写事务 / 触发器 / 字段级 provenance 标记），若选择 provenance 标记则需补相应列 |
| 业务原因 | 这是逻辑数据模型 v0.2.1 §1.1 三条建模主线之一：「`Novel` 是站内权威……上游同步只补空、不覆盖已有人工值」，也是本轮评审任务 二.1 要求确认的五项之一。CPS 曾因早期直写 canonical 导致**人工编辑被机器覆盖**，此后才有 `manual-promo-lock` 与第三把钥匙。当前 Schema 与字典对此零表达 —— 后续任何大模型或 Worker 实现同步逻辑时，没有任何一处会告诉它「不能覆盖」，事故会以完全相同的形式重演 |

### R-02 · `article.body` 语义错误 + 角色错误 🔴 阻断

| 项 | 内容 |
| --- | --- |
| table | `article` |
| field | `body` |
| stable_key | `db:public:article:body` |
| 当前定义 | `business_meaning: "受版权保护的纯文本试读正文"`；`sensitive_level: "S2_RESTRICTED"`；`read_roles: ["worker_app","analyst_ro_masked"]`；`write_roles: ["migration_owner","web_app","worker_app"]` |
| 应改定义 | `business_meaning` 改为准确描述，例如「由模板引擎渲染生成的 SEO 文章正文，面向匿名访客公开展示」；`read_roles` 增加 `web_app`；`sensitive_level` 复核（公开页面内容不应与版权正文同级） |
| 业务原因 | **两个独立错误。** 其一，该 `business_meaning` 与 `db:public:novel_chapter_content:body` **逐字节相同**（全字典仅此 2 处出现该字符串），是复制粘贴残留——`Article.body` 是模板渲染出的 SEO 页面内容，**不是**渠道版权正文，两者的保留、删除、导出规则完全不同（`withdrawn` 时删章节正文但不应删文章）。其二，`web_app` **可写不可读**自相矛盾，而 `article` 表的 `slug` / `public_page_short_id` / `seo_metadata` / `status` 均正确含 `web_app` 读权限；对照 `novel_chapter_content.body`（同为 S2、同一句 meaning）却正确含 `web_app`。按现状实现，前台渲染自己的公开页面需绕道 worker——这是字典作为记忆基线时最危险的一类错误：模型会直接采信而不回溯推导 |

### R-03 · `fingerprint_prefix` 记录自相矛盾 🔴

| 项 | 内容 |
| --- | --- |
| table | `channel_account_credential` |
| field | `fingerprint_prefix` |
| stable_key | `db:public:channel_account_credential:fingerprint_prefix` |
| 当前定义 | `business_meaning: "允许 Web 展示的非敏感指纹前缀"`；但 `sensitive_level: "S2_RESTRICTED"`；`read_roles: ["worker_app","analyst_ro_masked"]`（**无 `web_app`**） |
| 应改定义 | `read_roles` 增加 `web_app`；`sensitive_level` 下调为 `S1_INTERNAL`，与同表 `expires_at`（S1 + 含 `web_app`）对齐 |
| 业务原因 | 记录**内部自相矛盾**：meaning 说「允许 Web 展示的非敏感」，而 level 标 S2_RESTRICTED、roles 排除 web_app。Owner 修正 5.2 明确 Web 可展示凭证**元数据**（指纹前缀、过期时间、状态）三项。governance §7 表格也写「fingerprint/prefix/expiry/status … Web：仅元数据」。按字典现状，P1-08/P1-09 的凭证管理后台无法显示指纹前缀，而这是运营辨认凭证的唯一手段（密文永不回显） |

### R-04 · 幽灵约束记录 🔴

| 项 | 内容 |
| --- | --- |
| table | `indexnow_outbox_attempt` |
| constraint | `indexnow_outbox_attempt_status_check` |
| stable_key | `db:public:indexnow_outbox_attempt:indexnow_outbox_attempt_status_check` |
| 当前定义 | `enum_or_check: "status IN ('started','accepted','retryable_failed','permanent_failed')"` —— 但该表**没有 `status` 列**（实际列为 `attempt_state`，Prisma 字段 `attemptState`） |
| 应改定义 | **删除该记录**。正确记录 `indexnow_outbox_attempt_attempt_state_check`（`attempt_state IN (...)`）已并存于字典中 |
| 业务原因 | 字典是唯一机器可读基线。同一张表并存两条内容相同、列名不同的 CHECK 记录，模型无法在不回读 `schema.prisma` 的情况下判断哪条为真——这恰好取消了字典的作用。若按错误记录生成 Migration，CHECK 会因列不存在而失败 |

### R-05 · published Article 的行内必要条件应下沉为 CHECK 🟡

| 项 | 内容 |
| --- | --- |
| table | `article` |
| constraint | governance §5 第 11 条 |
| 当前定义 | 「published Article 必须具备 slug、public_page_short_id、promo_link_id、published_at；Article locale 必须与 Novel locale 一致，**由写事务和集成测试共同保证**」 |
| 应改定义 | 拆成两半：**行内条件下沉为表级 CHECK** —— `CHECK (status <> 'published' OR (slug IS NOT NULL AND public_page_short_id IS NOT NULL AND promo_link_id IS NOT NULL AND published_at IS NOT NULL))`；**跨表条件**（Article.locale = Novel.locale）保留写事务 + 测试，或用触发器 |
| 业务原因 | 前四项全部是**同一行内**的判断，PostgreSQL CHECK 完全可以表达，没有理由降级为应用层约定。governance §6 自己确立的原则是「应用层预查只用于提示，正确性由数据库唯一约束保证」——此处与该原则不一致。shared contracts 把「published 必须有有效公开跳转码」列为发布门禁硬条件；一旦仅靠应用层，一次手工 SQL 或一个分支遗漏就会产出 CTA 指向空的已发布页面 |

### R-06 · `home_carousel_serving` 时间有效期与绝对唯一键自相矛盾 🟡

| 项 | 内容 |
| --- | --- |
| table | `home_carousel_serving` |
| constraint | `carousel_serving_locale_position_key` = `UNIQUE (locale, position)` |
| stable_key | `db:public:home_carousel_serving:carousel_serving_locale_position_key` |
| 当前定义 | 表同时具备 `valid_from`（非空）、`valid_to`（可空）、索引 `[locale, valid_from, valid_to, position]`，以及**绝对** `UNIQUE(locale, position)`。governance §3.5 描述为「当前 serving 快照」，DROP 列却写「无来源追溯的覆盖写」 |
| 应改定义 | **二选一并保持一致**：<br>① 若为「仅当前快照、就地覆盖」→ 删除 `valid_to` 与时间区间索引，明确 serving 无历史；<br>② 若需保留历史 → `UNIQUE` 改为部分唯一 `(locale, position) WHERE valid_to IS NULL`，并把该部分索引登记进 governance §5 |
| 业务原因 | 两者当前不可兼得：绝对 `UNIQUE(locale, position)` 意味着每个位置**永远只能有一行**，那么写入新一期 serving 必然唯一键冲突，`valid_to` 与时间区间索引永远不会被使用；反之若要保留历史，绝对唯一键必须让位。而 DROP 列声明要「来源追溯」，恰恰指向方案 ②。这是本次 Schema 中唯一一处**内部设计冲突**，会在 P2 首页轮播上线时立刻暴露 |

### R-07 · `Article.promo_link_id` 缺跨 Novel 一致性保证 🟡

| 项 | 内容 |
| --- | --- |
| table | `article` |
| field | `promo_link_id` |
| stable_key | `db:public:article:promo_link_id` |
| 当前定义 | FK → `promo_link.id`（`onDelete: Restrict`）。governance §5.11 只要求「Article locale 必须与 Novel locale 一致」，**未涉及 promo_link 是否属于同一 Novel** |
| 应改定义 | 增加不变量并落地保证：`article.promo_link_id` 所指 PromoLink，其 `novel_source_item.novel_id` 必须等于 `article.novel_id`。因跨两跳（Article → PromoLink → NovelSourceItem → Novel）无法用 CHECK 表达，应采用触发器或写事务 + 集成测试，并在 `database-invariants.ts` 与字典 `llm_constraints` 中登记 |
| 业务原因 | 当前 Schema 允许「Novel A 的文章挂 Novel B 的推广链接」。后果是读者从 A 的页面点击后跳到 B 的落地页，同时收益归因也记到 B —— 属于静默的内容错配 + 收入错配，且从数据上难以发现。既然 `Article.promo_link_id` 是选链确定性的**唯一**依据（这也是它优于 `findFirst` 的价值所在），它的指向正确性就必须被守住 |

### R-08 · 24 处 `status` 字段语义空洞，`stale`/`withdrawn` 不可查 🟡

| 项 | 内容 |
| --- | --- |
| table | 全部 24 张含 `status` 的表，**以 `novel_chapter` 为最关键** |
| field | `status` |
| stable_key | `db:public:novel_chapter:status`（其余 23 处同此模式） |
| 当前定义 | 24 条记录的 `business_meaning` **逐字节相同**：「实体当前状态」。各状态的实际含义与转移条件仅存在于 `enum_or_check` 的取值列表中 |
| 应改定义 | 为每个 `status`/`mode`/`origin` 字段补写**逐值术语表**。`novel_chapter.status` 至少须说明：`preview`＝已物化、前台展示、可索引；`locked`＝付费章，V1 不物化；`stale`＝**在一次可信（成功且结构完整且非空）响应中缺席 → 立即停展、退出 sitemap，正文保留**；`withdrawn`＝人工撤回，**唯一会删除 `novel_chapter_content` 的状态**。并补充转移触发条件：不可信响应（失败/结构异常/异常空列表）**不改变任何状态**；`stale` 章重新出现 → **自动**恢复 `preview` |
| 业务原因 | 这正是「语义错误比记录缺失更糟」的典型。字典正确告诉模型**哪些值合法**（CHECK 完整无误），却没告诉它**每个值意味着什么、何时转移**。而 `stale` 与 `withdrawn` 的差别恰恰是「正文保留」与「正文删除」——判断错就是不可逆的数据删除或不该展示的版权内容继续在线。Owner 修正 6 与 v0.2.1 已把这套语义冻结得非常明确，字典却完全没有承接 |

### R-09 · 「未知 locale 不得猜测」缺显式约束 🟡

| 项 | 内容 |
| --- | --- |
| table | `novel_source_item` |
| field | `source_locale` |
| stable_key | `db:public:novel_source_item:source_locale` |
| 当前定义 | `business_meaning` 提及「经单一 Locale 真源解析的站点 locale；可为 unknown/null」，但 `llm_constraints` 未包含禁止猜测的条目 |
| 应改定义 | 在 `llm_constraints` 显式加入：「映射不到时必须落 `unknown`/`null`，禁止猜测、禁止用上游原值当站点 locale；`unknown` 时不得创建 Novel」 |
| 业务原因 | Owner 六条禁令中其余五条均已显式编码，唯独此条只是隐含。shared contracts §2 把 Locale 契约列为 `FROZEN` 级；CPS 因语种映射散落曾付出两次全库 normalize 的代价。隐含表述不足以约束后续模型 |

### R-10 · `port-registry.md` 本轮零登记 🟡

| 项 | 内容 |
| --- | --- |
| 文件 | `docs/governance/port-registry.md` |
| 当前定义 | 仍为 P1-04 交付的空表（仅表头），本 commit **未改动**；正文仍写「本轮（P1-04）尚未搬运任何 CPS 代码」 |
| 应改定义 | 为 governance §3 中所有标注 `CPS_PARITY` / `CPS_PARITY_ADAPTED` 的表登记条目，`port_kind` 取 `PATTERN_ONLY` 或 `ADAPT`，`source_file` + `source_lines` 直接引用 `P1_05_CPS_SCHEMA_EVIDENCE.md` §2/§3 已记录的 CPS 精确行号，`baseline_commit` 填 `d77c3b968285698529cf97c7f0f97b286d7a2a9c` |
| 业务原因 | `P1_IMPLEMENTATION_ASSIGNMENT.md` §6 通用完成检查第 2 条要求「每个从 CPS 搬入的符号都必须登记 port-registry，未登记即视为违规」。governance §3 明确把 20 余张表标为 CPS 复刻分类，`P1_05_CPS_SCHEMA_EVIDENCE.md` 也已备齐精确行号证据——**证据已经取到，只差登记动作**。P1-14 SOL 5.6 审计会逐条回溯 port-registry，此时补登成本最低 |

---

## 6. 建议项（非阻断）

1. **`source` 字段改名或补充**（对应 §4.3）：当前 `source` 编码的是设计血统（`CPS_PARITY` 等），与「数据来源」直觉冲突。建议改名为 `design_lineage`，另增 `data_provenance` 字段承载「upstream / site_internal / derived」三分——评审任务 二.7 要求的正是后者。当前只能靠中文自由文本判断，不可机器校验。
2. **`content_hash` 补行为契约**：`business_meaning` 仅说「正文 SHA-256 哈希」，`llm_constraints: []`。应写明它是「判断上游正文是否变化、决定是否重写」的依据，与刷新语义挂钩。否则读起来像一个无行为的完整性校验值。
3. **`Article.body` 的列表查询纪律**：`body` 与列表字段同表，前台聚合页/轮播若用 `findMany` 不带 `select` 会把每行大文本载入内存。属查询层纪律，建议在 shared contracts 数据读契约中明确「列表查询必须显式 `select`，禁止裸 `findMany`」。
4. **Sitemap 增量索引**：`article` 现有 `(status, published_at)`；IndexNow「内容变更后重推」更依赖 `updated_at`。数据量上来后建议补 `(locale, status, updated_at)`。
5. **`GenericTask` 的 `(task_type, origin_task_id)` 唯一键**：`origin_task_id` 可空，PostgreSQL 中 NULL 互不相等，故多行 NULL 可并存。若这是有意（仅在有 origin 时去重）建议在字典写明，避免后续误读为「全局去重」。
6. **首页轮播五表的阶段归属**：见 §7 第 3 问。

---

## 7. 特别检查七问

| # | 问题 | 回答 |
| ---: | --- | --- |
| 1 | 37 个 model 是否都属于 P1 必需？ | **基本是，一组存疑。** 分布为：渠道账户凭证 8 + 内容章节标签 8 + 任务审计调度 10 + 发布推广流量 6 + 轮播 5 = 37。前 32 张对应 P1-05~P1-08 的直接交付或 `P1_IMPLEMENTATION_ASSIGNMENT.md` P1-05 明列的数据模型草案（`novel`/`novel_source_item`/`novel_chapter`/`novel_chapter_content`），必需。**轮播 5 张不在 P1-05 交付清单内**，见第 3 问 |
| 2 | 是否有把 P2/P4 才需要的表过早做成硬依赖？ | **否。** 依赖方向健康：轮播 → Article/Novel 单向，无反向依赖，P1 核心不因轮播而受制。收益（P4）表完全不存在。`CanonicalTag`/`SourceLabelMapping`（Post-V1）、跨语种作品组均未建 |
| 3 | 首页轮播五表应在 P1-05 全建还是延后 P2？ | **建议延后，或至少拆为独立 Migration。** 理由不是依赖问题（第 2 问已说明无反向依赖），而是**质量信号**：本次 Schema 唯一的内部设计冲突（R-06 serving 时间有效期 vs 绝对唯一）就出在轮播组，说明这组是全表中打磨最少的部分。而轮播是 P2 前台功能，P1 无人消费它。**处置建议**：若 R-06 能在本轮修订中一并解决，可保留在 P1-05B；若希望尽快解锁 P1-06/P1-07，则把五表移出首个 Migration，留待 P2 单独交付——这样 P1 地基不被一个前台功能的设计分歧阻塞 |
| 4 | Article 基础实体是否足以支持 P2 且无 CPS 历史包袱？ | **是。** 支持面齐备：`locale`/`slug`/`public_page_short_id`/`seo_metadata`/`published_at`/`template_id`/`promo_link_id`，`@@unique([novel_id, locale])` 保证每语种版本一页。包袱清理干净：全 Schema **零** `drama_id`、零 `ArticleDramaSwitch*`、零 blog/reviews 字段、零 `seoVisibility`（v0.2.1 已改为 self-canonical 全量可索引 + 单本 `index_authorized` 开关，故不需要）。已核实 `drama|switch|review|blog|feishu|settlement` 的 7 处 grep 命中**全部是 `preview`/`NovelPreviewPolicy` 与文件头注释的假阳性** |
| 5 | Revenue 是否只预留账户结构、未猜写归因字段？ | **是。** 全 Schema `revenue` 零命中，无 `RevenueSyncScope`/`RevenueSyncBatch`/`RevenueRawSnapshot`/`RevenueDailyStat`/`RevenueAttributionSnapshot`。多账户能力由 `ChannelAccount` 本身承载（`channel_id` 无 1:1 约束，governance §3.1 明令「不得建 Channel 1:1 Account」），这正是 Owner 修正 5 要求的「Day 0 支持多账户」——**而归因维度仍 `PENDING_R3`，一个字段都没猜**。处置正确 |
| 6 | 北斗是否只有渠道无关结构占位、无协议字段？ | **是。** 全 Schema `beidou|北斗|changdu|moboreader|getlistpc|getcode|kocCode` **零命中**。渠道能力经 `ChannelCapability`（`capability_key` + `status` + `evidence_level` + `reason_code`）泛化表达，默认 `registered_disabled`；`ChannelApp.project_type` 参数化，无模块级硬编码。北斗接入时只需插数据行，不改表结构——渠道无关性在 Schema 层成立 |
| 7 | `raw_payload` 是否按 CPS 方案 A 保存但审计强制脱敏？ | **是。** `NovelSourceItem.raw_payload` / `NovelChapterSourceItem.raw_payload` 为非空 `jsonb` + `raw_payload_schema_version`，保存上游整行原文（方案 A）。脱敏边界正确分层：governance §9「Promo/Source raw payload 可能包含真实码或 URL，按 S2 处理，**不进入审计和 Notion**」；§9「Audit JSON 只能保存脱敏后的 before/after、request summary、response shape」；`SideEffectIntent` 只有 `request_summary` / `response_shape` 两个 jsonb，**无原始响应体字段**。审计侧无法承接真实码 |

---

## 8. 依赖申请评审

```text
DEPENDENCY_REQUEST=APPROVED
```

`docs/p1/P1_05_DEPENDENCY_CHANGE_REQUEST.md` 申请**仅两项**，与要求完全一致：

| package | section | version | 结论 |
| --- | --- | --- | --- |
| `@prisma/client` | `dependencies` | `6.19.2` | ✅ 精确版本，无 `^` |
| `prisma` | `devDependencies` | `6.19.2` | ✅ 精确版本，无 `^` |

- 无夹带：未申请 `pg`、`@prisma/adapter-pg` 或任何其他依赖；
- 版本依据充分：与 CPS 只读参考工作区已锁定版本一致，与 `engines.node >=20.9.0` 兼容，不要求改 tsconfig/Next 配置；
- 边界清楚：Codex 本轮**未修改** `package.json` / `package-lock.json`（已核实本 commit diff 不含这两个文件）。

**合并安排**：我作为根配置 custodian **本轮不合并**。依据评审规则，依赖在**领域评审 PASS 后**单独合并；当前结论为 REVISE，故合并推迟到复评通过。合并时使用 `--save-exact`，合并后仅允许运行 `prisma validate`。

---

## 9. Migration 授权

```text
MIGRATION_GATE=CLOSED
```

**不允许**进入 P1-05B Migration 阶段。放行条件：

1. R-01 ~ R-04 四项（阻断级）完成修订；
2. R-05 ~ R-10 六项完成修订或由 Owner 明确豁免并记录理由；
3. 修订后 Schema / `database-statuses.ts` / `database-invariants.ts` / governance / 字典**四处同步**（governance §10 已自行规定「先同步领域真源、Schema 草案和字典，再设计 Migration」）；
4. 重新提交本评审，取得 `RESULT=P1_05A_DOMAIN_REVIEW_PASS`。

修订期间 `prisma/schema.prisma` 顶部的「No migration may be generated from this file until Claude records a PASS」注释**必须保留**。

---

## 10. 复评时我会重点复查

1. R-01 的落地方式——是写事务约定、触发器，还是 provenance 列？三者取舍会影响 P1-07 Worker 同步逻辑的实现形状，需要在修订说明中讲清楚；
2. R-02 修订后，`article.body` 与 `novel_chapter_content.body` 的 `business_meaning` 是否真正区分开（而非再次复制）；
3. R-06 选了①还是②，以及 governance §5 是否同步登记；
4. 24 处 `status` 术语表是否覆盖全部枚举值，而非只补 `novel_chapter` 一处；
5. port-registry 条目的 `source_lines` 是否与 `P1_05_CPS_SCHEMA_EVIDENCE.md` 已记录行号一致。

---

## 11. 评审元信息

| 项 | 值 |
| --- | --- |
| CPS 只读参考 | `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux` |
| CPS_STATUS_BEFORE | 0 行 |
| CPS_STATUS_AFTER | 0 行 |
| CPS_HEAD | `d77c3b968285698529cf97c7f0f97b286d7a2a9c`（评审前后一致） |
| 本轮新增文件 | 仅本文件 |
| 本轮修改 Codex 文件 | **无** |
| Migration / db push / 数据库连接 | **无** |
