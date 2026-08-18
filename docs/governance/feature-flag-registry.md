# Feature Flag Registry

| Name | Default | Readers | Scope |
| --- | --- | --- | --- |
| `FEATURE_NOVEL_CATALOG_SYNC` | `false` | manual task factory, MoboReader catalog Worker handler | Allows the proven read-only `getlistpc` catalog workflow to be queued/consumed. |
| `NOVEL_CATALOG_SYNC_ALLOW_WRITE` | `false` | manual task factory, MoboReader catalog Worker handler | Allows protected business writes only when the feature flag is also true and task mode is `apply`. |
| `FEATURE_INDEXNOW_OUTBOX` | `false` | `src/lib/indexnow/dispatch-handler.ts`'s `enqueueIndexNow`, `outbox.ts`'s `enqueueIndexNowFirstPublish`/`releaseDeferredIndexNowOutbox` | Allows the IndexNow outbox enqueue path to run at all (P2-11). |
| `INDEXNOW_OUTBOX_ALLOW_WRITE` | `false` | same as above | Allows `indexnow_outbox` rows to actually be written; both this and `FEATURE_INDEXNOW_OUTBOX` must be `true`. |
| `FEATURE_INDEXNOW_DELIVERY` | `false` | `src/lib/indexnow/sweep.ts`'s `sweepDueIndexNowDeliveries`, `worker/handlers/indexnow-delivery.ts` | Allows the delivery sweep to create `GenericTaskItem`s and the worker handler to run at all. |
| `INDEXNOW_DELIVERY_ALLOW_WRITE` | `false` | same as above | Allows the worker handler to call the real IndexNow API and write attempt/outcome data; both this and `FEATURE_INDEXNOW_DELIVERY` must be `true`. |

Both `FEATURE_NOVEL_CATALOG_SYNC`/`NOVEL_CATALOG_SYNC_ALLOW_WRITE` use exact `=== "true"` parsing. A `dry_run` may read and build a plan when the feature flag is true, but the P1 runtime strips its protected write before finalization.

The four IndexNow flags (P2-11, `P2_07_12_一轮实施分工方案_2026-08-12.md` §三 Stream E) are deliberately two *independent* double-gate pairs rather than one pair shared by both capabilities, matching the round's rollout convention ("enqueue 先行、worker 后开", `P2-07-12-移植审计-2026-08-12/P2-11.md` §11 红旗5): operators can turn on outbox writes first to inspect accumulated candidate URLs/eligibility before the worker ever calls the real external IndexNow API. All four use exact `=== "true"` parsing, same as the pair above.
