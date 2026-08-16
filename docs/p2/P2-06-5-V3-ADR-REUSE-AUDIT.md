# P2-06.5 · V3 ADR Reuse Audit

```text
AUDIT_STATUS          = COMPLETE
AUDIT_DATE            = 2026-08-16
NOVEL_BASELINE        = main c5bf508
CPS_READ_ONLY_BASELINE= d77c3b968285698529cf97c7f0f97b286d7a2a9c
TARGET_ADR            = docs/adr/ADR-P2-06-5-TAGGING-V3.md
```

本审计只回答“现有实现如何进入 V3”，不重新审计 taxonomy、B1/B2 或 C1 数据结论。裁决词：
`REUSE_AS_IS`、`ADAPT_EXISTING`、`NEW_REQUIRED`、`DROP_OLD_DESIGN`、`PATTERN_ONLY`。

## 1. Executive Result

P2-06.5 不是绿地：raw source labels、来源同步、GenericTask/Worker、OperationAudit、Admin registry、
feature flags、Lane B exact scope 与 Lane C deterministic matcher 均已有可复用基础。生产缺口集中在
Canonical taxonomy persistence、exact scoped mapping、manual/auto snapshot state、effective resolver 和
Tag Admin mutation 面。

V3 不直接移植 CPS Tag code。CPS 可提供 translation、snapshot replace、显式分页 backfill 的模式
参考，但其 SQLite/Int identity、nodejieba/synonym、noisy metadata、fallback/15-tag cap 与公开 SEO
耦合均与海阅冻结合同冲突。

## 2. Repository Evidence and Decisions

| Component | Current evidence | Decision | V3 action |
| --- | --- | --- | --- |
| `Novel` identity | `prisma/schema.prisma`：UUID、global `businessId`、locale；没有 Tag mode/relations | ADAPT_EXISTING | 不改 canonical identity；新增独立 `NovelTagState`/relations，不增加 genre 字段 |
| `NovelSourceItem` | 唯一 `(channelAppId, externalBookId, sourceLanguageCode)`；含 rawPayload/sourceLocale，可绑定 Novel | ADAPT_EXISTING | 加 nullable exact `rawLanguageScope`；resolver 验证 zero-or-one active binding 与 locale/source identity |
| `SourceLabel` | 唯一 `(channelAppId,labelKind,externalLabelValue)`；没有 raw-language scope | REUSE_AS_IS | 继续作为 faithful raw dictionary；不能作为 B2 mapping identity FK |
| `NovelSourceItemLabel` | exact relation、`active`、first/last seen | REUSE_AS_IS | mapped resolver 只消费 active relation；不创建 mapped snapshot |
| MoboReader label persistence | `worker/handlers/moboreader.ts` upsert raw label/relation；空值检查后保留原 token | ADAPT_EXISTING | 新 source item 同时计算 raw scope；不 trim/case-fold/normalize token，不重写现有 labels |
| Lane B scope logic | `scripts/p2-06-5-lane-b/raw.mjs` 的 `rawLanguageIdentity`/`rawJsonIdentity` 区分 JSON type、missing/null | ADAPT_EXISTING | 抽取 production pure function，供 sync、resolver preflight、backfill 共用 |
| B2 final data | `docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16/`：285 keys、194 groups、196 edges | REUSE_AS_IS | bootstrap 的只读 authority；只导入 approved edges |
| Lane C classifier | `scripts/p2-06-5-lane-c/calibration.mjs`：Unicode Latin whole-word、CJK contiguous、field score、stable order | ADAPT_EXISTING | 移入 `src/lib/tagging/` pure core；删除 source diagnostics、source-language/chapter inputs |
| C1 owner-final artifacts | `artifacts/p2-06-5-lane-c/2026-08-16-owner-final-c1-v2/`：source mapping/keywords | REUSE_AS_IS | config/keyword bootstrap authority；参数 pending 时 production fail closed |
| Existing Tag table | 仓库无 CanonicalTag、translation、mapping、Novel tag snapshot | NEW_REQUIRED | 新增 V3 schema；保持 global/flat identity |
| `OperationAudit` | 已有 actor/action/entity/request/task/reason/before/after 与 append-only governance | REUSE_AS_IS | 所有 Tag mutation 与业务写同事务；不创建重复 audit framework |
| `GenericTask`/items | 已有多态目标、claim/lease/epoch/fencing/at-least-once | REUSE_AS_IS | 新显式 Tag backfill type/item；一 Novel 一 item |
| Worker registry | `worker/index.ts` 有 handler registry/allowlist/shutdown/error sanitation | ADAPT_EXISTING | 登记 tag backfill handler；复用 runtime，不新建 Worker 框架 |
| Scheduler | 当前 business `SCHEDULES=[]`，有边界测试 | REUSE_AS_IS | 保持无 Tag schedule；添加防周期扫描 regression |
| Feature flags | `src/lib/flags/feature-flags.ts` exact `"true"`；registry 有 catalog 双闸 | ADAPT_EXISTING | 增加 master/auto flags；Owner auto gate 使用 exact `YES` |
| Admin registry | `src/app/api/admin/_lib/registry.ts` 只支持 exact flat paths | ADAPT_EXISTING | 新 API 使用 `/canonical-tags`、`/tag-mappings`、`/novels/tags` flat paths |
| Admin contracts/domain | `src/contracts/admin-content.ts` 与 `src/server/admin-content/` 逐字段 projection | ADAPT_EXISTING | 新 Tag DTO/service 复用相同分层，不将 Prisma/rawPayload 泄漏到 UI |
| `/tags` UI | 当前展示 raw `SourceLabel` dictionary，read-only | REUSE_AS_IS | 保留并标明“来源标签”；CanonicalTag 使用独立页面 |
| Novel detail UI | 当前展示来源与 raw labels，无 canonical/manual editor | ADAPT_EXISTING | 添加 provenance + FULL_SNAPSHOT editor，不复制 resolver |
| Capabilities/2FA | `src/lib/auth/capabilities.ts` 是唯一能力位真源 | ADAPT_EXISTING | 新 `tag:manage`，super_admin 默认，2FA true；读面复用 `content:view` |
| CLI/backfill convention | `scripts/` 已有 dry-run/evidence 工具；production task 走正式 runtime | ADAPT_EXISTING | bootstrap/scope 默认 dry-run；auto apply 通过 service/GenericTask，不 direct DB update |
| Database governance | migration-only、named CHECK/index、JSONB version、grants replay、dictionary drift | REUSE_AS_IS | 一个 additive migration；seed/backfill 不进 migration |
| Import ownership | `CLAUDE.md` 划分 Codex backend、Claude UI、shared contract custodian | ADAPT_EXISTING | 登记新 `src/lib/tagging/`；共享热点保持单一 custodian |

## 3. Previous ADR Disposition

旧 `P2_06_5_ADR_TAGGING.md` 的逐项裁决：

| Old decision/pattern | Decision | Reason |
| --- | --- | --- |
| mapped read-derived | REUSE_AS_IS | 避免第二真源与 mapping 变化后的全库清理 |
| `src/lib/tagging` pure boundary | REUSE_AS_IS | 符合现有 ownership/import discipline |
| entity invariant guard | ADAPT_EXISTING | V3 增加 exact raw scope，继续 fail closed |
| dry-run read-only discipline | REUSE_AS_IS | bootstrap/backfill 默认 dry-run |
| OperationAudit same transaction | REUSE_AS_IS | 现有审计模型足够 |
| feature flag/write gate | ADAPT_EXISTING | 保留双闸并增加 Owner `AUTO_WRITE_AUTHORIZED=YES` |
| migration/governance/test skeleton | REUSE_AS_IS | 符合当前 PostgreSQL 治理 |
| `manual > mapped > auto > 0` | DROP_OLD_DESIGN | V3 为 manual FULL_SNAPSHOT 或 no-manual mapped∪auto |
| mapped nonempty short-circuits auto | DROP_OLD_DESIGN | auto 用于补充 source taxonomy 未覆盖的语义 |
| manual row existence = ownership | DROP_OLD_DESIGN | 无法表达显式空 manual snapshot |
| reject empty manual | DROP_OLD_DESIGN | 违反 V3 FULL_SNAPSHOT 0 Tag 语义 |
| locale-scoped CanonicalTag | DROP_OLD_DESIGN | Tag identity 全局；locale 只属于 translation/display |
| mapping FK only to `SourceLabel` | DROP_OLD_DESIGN | `SourceLabel` 缺 raw-language scope，不能表达 B2 identity |
| `source=mapped` vocabulary/trigger | DROP_OLD_DESIGN | persistence enum 只允许 manual/auto，mapped 不应成为可写值 |
| auto only when mapped empty | DROP_OLD_DESIGN | V3 automatic mode 必须 union |
| no new Worker task | DROP_OLD_DESIGN | V3 需要显式 GenericTask backfill，但仍无 scheduler |
| candidate threshold/maxTags contract | DROP_OLD_DESIGN | C1 参数由唯一 pending/frozen config 管理 |

主工作树保留的旧路径文件只包含 superseded marker 和新 ADR 链接，不再重复任何旧设计正文，避免
两个文档看似同时 authoritative。

## 4. CPS Read-only Reference Audit

只读仓库：`/Users/chenweifeng/Documents/cps项目/cps-admin-v811-search-ux`，baseline
`d77c3b968285698529cf97c7f0f97b286d7a2a9c`。

| CPS pattern | Decision | Novel V3 adaptation |
| --- | --- | --- |
| Tag identity + translation | PATTERN_ONLY | 采用一个 global Tag + translations；不复制 Int/SQLite schema |
| Replace existing auto relation snapshot | PATTERN_ONLY | 通过 run + transaction 替换 auto rows；mapped 仍 read-derived |
| Explicit paginated backfill | PATTERN_ONLY | 复用 GenericTask/fencing，要求显式 scope 和 write gate |
| Tag admin list/form | PATTERN_ONLY | 借鉴交互信息架构，遵守海阅 registry/capability/contracts |
| `DramaTag` manual/auto uniqueness | DROP_OLD_DESIGN | 海阅需要 explicit mode 和同 Tag 两层可共存 |
| nodejieba/synonym/TF-IDF | DROP_OLD_DESIGN | Lane C matcher是冻结核心，禁止新 NLP dependency |
| recommend/language/metadata classification | DROP_OLD_DESIGN | noisy metadata 不进入 classifier |
| fallback tag / max 15 | DROP_OLD_DESIGN | 无证产品规则；V3 threshold/maxTextTags 只作用 auto text |
| implicit full scan/re-tag | DROP_OLD_DESIGN | 只允许新 Novel 初始化和显式 task |
| public tag SEO routes | DROP_OLD_DESIGN | P2-06.5 没有 SEO/public authorization |

没有直接复制 CPS 文件或代码，因此本轮无需新增 port-registry 条目。若生产施工后续复制具体代码，
必须在同一 PR 登记来源路径、baseline、adaptation 和 license/provenance。

## 5. Duplication and Boundary Guards

生产施工必须满足：

- exact raw scope 算法只有一个 pure implementation；sync/backfill/resolver 不各写一份。
- classifier 参数只有一个 production source；Worker/CLI/tests 不复制数值。
- effective resolver 只有 server/domain 一份；API、Admin UI、task handler 不重新实现层语义。
- mapped 不进入 `NovelCanonicalTag`；任何 schema enum/service path 出现 mapped persistence 都应测试失败。
- Admin mutation 只经 capability guard + service + audit；CLI apply 只编排正式 service/task。
- `/tags` raw label 与 `/canonical-tags` 标准标签是两个明确概念，不复用错误 DTO。
- Scheduler 不注册 Tag job；taxonomy/keyword 变化不产生隐式库存扫描。

## 6. Audit Conclusion

```text
SOURCE_LABEL_FACTS              = REUSE_AS_IS
SOURCE_SYNC_RAW_SCOPE           = ADAPT_EXISTING
LANE_B_EXACT_IDENTITY           = ADAPT_EXISTING
LANE_C_CLASSIFIER_CORE          = ADAPT_EXISTING
GENERIC_TASK_WORKER             = REUSE_AS_IS
OPERATION_AUDIT                 = REUSE_AS_IS
ADMIN_REGISTRY_CONTRACTS        = ADAPT_EXISTING
CANONICAL_TAG_PERSISTENCE       = NEW_REQUIRED
MAPPING_AND_SNAPSHOT_STATE      = NEW_REQUIRED
OLD_SHORT_CIRCUIT_ARCHITECTURE  = DROP_OLD_DESIGN
CPS_TAG_CODE                    = PATTERN_ONLY
REUSE_AUDIT_RESULT              = READY_FOR_IMPLEMENTATION
```
