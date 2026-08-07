# P2-05 CPS Parity Matrix

## Baseline and operating boundary

- CPS read-only baseline: `d77c3b968285698529cf97c7f0f97b286d7a2a9c`
- Production SOP acknowledgement: `54c3e49433ca05f5129afe1bda74d4e39b88cba175b1cd6a18ebb26c4f3704fd`
- P2 base contract: `892c1a8aabc617b6b9172777e3200fe81a08b82f`
- Production writes: prohibited. `claimPromo`, `getcode`, and all other side-effect protocols are absent.
- Delivery gate: `getbydataid.materialType` has no proven value/source. The contract/parser exists, but runtime remains `registered_disabled`; `getchapterinfo` is not consumed around that gate.

## Matrix

| Concern | CPS evidence / behavior | P2-05 implementation | Status |
| --- | --- | --- | --- |
| Catalog batch sync | `worker/handlers/changdu-source-sync.ts` page-oriented source mirror | `catalog_scan` pages call only `getlistpc`; sources are idempotently upserted | parity |
| `getlistpc` | Read-only channel catalog request | Exact five-field JSON body: `name/orderType/pageIndex/pageSize/projectType`; no query or unproven filter | parity |
| Single content detail | Channel detail adapter, read only | Explicit `getbydataid` DTO/parser/endpoint; runtime disabled pending proven `materialType` | staged, fail-closed |
| Episode/chapter list | Preview episode adapter and content refresh | Explicit `getchapterinfo` DTO/parser and materialization core; no independently consumable handler | staged, fail-closed |
| Manual trigger | Admin source-sync actions preserve actor/submission metadata | `createMoboreaderCatalogScanTask`; `source=manual`, actor and request ID in params/audit | parity |
| Dry-run | Read/parse/plan with no protected business write | Existing P1 runtime removes `protectedWrite`; task results and audits remain | parity |
| Max pages | CPS page cap 2,000 | Enqueue and Handler payload validation cap at 2,000 | parity |
| Max items | CPS bounded batches | Enqueue and transactionally locked page-commit recheck cap at 1,000 | parity |
| Progress checkpoint | CPS durable progress/reconcile checkpoints | Page result plus parent `lastCompletedPage`, returned count and observed total | parity |
| Recoverable task | Attempt increments on claim; stale recovery up to three attempts | Reuses P1 store, lease epoch, execution token, heartbeat, stale recovery, and parent recount | reused |
| Audit | Batch/task result and operator evidence | Queue/page/materialization audits contain counts/status/hash prefixes only | parity |
| Feature flag | Explicit env gate, default disabled | `FEATURE_NOVEL_CATALOG_SYNC`, exact `=== "true"`, checked at enqueue and Handler | parity |
| Allow Write | Independent write gate | `NOVEL_CATALOG_SYNC_ALLOW_WRITE`; apply requires both gates | parity |
| Worker handler | Registry plus deployment allowlist intersection | Combined existing credential registry with `catalog_scan`; deployment allowlist includes catalog only | parity |
| Retry | Retry safe reads, bounded backoff, Retry-After | Max three attempts for transport/timeout/408/429/5xx; malformed and other 4xx are terminal | parity |
| Idempotency | Request and row identities | Unique `requestToken`, active scope uniqueness, page fingerprint, source/chapter upserts, content hash | parity |
| Preview cap | Policy-owned source-specific cap | Changdu policy initialization is 3; every refresh reads `NovelPreviewPolicy.maxMaterializedChapters` | owner-frozen |
| Refresh authority | Failed/empty response cannot erase old valid data | Only trusted complete non-empty chapter lists reach writes; no hard delete; successful authority may mark absent chapters stale | parity |
| `allEpis` | Scalar metadata | Saves `totalChapterCount`; never creates chapter rows | parity |
| `payEpisFrom` | Source metadata | Saves source value only; no withdrawal, deletion, SEO, IndexNow, watcher or reconciliation | owner-frozen |
| Source labels | Preserve raw labels without promotion | Known raw label kinds persist verbatim; unknowns remain approved raw evidence, with no mapping/canonical/public exposure | parity |

## Isolation and schema gate

No task table or migration is added. Existing `CatalogScanTask`, `ChannelSyncTask`, preview/content entities, checkpoint fields, partial active indexes, and audit table express the staged implementation. `infra/postgres/grants.sql` only extends `worker_app` SELECT privileges to the tables this existing Worker write path must read. P2-04-owned paths are untouched.
