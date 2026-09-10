# P2-06.5 · V3 Production Implementation Plan

```text
PLAN_STATUS                         = AUTHORIZED
ADR                                = docs/adr/ADR-P2-06-5-TAGGING-V3.md
TARGET_WORKTREE                    = p2-06-main-merge
BASELINE                           = main c5bf508
P2_06_5_PRODUCTION_IMPLEMENTATION_SIZE = LARGE
MIGRATION_COUNT                    = 1
AUTO_WRITE_AUTHORIZED              = NO
PRODUCTION_IMPLEMENTATION_AUTHORIZED = YES
PRODUCTION_IMPLEMENTATION_STATUS     = IN_PROGRESS
```

V3 ADR 已获 Owner 接受，生产实现已授权并进入施工；生产 auto write gate 继续保持关闭。
生产施工必须保留当前工作树中的 Lane A/B/C evidence，不重新生成已冻结证据。

## 1. Delivery Definition

生产实现完成时应具备：

1. 全局 CanonicalTag、translations、keywords 与 exact source mapping 的 additive schema。
2. manual FULL_SNAPSHOT 与 automatic `mapped ∪ auto` 的单一 effective resolver。
3. Lane C deterministic classifier 的 production pure core 与唯一参数配置源。
4. 新 Novel 初始化服务契约和显式、可限域、dry-run-first 的 GenericTask backfill。
5. CanonicalTag、mapping、Novel manual tags 的最小 Admin V1。
6. audit/provenance、feature flags、write gate、bootstrap/scope-backfill 工具与完整测试。
7. Offline LLM 只保留已版本锁定的未来 seam，不实现生产入口。

明确不交付：新 Novel 绑定流程、scheduler、周期全库存重分类、public Tag 页面、publish/SEO 修改、
Online/Offline LLM 执行链、章节 classifier。

## 2. Target Interfaces

### 2.1 Domain contracts

在新登记的 `src/lib/tagging/` 中冻结不依赖 Prisma/Next/Worker 的类型：

```ts
type TagMode = "automatic" | "manual";
type PersistedTagSource = "manual" | "auto";
type EffectiveTagProvenance = "manual" | "mapped" | "auto";
type ClassificationMethod = "deterministic_text" | "offline_llm";

type ResolvedCanonicalTag = {
  stableId: string;
  slug: string;
  displayName: string;
  provenance: EffectiveTagProvenance[];
};

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

`src/lib/tagging/**` 只使用标准 TypeScript/JavaScript，禁止 import Prisma、server、Next、worker、
scheduler、UI 或新增 NLP runtime dependency。施工第一批同步在 `CLAUDE.md` 登记目录 ownership。

### 2.2 Service contracts

在 `src/server/tagging/` 实现：

- `resolveEffectiveTags({ novelId, locale })`：返回 mode、revision、effective 和分层 provenance。
- `replaceManualTagSnapshot({ novelId, canonicalTagIds, expectedRevision, requestId, actor })`。
- `exitManualTagMode({ novelId, expectedRevision, requestId, actor })`。
- `replaceAutoTagSnapshot({ novelId, result, runMetadata, contentSha, requestId })`。
- `initializeNovelTagSnapshot(novelId)`。
- mapping/taxonomy Admin list、detail、mutation services。

Prisma/SQL 只进入 server/worker 数据访问层；API/UI 不复制 resolver。所有本地 mutation 与
`OperationAudit` 同事务。

### 2.3 Admin HTTP contracts

保持现有 exact-path registry 形态：

| Method | Path | Capability | 用途 |
| --- | --- | --- | --- |
| GET | `/api/admin/canonical-tags` | `content:view` | list/detail/search |
| PUT | `/api/admin/canonical-tags` | `tag:manage` + 2FA | status、translation、alias、keyword maintenance |
| GET | `/api/admin/tag-mappings` | `content:view` | exact edge list/detail/search |
| PUT | `/api/admin/tag-mappings` | `tag:manage` + 2FA | approve/deactivate edge |
| GET | `/api/admin/novels/tags` | `content:view` | effective/manual/mapped/auto projection |
| PUT | `/api/admin/novels/tags` | `tag:manage` + 2FA | replace manual snapshot / exit manual |

Tag identity 的 stable ID/slug 在 V1 Admin 中只读。所有 mutation 要求 request ID；manual mutation
另要求 expected revision。

## 3. Workstreams

### Stream A · Schema, governance and bootstrap

**Owner**：Codex DB custodian

**Dependency**：无；必须首先合并

**Migration**：1 个 additive migration

**估算**：700–1,000 LOC

Existing files to modify：

- `prisma/schema.prisma`
- `src/domain/database-statuses.ts`、`src/domain/database-invariants.ts`
- `infra/postgres/grants.sql`
- `docs/governance/database-schema-dictionary.jsonl`、`database-governance.md`、
  `feature-flag-registry.md`
- `scripts/check-database-dictionary-drift.mjs`、`scripts/README.md`

New files/directories：

- `prisma/migrations/<timestamp>_p2_06_5_tagging_v3/migration.sql`
- `scripts/p2-06-5-production/` 下 bootstrap、raw-language scope preflight/backfill 工具
- database static/integration tests

Implementation：

1. 建立 `CanonicalTag`、`CanonicalTagTranslation`、`CanonicalTagKeyword`、
   `SourceLabelMapping`、`NovelTagState`、`NovelCanonicalTag`、`TagClassificationRun`。
2. 在 `NovelSourceItem` 添加 nullable `rawLanguageScope`；不更新存量 facts。
3. migration 手写命名 CHECK、FK、`COLLATE "C"` exact columns/indexes、JSONB shape/version 与必要
   query indexes；Prisma schema 与 SQL 保持一致。
4. grants 遵循现有 least-privilege：web 只通过受控 service mutation；worker 仅获得 auto snapshot
   所需最小权限；scheduler 不新增 Tag 权限；migration 后重放 grants。
5. bootstrap 默认 dry-run，校验 123/hash、285 decisions、194 MAP groups、196 edges、C1 input SHA；
   apply 必须显式提供 logical channel binding，并写 audit。
6. scope backfill 独立于 bootstrap，报告 missing/null/malformed；apply 不触碰 `SourceLabel` 或 label
   relations。

Tests：migration 空库/重放、Prisma/migration parity、named constraints、C collation、grants、dictionary
drift、authority hash/count、bootstrap idempotency、scope preservation。

Risks：Prisma 无法直接表达所有 collation/CHECK；`NovelTagState.currentAutoRunId` 与 run FK 创建顺序；
存量 raw payload 无法派生 scope。对应处理是 SQL 审核、延后添加循环 FK、fail-closed 报告，禁止
自动修复。

### Stream B · Exact mapping, snapshots and effective resolver

**Owner**：Codex domain custodian

**Dependency**：Stream A schema/types

**可并行**：与 Stream C 的 pure classifier 部分并行

**估算**：800–1,100 LOC

Existing files to modify：

- `worker/handlers/moboreader.ts`（新同步写 raw scope，不改变 raw token）
- `CLAUDE.md`（登记 `src/lib/tagging/` ownership/import boundary）
- 相关 backend test fixtures

New directories：

- `src/lib/tagging/`：raw scope、contracts、stable ordering 等纯函数
- `src/server/tagging/`：mapping query、effective resolver、snapshot/manual transaction

Implementation：

1. 从 Lane B `scripts/p2-06-5-lane-b/raw.mjs` 适配 `RAW_LANGUAGE_SCOPE_V1` pure function；保持
   raw JSON type/value、missing/null/name identity。
2. resolver 只处理 zero-or-one active source binding；多绑定、错 locale/scope 返回
   `DATA_INVARIANT_VIOLATION`。
3. mapped exact join 使用 source item scope + SourceLabel exact value + active mapping；不物化。
4. automatic mode 合并 mapped/current auto，按 Tag 去重并保留全部 provenance；manual mode 即使空
   snapshot也短路。
5. manual replace/exit 使用 advisory lock + row lock + expected revision + payload fingerprint +
   OperationAudit；auto writer 复用同一 state lock 并在 manual mode skip。

Tests：whitespace/case/Unicode/scope distinctions、1:N、unknown/inactive、mapped/auto union、dedupe、
manual empty/takeover/exit、stable order、source isolation、request replay、revision/race/rollback。

Risks：现有 `SourceLabel` 不含 scope，不能被误作 mapping FK；OperationAudit request ID 没有唯一
约束，必须用 advisory lock 串行化重试；列表读取必须提供 batch resolver，禁止 N+1。

### Stream C · Deterministic classifier and explicit task lifecycle

**Owner**：Codex runtime custodian

**Dependency**：A 的 schema、B 的 auto snapshot service

**估算**：900–1,300 LOC

Existing files to modify：

- `worker/index.ts` 与现有 task allowlist/registry
- GenericTask factory/service 所在现有文件
- feature flag loader/registry
- `scripts/README.md`

New files：

- `src/lib/tagging/classifier.ts`、`classifier-config.ts`、keyword matching/support files
- `src/server/tagging/auto-classification.ts`
- `worker/handlers/novel-tag-backfill.ts`
- explicit task/backfill CLI 及 backend/integration tests

Implementation：

1. 从 Lane C `scripts/p2-06-5-lane-c/calibration.mjs` 适配 matcher、field scoring 和 deterministic
   order；删除 source diagnostics、source-language feature 与 chapter path。
2. production config 只有一个文件/loader；pending 时 fail `CONFIG_NOT_READY`，测试显式注入 fixture。
3. 新 GenericTask type 支持 `initialize_missing | reclassify_existing`，一 Novel 一 item，沿用 claim、
   lease、epoch、fencing、retry、error sanitizer。
4. enqueue 必须显式 scope；dry-run 默认，`--all` 要求字面量确认与 authority/config fingerprint。
5. Worker 在写前二次校验 feature flags、`AUTO_WRITE_AUTHORIZED === "YES"`、mode、content SHA 和
   entity isolation；atomic replace auto snapshot。
6. `scheduler/index` 保持无 Tag schedule，并以 regression test 锁定。

Tests：Latin whole-word、CJK contiguous ≥2 code points、title/description only、threshold、
maxTextTags、tie order、empty snapshot、config pending、write gates、task fencing/idempotency、manual
skip、dry-run、scoped/all execution、无 scheduler。

Lane C Owner Final 已冻结 `30 / 30 / 30 / 3` 与 `keyword-eligibility-v2`；production 仍通过唯一
versioned authority loader 与 fingerprint 消费，artifact/version/SHA 不一致时 fail closed。

### Stream D · Admin contracts and APIs

**Owner**：Codex server custodian；共享 contract 由 `CLAUDE.md` 指定 custodian 合并

**Dependency**：Stream B service DTO 稳定

**估算**：600–900 LOC

Existing files to modify：

- `src/contracts/admin-content.ts` 或新同级 Tag contract
- `src/server/admin-content/` 的既有 domain/service composition
- `src/app/api/admin/_lib/registry.ts`、auth capability registry

New routes：

- `src/app/api/admin/canonical-tags/route.ts`
- `src/app/api/admin/tag-mappings/route.ts`
- `src/app/api/admin/novels/tags/route.ts`

Implementation：注册 flat paths；新增 `tag:manage`（super_admin 默认、2FA true）；GET 复用
`content:view`；逐字段 projection，不泄漏 internal IDs、raw payload 或 run internals；mutation 统一
request validation、error mapping、service transaction 和 audit。

Tests：registry parity、401/403/2FA、malformed input、revision conflict、not-found/invariant error、
sensitive-field boundary、audit same-transaction semantics。

Overlap risk：registry、capability 和 contracts 是共享热点。D 必须单一 custodian 串行合并；Stream E
只消费冻结 DTO，不修改 server resolver。

### Stream E · Admin V1 UI

**Owner**：Claude UI custodian

**Dependency**：Stream D DTO/routes frozen

**估算**：900–1,300 LOC

Existing files to modify：Admin navigation、Novel detail、Admin UI fixtures/tests。

New pages/components：`/canonical-tags`、`/tag-mappings`、Novel detail Tag panel。

Implementation：

- CanonicalTag list/search/detail、active status、translation/alias/keyword maintenance；stable ID/slug
  只读。
- Mapping table 明显展示 channel、raw-language scope、exact raw token、targets、active/audit；用
  whitespace-visible display 防止操作人误判。
- Novel detail 区分 mapped/auto provenance；manual modal 明示 FULL_SNAPSHOT takeover，空集合二次确认，
  提供 exit/reset 并显示 revision conflict recovery。
- 不修改现有 `/tags` 的 raw SourceLabel 语义，不改 public UI。

Tests：render/empty/error/loading、keyboard/focus、FULL_SNAPSHOT wording、empty confirmation、reset、
provenance、inactive state、admin nav parity、no public import。

### Stream F · Integration, QA and rollout evidence

**Owner**：Codex QA custodian

**Dependency**：贯穿所有 Stream，最后收口

**估算**：800–1,100 LOC

New/modified tests：`tests/backend/tagging/`、`tests/integration/tagging/`、`tests/ui/admin-*tags*`，以及
database/runtime regression suites。

Responsibilities：

- 将 ADR §17 每条不变量映射到具体 test name；
- PostgreSQL 实测 C collation、constraints、manual/auto race、audit rollback；
- bootstrap/scope dry-run 输出 machine-readable summary；
- 证明 scheduler、publish gate、sitemap、IndexNow、public routes 零变化；
- 整理 G1–G7 evidence，G7 在 Owner Gate 前保持 blocked。

## 4. Merge and Dependency Order

```text
A schema/governance
  ├──> B mapping/resolver/manual ──> D Admin API ──> E Admin UI
  └──> C classifier pure core
          └── B auto snapshot contract ──> C Worker/backfill completion

F tests/evidence follows each merge and closes last
```

单一 custodian 热点：

- `prisma/schema.prisma`：Stream A；
- `src/lib/tagging/` shared contracts：Stream B，C 通过明确文件边界提交；
- Admin contracts/registry：Stream D；
- `worker/index.ts`：Stream C。

不得让多个并行 agent 同时编辑上述热点。推荐 merge 顺序：A → B/C pure 部分 → B snapshot → C
worker → D → E → F closeout。

总估算 4,700–6,700 LOC、约 35–50 个实现/测试文件、1 个 migration。
`P2_06_5_PRODUCTION_IMPLEMENTATION_SIZE=LARGE`，依据为跨 DB/domain/worker/Admin 的依赖深度、
exact identity/并发事务复杂度及回归表面，不按日历时间估算。

## 5. Migration and Deployment Sequence

1. **G0 · ADR**：Owner 接受 V3；旧 ADR 只保留 superseded stub。
2. **只读 preflight**：扫描多 active source binding、locale mismatch、raw scope 可派生率；发现异常只
   报告，不清理。
3. **G1 · Schema**：local/test 执行 additive migration；重放 grants；验证空库、已有库、migration
   replay、rollback strategy 与 dictionary drift。
4. **G2 · Dark deploy**：部署实现，`FEATURE_P2_06_5_TAGGING=false`、
   `FEATURE_P2_06_5_TAG_ADMIN_WRITE=false`、`FEATURE_NOVEL_TAG_AUTO=false`、
   `AUTO_WRITE_AUTHORIZED=NO`。
5. **G3 · Bootstrap dry-run**：验证 authority 文件、hash/count、285/194/196 与 explicit ChannelApp
   binding；raw scope 单独 dry-run。
6. **G4 · Authorized bootstrap apply**：幂等写 taxonomy/mapping，随后按单独授权回填可证明的 scope；
   校验 audit、counts、hash、异常报告。
7. **G5 · Read/Admin**：开启 master/Admin exposure，观察 invariant errors；Tag 缺失不影响 publish。
8. **G6 · Config freeze**：Owner 冻结 C1 参数，更新唯一 config version/fingerprint，全量测试。
9. **G7 · Auto apply**：Owner 单独设置 `AUTO_WRITE_AUTHORIZED=YES`，先小范围 novel/locale task，再按
   显式 scope 扩展。不得启用 scheduler。

Rollback 使用 feature gates 与 `active=false`，保留 source facts、audit 与 run history；不得临时创建
destructive migration。bootstrap/auto task 的每次 apply 都必须能用 request/task identity 审计和
重复执行。

## 6. Executable Test Matrix

| Area | Required scenarios |
| --- | --- |
| Taxonomy | stable ID/slug/translation uniqueness；alias collision；inactive；123/hash |
| Mapping | whitespace/case/Unicode/scope distinction；1:N；unknown；inactive edge/tag；194/196 |
| Resolver | mapped only；auto only；union/dedupe；stable order；deleted/inactive facts |
| Manual | takeover；empty snapshot；exit；inactive ID rejection；revision/request replay |
| Isolation | cross-channel/locale/source rejection；multiple binding；missing scope |
| Classifier | title/description；Latin/CJK；threshold；maxTextTags；tie order；excluded metadata |
| Auto run | initial missing；reclassify replace；empty run；content stale；manual skip；idempotency |
| Backfill | dry-run default；novel/locale/all scope；rerun；write gate；no cross-entity mutation |
| Admin | capability/2FA；projection；FULL_SNAPSHOT warning；empty confirmation；audit |
| Regression | no scheduler/full scan；no publish/SEO/sitemap/IndexNow/public route changes |

验收命令：

```bash
npm run typecheck
npm run lint
npm run test:backend
npm run test:integration
npm run test:ui
npm run build
```

PostgreSQL integration 环境不可用时，implementation status 必须保持 blocked，不得用 static test 代替
C collation、FK/CHECK、transaction 与 concurrency 验证。

## 7. Completion Status Contract

生产代码合并前，文档/实现报告必须保留：

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
