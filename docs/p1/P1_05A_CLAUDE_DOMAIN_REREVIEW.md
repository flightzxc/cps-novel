# P1-05A 领域模型与数据字典 —— 增量复评

**任务：P1-05A-REREVIEW**

**复评人：Claude**

**分支：`feature/v0.1.0-p1-schema`**

**被复评 commit：`019aeb0a5cd9c72605b650f1941524df606e754f`**（Codex 修订）

**上一轮基线：`4b6aa8e40ec9c1b56cc1fee93ff82f98e8969f5b`**（Schema 草案）→ `df56b90`（Claude 领域评审）

**结论：`RESULT=P1_05A_DOMAIN_REREVIEW_REVISE`**

---

## 1. 复评范围与纪律声明

本轮只做**增量复评**：核对 Codex 对上一轮 10 项评审问题的修订结果，外加规定的回归检查。未重新审查 37-model 整体架构，未逐条重审 801 条字典，未展开 SOL R-01～R-24。

本轮 Claude 的写入仅有本文件一个。核对结果：

| 纪律项 | 状态 |
| --- | --- |
| 未修改 `prisma/schema.prisma` | ✅ |
| 未修改 `src/domain/**` | ✅ |
| 未修改 `docs/governance/**` | ✅ |
| 未修改 `package.json` / lockfile | ✅ |
| 未创建 Migration | ✅ `prisma/` 仍只有 `README.md` + `schema.prisma` |
| 未启动/连接数据库 | ✅ 无 `node_modules/.prisma`，无 Prisma Client 生成物 |
| CPS 参考仓库只读 | ✅ `git status --porcelain` = 0，HEAD = `d77c3b968285698529cf97c7f0f97b286d7a2a9c` |

### 1.1 被复评文件 SHA-256 前 16 位

| 文件 | SHA-256 前 16 |
| --- | --- |
| `prisma/schema.prisma` | `35130625e5a8498b` |
| `src/domain/database-invariants.ts` | `bc28f8474e6cf377` |
| `src/domain/database-statuses.ts` | `5c6645f0ebd0ff5c` |
| `docs/governance/database-governance.md` | `14fbc16656321c7b` |
| `docs/governance/database-schema-dictionary.jsonl` | `742102dd1e9763de` |
| `docs/governance/port-registry.md` | `eb4d1e6a07253a2a` |
| `docs/p1/P1_05_SCHEMA_REVIEW_PACKAGE.md` | `403ea092a87b501b` |

### 1.2 修订面

`019aeb0` 改动 7 个文件、+276 / −80 行。Schema 净新增标量列**只有一个**（`promo_link.novel_id`），其余为关系/唯一键/索引调整与两列删除。无新增 model，无无关扩张。

---

## 2. 总体判断

**上一轮 10 项评审问题全部解决（10/10）。修订本身引入 1 处真实回归，构成本轮唯一阻断项。**

10 项的修订质量整体高于要求：R-01 除 4 个字段外额外覆盖了 `author`；R-08 的 24 条 `status` 语义全部重写且互不重复；R-10 的 14 条 port-registry 行号我已逐条回到 CPS `d77c3b9` 核对，**14/14 精确命中所声称的 model**。

阻断项 RG-01 是「published Article 必须有 `published_at`」这条既有要求在替换 CHECK 记录时被整条删除，全仓无任何一处承接。修复量为 governance §5 第 11 条加一个 bullet + 字典加一条记录。

---

## 3. 十项逐条核对

### 3.1 canonical 只补空不覆盖 —— ✅ RESOLVED

三处一致，且三处措辞互相印证：

| 落点 | 证据 |
| --- | --- |
| governance | §6 第 1–2 条（`database-governance.md:162-163`）：登记 `db:public:novel:novel_canonical_fill_only_contract`，并明确**实现层选择**为「条件 UPDATE / 同事务行锁」，显式声明不增加 provenance 表 |
| dictionary `llm_constraints` | `db:public:novel:title` / `description` / `cover_url` / `slug` / `author` 五个字段均写入同一句约束；另新增 `record_kind=constraint` 的 `novel_canonical_fill_only_contract` 记录（`data_type: transaction_contract`） |
| `database-invariants.ts` | `canonicalFillOnly`（:3）、`canonicalRefillGate`（:4） |

上一轮 R-01 允许「写事务 / 触发器 / provenance 列」三选一，Codex 选了写事务并写清了理由与实现纪律，符合要求。`author` 是我原文只列 4 个字段之外的额外覆盖，正确——它同属运营可编辑的 canonical 字段。

### 3.2 published Article 四条必要条件 CHECK —— ✅ RESOLVED（但见 §5 RG-01）

governance §5 第 11 条拆为四条具名 Migration-only CHECK，字典四条 `record_kind=constraint` 记录一一对应：

| 约束 | 表达式 |
| --- | --- |
| `article_published_title_check` | `status <> 'published' OR btrim(title) <> ''` |
| `article_published_slug_check` | `status <> 'published' OR btrim(slug) <> ''` |
| `article_published_body_check` | `status <> 'published' OR btrim(body) <> ''` |
| `article_published_promo_link_check` | `status <> 'published' OR promo_link_id IS NOT NULL` |

三点核实：

1. `title` / `slug` / `body` 在 Schema 中均为 `NOT NULL`，故 `btrim(...) <> ''` 是**恰当**的强化——它挡的正是空字符串绕过，而不是重复 NOT NULL；
2. `public_page_short_id` 未单列 CHECK 是**正确的**：它在 Schema 中是 `String @unique`（`NOT NULL` + 全局唯一），CHECK 会是纯冗余；
3. `published_at` 的丢失见 §5 RG-01。

### 3.3 Article 与 PromoLink 同 Novel 的数据库可证明约束 —— ✅ RESOLVED

链路已从「两跳推导」压成「一跳直证」：

- `promo_link.novel_id` 新增为 `NOT NULL` 列 + `FK → novel.id ON DELETE RESTRICT`（`schema.prisma:376`）；
- `@@unique([id, novelId], map: "promo_link_id_novel_key")`（`schema.prisma:407`）提供被引用键；
- `Article.promoLink` 改为复合外键 `(promo_link_id, novel_id) → promo_link(id, novel_id)`，具名关系 `ArticlePromoLinkByNovel`（`schema.prisma:810`）；
- `database-invariants.ts:11` `articlePromoNovelMatch`；governance §5 第 12 条登记两个具名对象。

**独立验证**：我用 `prisma@6.19.2 validate` 对 schema 的一份 scratchpad 副本做了语法/关系校验（未安装依赖、未改 `package.json`/lockfile、未连接数据库、未在仓库内留下任何文件），结果 `The schema at prisma/schema.prisma is valid 🚀`。这条复合 FK 同时包含「可空 FK 列 + 非空共享列」和「`novel_id` 被两个关系共用」两个 Prisma 边界情况，实测均可表达——上一轮 §2.1 表中「Prisma 已验证可表达」的说法成立，不是纸面声明。

关于草稿 Article 的空值行为见 §6 建议 1（`MATCH SIMPLE` 纪律）。

### 3.4 `home_carousel_serving` 统一为当前服务结果 —— ✅ RESOLVED

选择了我给的方案①，且四处同步干净：

- Schema 删除 `valid_from` / `valid_to` 两列与 `carousel_serving_active_lookup_idx`，保留绝对 `@@unique([locale, position])`（`schema.prisma:910`）；
- 字典删除 `valid_from` / `valid_to` / `carousel_serving_active_lookup_idx` 三条记录，表级记录 `llm_constraints` 写明「不得恢复 `valid_from`/`valid_to` 区间职责」；
- governance §3.5 表行改为「只保存当前正在服务的结果，不承担历史区间」，DROP 列改为「在 serving 表内保存历史有效期」；§6（`:172`）补「更新 serving 必须同步追加 `home_carousel_change_log`，历史不写回 serving」；
- `database-invariants.ts:12` `carouselServingSnapshot`。

全仓 grep `valid_from` / `valid_to` / `carousel_serving_active_lookup_idx` 已零残留（除本文件与上一轮评审文件的引用）。`HomeCarouselChangeLog` 具备 `action` / `before_state` / `after_state` jsonb / `actor_*`，足以承接历史职责。

### 3.5 unknown locale —— ✅ RESOLVED

三层责任划清：

| 层 | 结论 | 证据 |
| --- | --- | --- |
| SourceItem 保留未知来源语种 | ✅ | `source_language_code`（NOT NULL）+ `source_language_name` 原值保留；`source_locale` 可空，`llm_constraints` 写明「映射不到时必须保留上游原值并令 `source_locale` 为 NULL/unknown 语义」 |
| `Novel.locale` 不得 unknown | ✅ | `business_meaning` 改为「站点 canonical locale；不得存 unknown，也不得直接复用未映射的上游语种值」；`llm_constraints` 明确「数据库不建立第二套语种映射逻辑」 |
| 映射失败不得猜测创建可发布 Novel | ✅ | governance §6（`:164`）+ §3.2 `novel_source_item` 行 DROP 列增列「数据库第二套 locale 映射」+ `database-invariants.ts:5` `canonicalLocale` |

### 3.6 `article.body` 字典 —— ✅ RESOLVED

上一轮两个独立错误（语义抄自章节正文、`web_app` 可写不可读）均已修：

| 项 | 修订后 |
| --- | --- |
| `business_meaning` | 「模板渲染后的 SEO 文章正文，面向匿名访客通过 `web_app` 公开展示；**不是**渠道版权试读正文，也不是 `NovelChapterContent.body`」 |
| `sensitive_level` | `S2_RESTRICTED` → `S0_PUBLIC_WHEN_PUBLISHED` |
| `read_roles` | 已含 `web_app` |
| `llm_constraints` | 新增「`NovelChapter withdrawn` 或章节正文删除不得删除 `Article.body`；公开读取通过 `web_app`，不授予匿名数据库直连权限」 |

governance 同步补了两处：§7 敏感字段表新增 `article.body` 行（`:183`），§8 保留策略新增「章节 `withdrawn` 不得级联删除 Article body」（`:195`）。原本逐字节相同的 `business_meaning` 现已在全字典唯一。

### 3.7 `fingerprint_prefix` —— ✅ RESOLVED

| 项 | 修订后 |
| --- | --- |
| 非密文 | ✅ `business_meaning` 改为「非密文、后台可展示的凭证指纹前缀内部元数据」 |
| 内部级别 | ✅ `S2_RESTRICTED` → `S1_INTERNAL`，与同表 `expires_at` 对齐 |
| admin/web 可读 | ✅ `read_roles: ["web_app","admin_app","worker_app","analyst_ro_masked"]` |
| public 不可读 | ✅ `llm_constraints` 明确「不允许 public 读取，也不得用于推导、拼接或恢复完整 fingerprint 或 credential」 |

governance §7（`:179`）同步改为「S1 / 后台 `web_app`/admin 可读元数据 / 不得反推出完整凭证」。`admin_app` 这个新角色名见 §6 建议 2。

### 3.8 幽灵约束 —— ✅ RESOLVED

- `indexnow_outbox_attempt_status_check` 记录已删除，全仓 grep 零命中；
- 该表现存 18 条记录中，与状态有关的只有字段 `attempt_state`（`enum_or_check` 为四值数组）与约束 `indexnow_outbox_attempt_attempt_state_check`（`attempt_state IN (...)`），**唯一且与 Schema 的 `attemptState` 列名一致**；
- port-registry「IndexNow outbox attempt」行的 `changed_what` 也记了「真实状态列冻结为 `attempt_state`，删除幽灵 `status` 约束」。

### 3.9 `status` 字段逐值语义 —— ✅ RESOLVED

24 个 `status` 字段全部重写，机器核验结果：

- **通用兜底残留 = 0**（无一条仍为「实体当前状态」）；
- **`business_meaning` 重复 = 0**（24 条两两不同）；
- Owner 点名的 10 类实体全部覆盖：Novel、Article、Chapter、PromoLink、Credential、Task（三类头 + 三类 Item）、SideEffectIntent、IndexNow、CronRun（含 ScheduleRun）、Carousel。

关键差异均已可查，且与 governance §4（`:126` 起）新增的冻结段互相印证：

| 差异 | 落地表述 |
| --- | --- |
| `stale` vs `withdrawn` | `stale`＝仅在**成功、结构完整、非空**的可信响应中缺席后立即停展/退出 sitemap，**正文保留**，可信重现**自动**恢复 `preview`；`withdrawn`＝人工/版权撤回并 404，是**唯一**通过版权流程删除 `NovelChapterContent` 的状态 |
| 不可信响应 | 「不可信响应不改变状态」已写进 `novel_chapter.status` 的 `business_meaning` 与 governance §4 |
| `unpublished` vs `takedown` | `unpublished`＝稳定 noindex 下架页、内容保留；`takedown`＝版权/安全移除、公开路由 **HTTP 410 Gone**、退出索引。Novel 与 Article 两处均写明，且 governance §4 明确「两者不得合并」 |

`src/domain/database-statuses.ts` 新增 `DATABASE_STATUS_SEMANTICS`（+131 行），与字典逐值对应，作为代码侧真源。

### 3.10 port-registry —— ✅ RESOLVED

14 条数据行，`port_kind` 分布：**ADAPT 9 / PG_REIMPLEMENT 3 / PATTERN_ONLY 2 / COPY 0**。表头上方明确声明「P1-05A 只登记从 CPS 提取的数据库**模式证据**；没有字节复制」——符合「不虚构字节复制」。

Owner 点名的六类全部在册：

| 要求类别 | 登记行 |
| --- | --- |
| Channel/Account 模式 | `Channel` / `ChannelApp` / `ChannelAccount` 三行（ADAPT） |
| Credential fingerprint | `Credential encrypted metadata`（ADAPT）+ `Credential fingerprint mutex latch`（PG_REIMPLEMENT） |
| SourceItem/canonical 分离 | `SourceItem/canonical separation`（PATTERN_ONLY） |
| PromoLink | `PromoLink independent asset`（ADAPT） |
| IndexNow outbox | `IndexNow outbox`（PG_REIMPLEMENT）+ `IndexNow outbox attempt`（ADAPT） |
| home_carousel | 五行（manual_slot / auto_batch / auto_candidate / serving / change_log） |

**行号独立核对**：我把 CPS `d77c3b9` 的 `prisma/schema.prisma`（1988 行）取出到 scratchpad，逐条解析 14 个 `source_lines` 区间，**14/14 精确落在所声称的 model 定义内**（每段都同时包含对应的 `model X {` 与 `@@map("...")`）。例：`1236-1258` → `model ChangduTotalRevenueActiveFingerprint`（fingerprint 互斥闩），`292-326` → `model DramaPromoLink`，`808-826` → `model HomeCarouselServing`。无一条行号虚构。

---

## 4. 回归检查

| 检查项 | 结果 |
| --- | --- |
| Schema model 数仍为 37 | ✅ 37 → 37，`grep '^model '` 输出逐行 `diff` 完全一致，无新增/改名 |
| 无无关扩张 | ✅ 净新增标量列仅 `promo_link.novel_id`；其余为 R-06/R-07 直接所需的关系、唯一键、索引与两列删除 |
| `public_redirect_code` 全局非部分 UNIQUE、不可复用 | ✅ `schema.prisma:383` `@unique(map: "promo_link_public_redirect_code_key")`，本轮未触碰；governance §5 第 10 条仍要求「全局非部分 UNIQUE + byte-wise/case-sensitive + 不可变 trigger + 软删行继续占位」 |
| `execution_token` + `lease_epoch` 仍存在 | ✅ 各 3 处（三类 Item 表），未减少；governance §5 第 16 条与 §6 fencing 条款保留，`database-invariants.ts` 另新增 `staleLeaseRejectsWrites` 强化 |
| `side_effect_intent` 与 `operation_audit` 仍分表 | ✅ `model SideEffectIntent`（:627）、`model OperationAudit`（:657）独立存在；governance §6 事务边界条款保留 |
| 零收益归因猜测 | ✅ 全 Schema + `src/domain/**` grep `revenue` / `GetReport` / `shareRatio` / `settle` 零命中 |
| 零北斗协议字段 | ✅ grep `beidou` / `北斗` 零命中 |
| 零 Migration | ✅ `prisma/` 仅 `README.md` + `schema.prisma` |
| 零数据库启动 | ✅ 无 `node_modules/.prisma`；`prisma validate` 在仓库外副本上执行且不建立连接 |
| `package.json` / lockfile 未变 | ✅ `4b6aa8e..019aeb0` 对这两个文件零改动；`prisma` / `@prisma/client` 仍未安装 |
| CPS 保持 clean | ✅ `porcelain` = 0，HEAD = `d77c3b9…2a9c`（复评前后各验一次） |

---

## 5. 唯一阻断项（本次修订直接引入的回归）

### RG-01 · published Article 的 `published_at` 必要条件被整条删除 🔴 阻断

| 项 | 内容 |
| --- | --- |
| table | `article` |
| field / constraint | `published_at`；缺失约束 `article_published_published_at_check` |
| stable_key | `db:public:article:published_at`；被删记录 `db:public:article:article_published_completeness_check` |
| 修订前定义 | governance §5 第 11 条：「published Article 必须具备 slug、public_page_short_id、promo_link_id、**published_at**」；字典 `article_published_completeness_check` 的 `enum_or_check` = `"published requires promo_link_id, public_page_short_id, slug, and published_at"` |
| 当前定义 | 该字典记录已删除，替换为四条 CHECK（title/slug/body/promo_link_id）。`published_at` 在 **governance 全文、801 条字典的全部 `llm_constraints`、`database-invariants.ts`** 中均零出现。`published_at` 在 Schema 中是 `DateTime?`（可空） |
| 应改定义 | ① governance §5 第 11 条补第五条 bullet：`db:public:article:article_published_published_at_check`: `status <> 'published' OR published_at IS NOT NULL`；② 字典补对应 `record_kind=constraint` 记录；③ `db:public:article:published_at` 的 `llm_constraints` 补一句「`status='published'` 时必须非空」 |
| 业务原因 | 这不是「我上一轮多写了一项」，而是**既有要求在替换过程中被静默丢弃**——Owner 本轮第 2 项只是列出四个必须登记的字段，并未要求删除 `published_at` 条件。后果是可实证的：`published_at` 可空且被 `article_status_published_idx` 索引，是 sitemap `<lastmod>` 与「最新」列表排序的唯一依据；PostgreSQL 的 `ORDER BY published_at DESC` **默认把 NULL 排在最前**，因此一条 `published_at IS NULL` 的 published Article 会稳定霸占所有「最新」榜首，同时 sitemap 缺 lastmod。P1-05A 这道闸门的全部意义就是在写 SQL 前把约束清单冻死；此刻补一行的成本，与 Migration 落地后再补一个 migration 的成本相差一个数量级 |

**除 RG-01 外，本轮未发现任何其他回归，也未把上一轮的建议项升级为阻断项。**

---

## 6. 建议项（非阻断，不影响 PASS）

1. **复合 FK 必须是 `MATCH SIMPLE`（PostgreSQL 默认），P1-05B 不得写 `MATCH FULL`。** `article.promo_link_id` 可空而 `article.novel_id` 非空；草稿 Article 的 `(NULL, novel_id)` 只有在 `MATCH SIMPLE` 下才被视为满足外键。若 Migration 手写时误加 `MATCH FULL`，所有草稿 Article 将无法插入。Prisma 生成的 DDL 默认正确，风险只在手改 SQL 时出现——建议在 governance §5 第 12 条末尾加一句显式提示。

2. **`admin_app` 是本轮新引入的角色名，全字典仅出现 1 次。** 其余角色词频为 `migration_owner` 1070 / `worker_app` 1043 / `web_app` 1026 / `analyst_ro` 784 / `scheduler_app` 319 / `analyst_ro_masked` 15。governance §7 的角色表头仍是 Web/Worker/Scheduler/Analyst 四列，无 admin 列。建议二选一：要么在 §7 增列并说明 `admin_app` 与 `web_app` 的权限差异，要么统一并回 `web_app`（Owner 修正 5 的表述是「Web 可展示凭证元数据」）。P1-06 建角色时这条会变成必须回答的问题。

3. **governance §3.3 `article` 行的摘要变薄。** 修订把「public ID 全局唯一；活跃 locale+slug 部分唯一」换成了「复合 FK…；published 行内 CHECK」。两项事实本身都还在（`public_page_short_id` 的 `@unique` 在 Schema，`article(locale, slug) WHERE deleted_at IS NULL` 在 §5 第 5 条），所以不是实质丢失；但 §3 表是人读入口，建议把四项并列而不是替换。

4. **`home_carousel_change_log` 无 `position` 列，也无 serving 行引用。** serving 历史只能落在 `before_state` / `after_state` 的 jsonb 里。R-06 的要求（历史归 change log）已满足，但「查某个 `(locale, position)` 的历史」将退化为 jsonb 检索。若 P2 首页轮播需要按位查历史，建议届时补 `position` 列而非在 jsonb 上建表达式索引。

5. 上一轮 §6 的 5 条建议（`source` 字段改名 / `content_hash` 行为契约 / `Article.body` 列表查询纪律 / sitemap 增量索引 / `GenericTask` 的 nullable 唯一键语义）本轮未处理，也不要求本轮处理，保持建议状态。

---

## 7. Migration 授权

**`MIGRATION_GATE=CLOSED`。**

`prisma/schema.prisma` 顶部的门禁注释（「No migration may be generated from this file until Claude records a PASS in `docs/p1/P1_05_SCHEMA_REVIEW_PACKAGE.md`」）本轮**必须继续保留**。

开闸条件：RG-01 一项修完并同步 governance + 字典（+ 建议 `published_at` 字段的 `llm_constraints`），即可复评开闸。RG-01 是本轮唯一阻断项，不附带其他前置条件。

**依赖申请：`DEPENDENCY_REQUEST=APPROVED`（`prisma` + `@prisma/client` 6.19.2，`--save-exact`）。** 合并动作仍按既定安排，由 Claude 作为根配置 custodian 在复评 PASS 后单独执行；本轮未改 `package.json` 与 lockfile。

---

## 8. 复评元信息

| 项 | 值 |
| --- | --- |
| 复评人 | Claude |
| 任务 | P1-05A-REREVIEW |
| 被复评 commit | `019aeb0a5cd9c72605b650f1941524df606e754f` |
| 上一轮评审 commit | `df56b90839690de28fb91f1a9c593daa3e321f38` |
| Schema 草案基线 | `4b6aa8e40ec9c1b56cc1fee93ff82f98e8969f5b` |
| 骨架基线 | `527a890` |
| CPS 只读基线 | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` |
| Schema models | 37 |
| 字典记录 | 801（797 + 10 新增 − 6 删除） |
| 上轮问题解决 | 10 / 10 |
| 本轮回归 | 1（RG-01） |
| 本轮新增文件 | `docs/p1/P1_05A_CLAUDE_DOMAIN_REREVIEW.md`（唯一） |
| 结论 | `RESULT=P1_05A_DOMAIN_REREVIEW_REVISE` |
