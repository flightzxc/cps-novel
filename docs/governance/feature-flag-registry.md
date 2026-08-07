# Feature Flag Registry

| Name | Default | Readers | Scope |
| --- | --- | --- | --- |
| `FEATURE_NOVEL_CATALOG_SYNC` | `false` | manual task factory, MoboReader catalog Worker handler | Allows the proven read-only `getlistpc` catalog workflow to be queued/consumed. |
| `NOVEL_CATALOG_SYNC_ALLOW_WRITE` | `false` | manual task factory, MoboReader catalog Worker handler | Allows protected business writes only when the feature flag is also true and task mode is `apply`. |

Both flags use exact `=== "true"` parsing. A `dry_run` may read and build a plan when the feature flag is true, but the P1 runtime strips its protected write before finalization.
