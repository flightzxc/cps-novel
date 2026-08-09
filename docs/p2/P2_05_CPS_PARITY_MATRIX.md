# P2-05 CPS Parity Matrix

## Baseline and operating boundary

- CPS read-only baseline: `d77c3b968285698529cf97c7f0f97b286d7a2a9c`
- Production SOP acknowledgement: `54c3e49433ca05f5129afe1bda74d4e39b88cba175b1cd6a18ebb26c4f3704fd`
- P2 base contract: `892c1a8aabc617b6b9172777e3200fe81a08b82f`
- Production writes: prohibited. `claimPromo`, `getcode`, and all other side-effect protocols are absent.
- Owner evidence ruling (2026-08-09): `dataId = getlistpc.seriesId`; `materialType = row.materialType ?? 1` using nullish, not truthy, selection. This is a per-row runtime policy, not a global constant. `1001` belongs to `/material/temp/uploadcallback` and is rejected for `getbydataid`.
- Evidence status: `DATAID_EVIDENCE=CONFIRMED`; `MATERIALTYPE_EVIDENCE=CONFIRMED_AS_RUNTIME_SELECTION_POLICY`; `MATERIALTYPE_GLOBAL_CONSTANT=NOT_ASSERTED`; `MATERIALTYPE_1001=REJECTED`. The former delivery gate is closed; multi-book/multi-language sampling is supplementary verification only.

## Matrix

| Concern | CPS evidence / behavior | P2-05 implementation | Status |
| --- | --- | --- | --- |
| Catalog batch sync | `worker/handlers/changdu-source-sync.ts` page-oriented source mirror | `catalog_scan` pages call only `getlistpc`; sources are idempotently upserted | parity |
| `getlistpc` | Read-only channel catalog request | Exact five-field JSON body: `name/orderType/pageIndex/pageSize/projectType`; no query or unproven filter | parity |
| Single content detail | Channel detail adapter, read only | `getbydataid` request is constructed from the original catalog row: `dataId=seriesId`, present `materialType` passes through, null/undefined falls back to `1` | parity, enabled |
| Episode/chapter list | Preview episode adapter and content refresh | The registered `channel_sync` handler uses the same frozen request constructor, then calls `getchapterinfo` and the existing transaction-fenced materializer | parity, enabled |
| Manual/automatic trigger | Preview follows the concrete upstream batch | Manual and S1 post-catalog paths call the same enqueue helper and write the same `ChannelSyncTask` / `ChannelSyncTaskItem` shape; only `params.trigger` differs | parity |
| Dry-run | Read/parse/plan with no protected business write | Existing P1 runtime removes `protectedWrite`; task results and audits remain | parity |
| Safety max pages | CPS technical safety limit 2,000, env-overridable; exhaustion is partial failure | `MOBOREADER_CATALOG_SAFETY_MAX_PAGES`, default 2,000; `safety_limit` writes logical `partial_failed` (schema-compatible parent status `completed_with_errors`) | parity |
| Catalog business item quota | CPS read-only mirroring has none | No `maxItems`, item-count rejection, task quota table, or quota-specific unique counting | parity |
| Progress and completeness | CPS durable checkpoints plus expected/raw/unique/duplicate observations | Parent result records stop reason, expected/actual, fetched unique and duplicates; upstream observed total remains observational | parity |
| Recoverable task | Attempt increments on claim; stale recovery up to three attempts | Reuses P1 store, lease epoch, execution token, heartbeat, stale recovery, and parent recount | reused |
| Audit | Batch/task result and operator evidence | Queue/page/materialization audits contain counts/status/hash prefixes only | parity |
| Feature flag | Explicit env gate, default disabled | `FEATURE_NOVEL_CATALOG_SYNC`, exact `=== "true"`, checked at enqueue and Handler | parity |
| Allow Write | Independent write gate | `NOVEL_CATALOG_SYNC_ALLOW_WRITE`; apply requires both gates | parity |
| Worker handler | Registry plus deployment allowlist intersection | Existing worker registers `catalog_scan` and the enabled Preview `channel_sync` family; no second worker | parity |
| Retry | Retry safe reads, bounded backoff, Retry-After | Max three attempts for transport/timeout/408/429/5xx; malformed and other 4xx are terminal | parity |
| Idempotency | Request and row identities | Unique `requestToken`, active scope uniqueness, page fingerprint, source/chapter upserts, content hash | parity |
| S1 batch scope | Post-sync Preview takes the actual IDs from that sync batch | Actual upserted source IDs are persisted per page and unioned only at terminal catalog commit; deterministic parent request token prevents duplicate enqueue | parity |
| Preview freshness and execution policy | 24h freshness, chunk 25, concurrency 2, timeout 20s | Same defaults, all env-overridable; freshness is admission-only and never changes catalog scope | parity |
| Preview cap | Policy-owned source-specific cap | Changdu policy initialization is 3; every refresh reads `NovelPreviewPolicy.maxMaterializedChapters` | owner-frozen |
| Refresh authority | Failed/empty response cannot erase old valid data | Only trusted complete non-empty chapter lists reach writes; no hard delete; successful authority may mark absent chapters stale | parity |
| `allEpis` | Scalar metadata | Saves `totalChapterCount`; never creates chapter rows | parity |
| `payEpisFrom` | Source metadata | Saves source value only; no withdrawal, deletion, SEO, IndexNow, watcher or reconciliation | owner-frozen |
| Source labels | Preserve raw labels without promotion | Known raw label kinds persist verbatim; unknowns remain approved raw evidence, with no mapping/canonical/public exposure | parity |

## Isolation and schema gate

No task table or migration is added. Existing `CatalogScanTask`, `ChannelSyncTask`, preview/content entities, checkpoint fields, partial active indexes, and audit table express the staged implementation. `infra/postgres/grants.sql` only extends `worker_app` SELECT privileges to the tables this existing Worker write path must read. P2-04-owned paths are untouched.
