# P1-05A Schema Review Package

**Reviewer：Claude**

**Review status：PENDING**

**Migration gate：CLOSED UNTIL CLAUDE PASS**

## 1. 评审输入

- `prisma/schema.prisma`：37-table PostgreSQL review draft。
- `src/domain/database-statuses.ts`：状态值单一草案真源。
- `src/domain/database-invariants.ts`：数据库无关不变量。
- `docs/governance/database-governance.md`：物理约束、权限、保留和漂移设计。
- `docs/governance/database-schema-dictionary.jsonl`：表、字段与约束机器基线。
- `docs/p1/P1_05_CPS_SCHEMA_EVIDENCE.md`：CPS 实读证据。

当前没有 `prisma/migrations`，没有启动或连接 PostgreSQL，没有 Prisma Client 生成物。

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

草案：一个来源语种版本对应一个 Novel；SourceItem 在 `pending` 时可无 Novel，linked 后指向一个 Novel。V1 不自动跨语种合并。

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

草案：SourceItem `source_locale` 可空并允许 unknown；Novel/Article locale 非空。前台只读 published Article、非 unpublished/takedown Novel 和 preview Chapter；详情查询不带正文。

- [ ] PASS
- [ ] CHANGE REQUIRED：

### E. PromoLink 确定选链

草案：Article 通过 `promo_link_id` 显式确定公开 CTA；不按创建时间、账户顺序或“第一条 active”猜选。草稿可空，published 必须非空。

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
