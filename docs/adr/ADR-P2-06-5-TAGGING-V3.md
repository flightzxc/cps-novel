# ADR-P2-06.5 · Canonical Tagging V3

```text
ADR_ID                         = P2-06.5-TAGGING-V3
DECISION_STATUS                = ACCEPTED
CURRENT_ADR_STATUS             = AUTHORITATIVE_V3
DECISION_DATE                  = 2026-08-16
BASELINE                       = main c5bf508
CANONICAL_TAG_V1_COUNT         = 123
CANONICAL_TAG_V1_SHA256        = 8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad
B2_STATUS                      = FINAL
B2_MAPPING_KEYS                = 285
B2_APPROVED_MAPPING_GROUPS     = 194
B2_APPROVED_MAPPING_EDGES      = 196
C1_PARAMETER_STATUS            = FROZEN
C1_FINAL_RUN_ID                = 2026-08-17-owner-final-c1-final
TEXT_PARAMETERS                = title=30; description=30; threshold=30; maxTextTags=3
KEYWORD_ELIGIBILITY_VERSION    = keyword-eligibility-v2
KEYWORD_ELIGIBILITY_SHA256     = e796ba1ed79b344f790a70853d2e9773d6265e307615b2a60da28b90a6164854
AUTO_WRITE_AUTHORIZED          = NO
PRODUCTION_IMPLEMENTATION_AUTHORIZED = YES
PRODUCTION_IMPLEMENTATION_STATUS     = COMPLETE
```

本 ADR 是 P2-06.5 Tagging 的唯一权威工程合同。旧
`docs/p2/P2_06_5_ADR_TAGGING.md` 已被本文件 supersede；与本文件冲突的旧短路、locale Tag
identity、mapping FK 或 auto 生命周期描述全部失效。

## 2026-09-05 Owner amendment · public category projection

Owner 将 CanonicalTag 的公开只读投影纳入首发范围，supersede 原决定 10 中“不是本期 public
SEO contract”的时间范围，不改变其余 Tagging V3 语义。`/categories` 复用 CanonicalTag 管理；
公开 `/category/[slug]`、`/browse?category=`、首页/页脚入口与 category sitemap 只消费 active
CanonicalTag，并按 `sortOrder, stableId` 排序。有效分类仍是 manual FULL_SNAPSHOT 或 automatic
mode 下的 mapped read-derived 结果；公开路径不物化 mapped、不执行任何 auto write。空分类 404
且不进 sitemap。`AUTO_WRITE_AUTHORIZED=NO` 保持冻结。

## 1. Context

P2-05 已将供应商原始标签保存为 `SourceLabel` 与 `NovelSourceItemLabel`，P2-06 已提供原始标签
只读后台面。P2-06.5 的 taxonomy、真实 Changdu 采样、B2 exact mapping 和 C1 calibration
evidence 已完成或接近冻结，本阶段不重新研究 taxonomy、B1/B2 或 classifier 产品原则，而是把
结论固定为可以施工的 schema、service、worker 与 Admin 合同。

权威输入：

- CanonicalTag v1 Final：123 项；SHA-256
  `8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad`。
- Changdu B2 Final：285 exact keys；`MAP=194`、`DEFER=52`、`IGNORE_DROP=37`、`GAP=2`、
  `OWNER_QUEUE=0`。由于两个 1:N 决策，runtime 批准 edge 共 196 条。
- C1 v2：10,000 unique novels、9 configurations、17,932 mapped edges；输入 SHA-256
  `046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d`。
- C1 的 `titleWeight`、`descriptionWeight`、`threshold`、`maxTextTags` 仍等待 Owner freeze；
  参数选择不得改变 schema 或 service 形态。
- 当前 `AUTO_WRITE_AUTHORIZED=NO`。允许实现、测试、fixture 与 dry-run，不允许生产 auto 写入。

权威 artifact：

- [CanonicalTag v1 Final](../p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json)
  及其 [manifest](../p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/CANONICAL_TAG_V1_MANIFEST.json)；
- [B2 Final manifest](../p2/p2-06-5-lane-b/b2-owner-final/2026-08-16/B2_FINAL_MANIFEST.json)
  及 [mapping candidates](../p2/p2-06-5-lane-b/b2-owner-final/2026-08-16/mapping-candidates-final.csv)；
- [C1 v2 manifest](../p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v2/C1_MANIFEST.json)
  及 [production keyword input](../../artifacts/p2-06-5-lane-c/2026-08-16-owner-final-c1-v2/taxonomy-keywords.json)。

## 2. Final Decisions

1. `CanonicalTag` 是平台级、locale-independent 的标准找书入口；翻译、aliases、keywords 挂在
   同一个 identity 下。V1 taxonomy 是 flat list，不建设 hierarchy、ontology 或 facet engine。
2. 有 manual mode 时，manual 是 FULL_SNAPSHOT，`effective = manual`，包括显式空集合。
3. 无 manual mode 时，`effective = mappedSourceTags ∪ qualifiedAutoTextTags`。mapped 是 hard
   evidence，不参与 text threshold，也不受 `maxTextTags` 截断。
4. mapped 永远 read-derived，不写入 per-novel `NovelCanonicalTag`。
5. mapping identity 精确为 `channel_app_id + raw_language_scope + raw_token`；一个 key 可有多个
   approved target edge。Unknown token fail closed。
6. `NovelCanonicalTag` 只保存 manual/auto snapshot；auto 的生成方法由 classification run 表达。
7. deterministic classifier 只读取 title 与 description；不读取 source language、recommend、
   agency、slug、运营元数据或章节。
8. auto 生命周期只有新 Novel 初始化和显式 backfill/reclassification；不增加周期性全库扫描。
9. `channel × locale × source identity` 严格隔离。不能按标题、时间或现实作品概念跨实体合并。
10. Tag 不属于 publish hard gate，也不是本期 public SEO contract。

## 3. Superseded Decisions

以下旧决定明确废弃：

- `manual > mapped > auto > 0` 按层短路；V3 改为 manual mode 与 automatic union 两种模式。
- mapped 非空即屏蔽 auto；V3 中 mapped 与 qualified auto 在 automatic mode 下并集。
- 通过“存在 manual row”判断 manual ownership；V3 使用显式 `NovelTagState.mode`。
- 拒绝空 manual snapshot；V3 允许空 FULL_SNAPSHOT 且不回退。
- `CanonicalTag.locale` 与 `(locale, slug)` identity；V3 stable ID/slug 均为全局 identity。
- `SourceLabelMapping.sourceLabelId` 作为 mapping identity；现有 `SourceLabel` 缺少 raw-language
  scope，不能表达 B2 exact identity。
- `NovelCanonicalTag.source` 包含 `mapped` 或允许 mapped 物化。
- auto 只在 manual/mapped 都无结果时写入；V3 auto 可补充 mapped 未覆盖的文本语义。
- 禁止 Worker task；V3 复用 GenericTask 承载显式初始化与 backfill，但仍禁止 scheduler。
- 将当前 C1 候选数值散布在服务、Worker 或测试中。

## 4. Data Model

正式实现使用一个 additive Prisma migration。migration 只创建结构、约束、索引和 nullable
字段，不写 taxonomy、mapping 或存量 Novel 数据。

### 4.1 Canonical taxonomy

`CanonicalTag`：

| 字段 | 合同 |
| --- | --- |
| `id` | UUID PK，内部引用 |
| `stableId` | `ct-v1-*`，全局唯一、bootstrap 后不可修改 |
| `slug` | 全局唯一、bootstrap 后不可修改 |
| `canonicalDefinition` | taxonomy authority 中的 definition |
| `aliases` | JSONB string array，按权威 artifact 原样保存，不作 runtime normalization |
| `facet` | 仅治理/分析信息，不驱动复杂分面模型 |
| `status` | `active \| inactive`，用命名 CHECK 保护 |
| `sortOrder` | 从 authority 的稳定顺序导入 |
| `taxonomyVersion` | 首版 `1.0.0` |
| timestamps | `timestamptz(6)` |

`CanonicalTagTranslation` 使用 UUID PK，`canonicalTagId` FK、`locale`、`displayName` 和时间戳；
命名唯一约束为 `(canonical_tag_id, locale)`。一个 Tag 不因多语言展示产生多个 identity。

`CanonicalTagKeyword` 使用 authority keyword ID 作为稳定唯一键，并保存 `canonicalTagId`、原始
`value`、`scriptBuckets` JSONB、`matchMode`、`riskFlags` JSONB、`active`、`lexiconVersion` 和
时间戳。V1 不保存或消费 source-language classifier feature。

Alias collision 无法由 JSONB UNIQUE 完整表达，由 bootstrap 与 Admin mutation service 在事务内
验证，并由测试锁定；不允许为解决 collision 在写前改变 alias 字符串。

### 4.2 Exact source mapping

`SourceLabelMapping` 每行是一条 approved edge：

| 字段 | 合同 |
| --- | --- |
| `id` | UUID PK |
| `channelAppId` | FK `ChannelApp`，不得由 logical name 猜测 |
| `rawLanguageScope` | exact `RAW_LANGUAGE_SCOPE_V1` 字符串，PostgreSQL `COLLATE "C"` |
| `rawToken` | exact supplier token，PostgreSQL `COLLATE "C"` |
| `canonicalTagId` | FK `CanonicalTag` |
| `mappingVersion` | B2 artifact/version 标识 |
| `active` | 撤销时 false；inactive edge 不参与读取 |
| `approvedBy/approvedAt` | Admin identity 与批准时间 |
| timestamps | 创建与更新时间 |

唯一 edge 为 `(channel_app_id, raw_language_scope, raw_token, canonical_tag_id)`。同一前三元可以
有多个 target，从而表达 1:N；没有 active edge 就是 fail closed。V1 只消费
`SourceLabel.labelKind = series_type`，不把 label kind 增加为 B2 identity 维度。

`rawLanguageScope` 使用 Lane B 已验收的格式：

```text
["RAW_LANGUAGE_SCOPE_V1", rawJsonIdentity(language), nameIdentity]
```

其中 JSON type/value、字段 missing、显式 null 与 exact string 必须可区分。生成函数不得 trim、
case-fold、NFC/NFKC normalize、翻译或以 `sourceLanguageCode` 替代 raw payload。

`NovelSourceItem` 新增 nullable `rawLanguageScope`。新同步写入 exact scope；历史行只通过显式
dry-run-first 工具从 `rawPayload` 派生。无法可靠派生时保持 NULL 并列入报告，禁止猜测或重写
`SourceLabel` facts。

### 4.3 Novel snapshot state

`NovelTagState`：

- `novelId` 为 PK/FK；
- `mode = automatic | manual`；
- `revision` 为非负 bigint optimistic-concurrency version；
- `currentAutoRunId` nullable，指向当前 auto snapshot 的 run；
- timestamps。

没有 state row 的存量 Novel 在读取上等价于 `automatic`、revision 0、无 auto run。所有写路径先
确保 state row 存在并锁定。`mode=manual` 即表示 FULL_SNAPSHOT ownership，即使没有 manual row。

`NovelCanonicalTag`：

- `source = manual | auto`，数据库 CHECK 明确拒绝 `mapped`；
- 唯一 `(novel_id, canonical_tag_id, source)`；
- manual 行：`score/runId` 必须为 NULL，`decidedBy` 必填；
- auto 行：`classificationRunId` 必填，score/evidence 按版本化合同保存；
- evidence 必须为 JSON object，并带 schema version。

`TagClassificationRun` 保存 novel、`deterministic_text | offline_llm` method、taxonomy
version/SHA、keyword lexicon version/fingerprint、classifier config version/fingerprint、content
SHA、task/request metadata、版本化 result summary、created/applied timestamps。即使结果为 0 Tag，
也创建 run 并由 `NovelTagState.currentAutoRunId` 指向它；旧 snapshot 的详细结果保留在 run/audit，
当前 `NovelCanonicalTag(source=auto)` 始终只代表最新 snapshot。

## 5. Effective Tag Semantics

权威 resolver：

```text
resolveEffectiveTags(novelId, requestedLocale):
  novel = require live Novel
  state = NovelTagState or { mode: automatic, revision: 0, currentAutoRunId: null }

  if state.mode == manual:
    manual = current active manual rows joined to active CanonicalTag
    return stableSort(manual with provenance=[manual])

  source = resolve zero-or-one NovelSourceItem(status=linked, deletedAt=null)
  if more than one source:
    fail DATA_INVARIANT_VIOLATION
  if source exists and scope/locale/channel identity is incomplete or inconsistent:
    fail DATA_INVARIANT_VIOLATION

  mapped = exactJoin(
    active NovelSourceItemLabel,
    SourceLabel(kind=series_type, same channelAppId),
    active SourceLabelMapping(same channelAppId, exact scope, exact token),
    active CanonicalTag
  )

  auto = active NovelCanonicalTag(source=auto,
                                  runId=state.currentAutoRunId)
         joined to active CanonicalTag

  return stableSort(uniqueByTag(mapped union auto), retaining all provenance)
```

其中 raw token 的 SQL join 必须显式使用
`source_label.external_label_value COLLATE "C" = source_label_mapping.raw_token`。零 source binding
产生空 mapped 集合，不伪造来源；一个以上 active binding 或一个已绑定实体的
scope/locale 不完整则是数据不变量错误。inactive/deleted source relation、inactive mapping、
inactive CanonicalTag 均不返回。排序固定为 `sortOrder ASC, stableId ASC`。若 mapped 与 auto 命中
同一 Tag，结果只出现一次，但 `provenance=[mapped, auto]`。

Admin/read DTO：

```ts
type EffectiveTagProvenance = "manual" | "mapped" | "auto";

type ResolvedCanonicalTag = {
  stableId: string;
  slug: string;
  displayName: string;
  provenance: EffectiveTagProvenance[];
};
```

display name 按 `requested locale -> zh -> slug` 回退。该 DTO 是内部/Admin 合同，不授权公开 SEO
或路由使用。

## 6. Manual FULL_SNAPSHOT

Admin endpoint 保持现有 registry 可匹配的扁平路径：

- `GET /api/admin/novels/tags?novelId=...` 返回 `mode`、`revision`、effective 与
  manual/mapped/auto 分层投影。
- `PUT /api/admin/novels/tags` 接受：
  - `replace_manual`：`novelId, requestId, expectedRevision, canonicalTagIds`；数组允许为空；
  - `exit_manual`：`novelId, requestId, expectedRevision`。

`replace_manual` 将所选集合视为完整最终结果，不是增量追加。服务拒绝不存在或 inactive Tag，
对 ID 排序去重后计算 payload hash；在事务中按 request ID 获取 transaction advisory lock，查找
同 entity/action/request 的历史 `OperationAudit`，再锁定 `NovelTagState`、校验 revision、替换全部
manual rows、设 `mode=manual`、revision +1，并写 before/after audit。同 request 与同 payload 重试
返回先前结果；相同 request 配不同 payload 或过期 revision 返回 conflict。

`exit_manual` 删除 manual rows、设 `mode=automatic`、revision +1 并审计。它只显露已存在的
mapped/auto 结果，不隐式运行 classifier。manual 写入不删除 auto；auto writer 遇到 manual mode
必须 skip，不能覆盖或等待后再覆盖。

## 7. Source Hard Mapping

Resolver 只消费 approved、active exact edge。写服务接收原始 scope/token 并原样保存；仅可检查
类型、长度和“是否完全为空”，不得把检查后的值作为新 identity。映射批准、换 target、停用均与
`OperationAudit` 同事务，保留 before/after、request ID、actor、mapping version。

B2 bootstrap 验证全部 285 decision keys，但 runtime 只导入 194 MAP groups/196 approved edges。
DEFER、IGNORE_DROP、GAP 不生成 inactive 或猜测 edge；其权威记录仍是 B2 artifact。

## 8. Auto Text Classifier

实现必须适配 Lane C 已验收 pure core：

- strong：`Novel.title`；weak：`Novel.description`；description 缺失按空文本处理。
- Latin：Unicode-aware whole-word，边界以 Unicode letter/number/mark/underscore 定义。
- CJK：contiguous exact keyword，keyword 至少两个 Unicode code point。
- rule keyword 不额外 tokenize。
- 每个字段按 Lane C 既有规则最多贡献一次；最终按 score 降序、text selection priority、stable ID
  排序后应用 threshold 与 `maxTextTags`。
- 禁止 `recommend`、language、agency、source language、slug、商业/运营元数据、章节。
- 禁止 nodejieba、TF-IDF、embedding、online LLM 或新 NLP runtime dependency。

唯一 production config 包含：

```ts
type ClassifierConfig = {
  status: "OWNER_REVIEW_PENDING" | "FROZEN";
  version: string;
  titleWeight: number | null;
  descriptionWeight: number | null;
  threshold: number | null;
  maxTextTags: number | null;
  fingerprint: string | null;
};
```

Owner Final 已冻结 production config 为 `30 / 30 / 30 / 3`，production loader 直接消费
`classifier-config-final.json` 并验证 taxonomy 与 `keyword-eligibility-v2` authority。任何 artifact
状态、版本或 SHA 不一致仍 fail closed 为 `CONFIG_NOT_READY`；`AUTO_WRITE_AUTHORIZED=NO` 是独立写闸。
Worker、service、CLI 和测试不得各自保存候选 production 数值。

## 9. Lifecycle

`initializeNovelTagSnapshot(novelId)` 是新 Novel 首次分类服务契约。当前仓库没有 Novel 创建/绑定
production caller，因此首版只提供服务和显式任务；未来创建/绑定入口落地时必须登记并调用它，
本期不新建绑定流程。

复用 `GenericTask` 增加显式 tag backfill task：

- `initialize_missing`：仅处理 automatic mode 且 `currentAutoRunId IS NULL` 的 Novel；
- `reclassify_existing`：显式替换现有 auto snapshot；
- 每 Novel 一个 task item，继承现有 claim/lease/fencing/at-least-once 语义；
- item 写入前重新检查 mode、entity identity、content SHA、config 和 write gates；
- dry-run 为默认；apply 必须显式限定 `--novel-id`、`--locale` 或字面量 `--all`；
- 不注册任何 scheduler schedule，不因 taxonomy/keyword/content 修改自动扫库存。

auto snapshot replace 在一个事务中锁 state，拒绝 manual mode或 stale content，创建 run，删除当前
auto rows，插入新集合，更新 `currentAutoRunId`，写 OperationAudit。空集合也完成 run。重复 task item
由 fencing 与 run/request identity 返回幂等结果。

## 10. Entity Isolation

以下实体不得合并或互相继承 Tag：Changdu EN、Changdu ES、Beidou EN，即使标题或现实作品相同。
service、resolver、backfill 必须同时验证 channel app、Novel locale、source locale、source identity 和
raw-language scope。不得 cross-source union、cross-locale vote、按 `lastSeenAt` 选源或标题匹配。
任何多绑定/错绑定是 `DATA_INVARIANT_VIOLATION`，而不是 warning 后继续。

## 11. Write Gates

正式实现登记三个开关：

| Gate | 默认 | 语义 |
| --- | --- | --- |
| `FEATURE_P2_06_5_TAGGING` | `false` | master read/admin exposure，按既有 exact `"true"` 解析 |
| `FEATURE_P2_06_5_TAG_ADMIN_WRITE` | `false` | 允许 taxonomy/mapping/manual Admin mutation，按 exact `"true"` 解析 |
| `FEATURE_NOVEL_TAG_AUTO` | `false` | 允许 resolver 读取 auto layer，并允许 auto task enqueue，按 exact `"true"` 解析 |
| `AUTO_WRITE_AUTHORIZED` | `NO` | 生产 auto writer 最终 Owner Gate，只接受 exact `"YES"` |

auto apply 必须 master、auto 与 Owner gate 同时开放；任何 CLI/Admin/Worker 均不得绕过。auto flag
关闭时 manual/mapped 语义保持可用，已有 auto rows 保留但不进入 resolver。dry-run 可在 master feature
开启后读数据和生成计划，但不得产生 Tag business write。manual/mapping Admin mutation 另受注册的
`tag:manage` capability、2FA 与 `FEATURE_P2_06_5_TAG_ADMIN_WRITE` 保护。

## 12. Migration and Bootstrap Strategy

唯一裁决：**schema migration + explicit bootstrap CLI**。

1. migration additive-first：新表、nullable scope、FK、named CHECK/index、grants；无 seed/data rewrite。
2. 部署代码且所有 feature/write gate 关闭。
3. bootstrap dry-run 验证 taxonomy count/SHA、B2 285/194/196 与 C1 input SHA；要求 operator 显式
   提供 `changdu-app -> ChannelApp UUID`，不得按名字或唯一候选猜测。
4. 经发布授权后，幂等 upsert 123 tags、translations、aliases、keywords 与 196 edges；每个 apply
   写 audit。
5. raw scope backfill 使用独立 dry-run/apply；只派生可证明的 scope，异常留 NULL 并阻断对应
   mapping read。
6. 校验计数、hash、exact edge、scope 异常与 audit 后才启用 read/admin。
7. C1 参数 freeze 且 Owner 将 `AUTO_WRITE_AUTHORIZED=YES` 后，才可 scoped auto apply。

不得 `db push`、不得在 migration 内运行 classifier、外部 API 或库存 backfill，也不得将 123 tags
和 B2 mappings 硬编码进 migration SQL。回滚优先关闭 flags/停用 edge/tag；不在本期设计 destructive
down migration。

## 13. Admin Behavior

现有 `/tags` 保留为“来源标签”只读页。新增：

- `/canonical-tags`：list/search、definition、active status、translations、aliases、keywords；V1 不
  编辑 stable ID/slug。
- `/tag-mappings`：按 channel/scope/token/tag/active 检索，批准 1:N edge、停用和查看 audit；UI
  必须展示 exact 空格/大小写，不能把 visually-similar token 合并。
- `/novels/[novelId]` Tag 区：展示 effective 及 mapped/auto provenance；manual editor 明示
  “手动接管后，所选集合就是完整最终集合”，保存空集合需二次确认，并提供 exit/reset。

新增 `tag:manage` capability，默认仅 `super_admin`，`requiresTwoFactor=true`。读面可复用
`content:view`；所有 mutation 必须走 registry、统一 guard、service 和 audit，不从 UI 直接操作 DB。

## 14. Audit and Provenance

复用 `OperationAudit`，不创建第二审计系统。以下动作与业务写同事务：manual replace/exit、mapping
approve/deactivate、taxonomy display/status/keyword mutation、bootstrap apply、scope backfill apply、auto
snapshot replace。audit 至少保存 actor/action/entity/request/task/reason、payload fingerprint、revision、
before/after 和 authority/config versions；不得记录版权正文或敏感上游 payload。

`NovelCanonicalTag.source` 只表达 manual/auto layer；具体 auto 方法、输入 hash 与参数由
`TagClassificationRun` 表达。mapped provenance 由当前 exact join 生成，不伪造 per-novel run。

## 15. Offline LLM Future Extension

这是不阻塞 V1 的 extension seam，不在本轮实现。未来方向：

```text
low-confidence/no-mapping entity
  -> pending enrichment task
  -> operator export JSON
  -> external model
  -> strict import validator
  -> GenericTask/Worker
  -> replace current auto snapshot
```

export/import contract 至少锁定 `task_id`、`entity_id`、`taxonomy_version`、`taxonomy_sha256`、
`content_sha256`、`exported_at`。taxonomy/content 不匹配必须返回 `STALE_EXPORT`；import 不能 direct
DB update。LLM 结果仍为 `source=auto`、`method=offline_llm`，替换而非 append auto snapshot，不影响
read-derived mapped 或 manual FULL_SNAPSHOT。

未来小说 export 可包含 title、description、前三章；章节证据只允许进入 offline experiment，不能
进入实时 deterministic classifier。当前 `CHAPTER_EVIDENCE_STATUS=DEFER`、`C2_SAMPLE_REQUEST=NONE`。

## 16. Rejected Alternatives

- locale-specific Tag IDs：破坏跨语言标准入口。
- mapped physical rows：形成第二真源并要求全库刷新/清理。
- manual 增量追加：无法表达运营的完整最终集合。
- “有 manual row 才接管”：无法表达显式空 snapshot。
- runtime fuzzy/synonym/translation/LLM mapping：违反 exact evidence 与 fail-closed。
- source metadata classifier：复现 CPS noisy-metadata 缺陷。
- periodic reclassification：扩大写面且没有业务授权。
- migration seed/backfill：把数据授权和 schema 发布错误绑定。
- public Tag SEO/facet/hierarchy：超出 P2-06.5 V1。
- 直接移植 CPS SQLite Tag/DramaTag、nodejieba、fallback tag 或 15-tag cap：数据与产品模型不兼容。

## 17. Test Invariants

实现至少覆盖：

- taxonomy stable ID/slug/translation uniqueness、alias collision、inactive behavior、authority SHA；
- mapping 空格、大小写、Unicode、scope 精确差异，1:N、unknown fail closed、inactive edge/tag；
- mapped only、auto only、union/dedupe、manual takeover、manual empty、exit manual；
- channel/locale/source isolation、多绑定与缺 scope invariant；
- title/description matcher、threshold、maxTextTags、稳定排序、空 auto snapshot、幂等；
- revision conflict、request replay、manual/auto race、worker fencing/rollback；
- dry-run、scoped backfill、explicit all、write gate、manual skip；
- 禁止 noisy metadata、未批准 SourceLabel、scheduler/full-stock scan、auto 覆盖 manual；
- publish gate、sitemap、IndexNow、public SEO contract 零变化。

## 18. Rollout Gates

| Gate | 准入证据 |
| --- | --- |
| G0 ADR | Owner 接受本 ADR；旧 ADR 仅保留 superseded stub |
| G1 Schema | additive migration、grants、dictionary、空库/重放/rollback 验证通过 |
| G2 Deploy dark | code 部署，所有 Tag flags 关闭 |
| G3 Bootstrap dry-run | 123/hash、285/194/196、channel binding、scope 异常报告通过 |
| G4 Bootstrap apply | 明确发布授权、幂等 apply、audit 与计数复核通过 |
| G5 Read/Admin | master/admin gates 开启，resolver 与 Admin 监控无 invariant error |
| G6 Auto config | C1 参数 `FROZEN`，config fingerprint 归档 |
| G7 Auto writes | Owner 明确设置 `AUTO_WRITE_AUTHORIZED=YES`，仅 scoped task apply |

G0–G6 均不得隐式推进 G7。事故回滚顺序是关闭 auto/admin/master gate、停用错误 mapping/tag，保留
审计和 source facts；不得通过 destructive migration 回滚。

## 19. Non-goals

- 不重新调整 123 个 CanonicalTag 或重跑 B1/B2/C1。
- 不建立 taxonomy hierarchy、ontology、多维 facet engine。
- 不修改 SourceLabel facts，不物化 mapped per-novel rows。
- 不建立 Novel 创建/绑定新流程。
- 不实现 Offline LLM export/import、在线 LLM 或章节分类。
- 不增加 scheduler、nightly scan 或自动全库存重分类。
- 不修改 publish gate、公开阅读、SEO、sitemap、IndexNow 或 public Tag routing。

## Final Status

```text
P2_06_5_V3_ADR_STATUS=ACCEPTED
CANONICAL_TAG_V1_COUNT=123
CANONICAL_TAG_V1_SHA256=8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad
B2_STATUS=FINAL
B2_MAPPING_KEYS=285
C1_PARAMETER_STATUS=FROZEN
C1_DESCRIPTION_ONLY_BLIND_REVIEW=IN_PARALLEL
CHAPTER_EVIDENCE_STATUS=DEFER
OFFLINE_LLM_ENRICHMENT=FUTURE_EXTENSION_NON_BLOCKING
AUTO_WRITE_AUTHORIZED=NO
PRODUCTION_IMPLEMENTATION_PLAN_STATUS=READY
READY_TO_START_PRODUCTION_CODING=YES
BLOCKERS=NONE_FOR_CODING; AUTO_WRITES_REQUIRE_OWNER_GATE
```
