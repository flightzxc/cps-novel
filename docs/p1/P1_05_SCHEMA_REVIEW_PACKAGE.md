# P1-05A Schema Review Package

**Reviewer：Claude**

**Review status：PENDING REREVIEW AFTER 10/10 FINDINGS RESOLVED**

**Migration gate：CLOSED UNTIL CLAUDE PASS**

## 1. 评审输入

- `prisma/schema.prisma`：37-table PostgreSQL review draft。
- `src/domain/database-statuses.ts`：状态值单一草案真源。
- `src/domain/database-invariants.ts`：数据库无关不变量。
- `docs/governance/database-governance.md`：物理约束、权限、保留和漂移设计。
- `docs/governance/database-schema-dictionary.jsonl`：37 表、495 字段、269 约束/索引/事务契约，共 801 条机器基线。
- `docs/governance/port-registry.md`：CPS pattern-only/adapt/PG reimplementation 登记。
- `docs/p1/P1_05_CPS_SCHEMA_EVIDENCE.md`：CPS 实读证据。

当前没有 `prisma/migrations`，没有启动或连接 PostgreSQL，没有 Prisma Client 生成物。

## 2.1 P1-05A-REVISION 处置摘要

| Claude finding | 修订结果 | 评审证据 |
| --- | --- | --- |
| R-01 canonical 只补空 | RESOLVED | 选择写事务/条件 UPDATE 契约，不增加 provenance 表；普通同步只补空，运营清空后的重补必须显式授权 |
| R-02 Article body | RESOLVED | 冻结为模板渲染 SEO 正文、published 时 S0、`web_app` 可读，与章节版权正文的删除/保留/导出策略分离 |
| R-03 fingerprint prefix | RESOLVED | S1 内部非密文元数据，web/admin 可读，禁止 public 读取及反推完整 credential |
| R-04 IndexNow 幽灵 CHECK | RESOLVED | 删除 `indexnow_outbox_attempt_status_check`，只保留真实 `attempt_state` 字段/CHECK/索引 |
| R-05 published Article CHECK | RESOLVED | 登记 title、slug、body 非空白、promo_link_id 非空及 published_at 非空五条命名 Migration-only CHECK |
| R-06 Carousel serving | RESOLVED | 选择方案①：仅当前快照，删除 `valid_from/valid_to` 与区间索引，`(locale,position)` 绝对唯一，历史只进 change log |
| R-07 Article/PromoLink Novel | RESOLVED | Prisma 已验证可表达 `(promo_link_id,novel_id) → promo_link(id,novel_id)` 复合 FK，不依赖服务层猜测 |
| R-08 status 语义 | RESOLVED | 24 个 status 字段逐值术语化；明确 stale/withdrawn 以及 unpublished/takedown 的 HTTP/SEO 差异 |
| R-09 unknown locale | RESOLVED | SourceItem mapped locale 可空；Novel locale 只接受 canonical，无法映射不创建/不发布且不建立 DB 映射表 |
| R-10 port registry | RESOLVED | 按 CPS 精确文件/行号/baseline 登记 PATTERN_ONLY、ADAPT、PG_REIMPLEMENT，无 COPY |

RG-01 单项修复：恢复 `db:public:article:article_published_published_at_check`。非 published Article 可令 `published_at` 为空；进入 published 必须原子写入该时间。P1-05B 创建 Article→PromoLink 复合 FK 时必须使用 PostgreSQL 默认 `MATCH SIMPLE`，禁止 `MATCH FULL`，以允许草稿的 `promo_link_id = NULL`、`novel_id NOT NULL` 组合。

## 2. 表组与分类

| 组 | Models | 分类 |
| --- | --- | --- |
| 渠道与账户 | Channel、SourceApp、ChannelApp、ChannelCapability、ChannelAccount | CPS_PARITY / CPS_PARITY_ADAPTED |
| 凭证 | ChannelAccountCredential、ChannelCredentialActiveFingerprint、CredentialChangeLog | CPS_PARITY_ADAPTED / PATTERN_ONLY |
| 内容 | Novel、NovelSourceItem | CPS_PARITY_ADAPTED |
| 章节 | NovelChapterSourceItem、NovelChapter、NovelChapterContent、NovelPreviewPolicy | ORIGINAL_REQUIRED |
| 标签 | SourceLabel、NovelSourceItemLabel | ORIGINAL_REQUIRED |
| 推广/流量 | PromoLink、TrackingEvent | CPS_PARITY_ADAPTED / ORIGINAL_REQUIRED |
| 三类任务 | CatalogScan、ChannelSync、Generic Task/Item | ORIGINAL_REQUIRED / CPS_PARITY_ADAPTED |
| 审计 | SideEffectIntent、OperationAudit | ORIGINAL_REQUIRED |
| IndexNow | IndexNowOutbox、IndexNowOutboxAttempt | CPS_PARITY_ADAPTED |
| Scheduler | ScheduleRun、CronRun | ORIGINAL_REQUIRED |
| 发布 | ArticleTemplate、Article | CPS_PARITY_ADAPTED |
| 轮播 | 五张 HomeCarousel 表 | CPS_PARITY_ADAPTED |

DROP：Revenue P4 表、CanonicalTag/SourceLabelMapping、跨语言作品组、CPS 视频/剧集表、Drama switch、legacy credential、site_settings 明文凭证、北斗特定协议和 SQLite 伪锁。

## 3. 请 Claude 必须确认的七项

### A. Novel / NovelSourceItem 基数

草案：一个来源语种版本对应一个 Novel；SourceItem 在 `pending` 时可无 Novel，linked 后指向一个 Novel。V1 不自动跨语种合并。普通来源同步只能补 canonical 空值；非空值不覆盖，运营明确清空后的重补必须显式授权。

- [ ] PASS
- [ ] CHANGE REQUIRED：

### B. 章节三表责任

草案：SourceItem 保存上游章记录且不含正文；Chapter 保存站内章号/状态；Content 1:1 保存正文。可信非空列表缺席使 Chapter 立即 stale，正文保留；重新出现自动 preview；withdrawn 才删除 Content。

- [ ] PASS
- [ ] CHANGE REQUIRED：

### C. Article / Novel / Chapter 状态

草案：Article 采用 candidate 四态 `draft/published/unpublished/takedown`；Novel 五态；Chapter 四态。CPS 的 `pending/offline` 不直接移植，定时发布由 ScheduleRun/Task 表达。

- [ ] PASS
- [ ] CHANGE REQUIRED：

### D. Locale 与前台查询

草案：SourceItem 保存上游语种原值，mapped `source_locale` 可空；Novel/Article locale 必须是站点 canonical locale 且不得 unknown。无法映射时不创建/不发布 Novel，不在数据库建立第二套映射。前台只读 published Article、published Novel 和 preview Chapter；详情查询不带正文。

- [ ] PASS
- [ ] CHANGE REQUIRED：

### E. PromoLink 确定选链

草案：Article 通过 `promo_link_id` 显式确定公开 CTA；不按创建时间、账户顺序或“第一条 active”猜选。`PromoLink` 直接携带 `novel_id`，`Article(promo_link_id,novel_id)` 复合 FK 指向 `PromoLink(id,novel_id)`，数据库证明同 Novel。草稿可空，published 必须非空。

- [ ] PASS
- [ ] CHANGE REQUIRED：

### F. SEO 字段与索引

草案：Article 保存 locale、slug、public_page_short_id、seo_metadata、published_at；Novel/Chapter 状态参与可见性；活跃 locale+slug 使用部分唯一。URL 具体形状仍由 Claude URL 构造真源决定，数据库不自行拼 URL。

- [ ] PASS
- [ ] CHANGE REQUIRED：

### G. 字典语义与 LLM constraints

请抽查每组至少一张表，并确认 business meaning、sensitive/read/write roles 与不可由模型改写的业务语义。

- [ ] PASS
- [ ] CHANGE REQUIRED：

## 4. 数据库约束审阅清单

- [ ] Day 0 多 ChannelAccount，无 1:1 假设。
- [ ] public_redirect_code 是全局非部分 UNIQUE，软删仍占位，并计划不可变 trigger。
- [ ] 三类 Item 都有 execution_token + lease_epoch。
- [ ] CatalogScan active scope 是 account+app+project_type。
- [ ] pending claim 与 expired recovery 是两条查询/两套索引。
- [ ] credential fingerprint 由数据库 unique latch 兜底。
- [ ] IndexNow 幂等键是 `(url, revision)`。
- [ ] side_effect_intent 有永久 effect_key；operation_audit append-only。
- [ ] published Article 的 title/slug/body 非空白且 promo_link_id、published_at 非空由五条 Migration-only CHECK 登记。
- [ ] Article 与 PromoLink 的同 Novel 归属由 Prisma 可表达的复合 FK 保证。
- [ ] home_carousel_serving 仅保存当前快照，`(locale,position)` 绝对唯一且无有效期区间字段。
- [ ] Web/Scheduler 无凭证密文权限，Worker 是唯一解密面。
- [ ] ScheduleRun scheduled instant 和 CronRun→Task 关系满足原子 enqueue 设计。

## 5. 评审输出格式

Claude 应提交：

```text
RESULT=P1_05A_SCHEMA_REVIEW_PASS|REVISE
REVIEWER=CLAUDE
NOVEL_SOURCE_CARDINALITY=
CHAPTER_THREE_TABLES=
CONTENT_STATES=
LOCALE_AND_PUBLIC_READ=
PROMOLINK_SELECTION=
SEO_FIELDS_INDEXES=
DICTIONARY_SEMANTICS=
BLOCKING_CHANGES=
```

只有 `RESULT=P1_05A_SCHEMA_REVIEW_PASS` 且七项均无阻塞变更，Codex 才进入正式 Migration 阶段。
