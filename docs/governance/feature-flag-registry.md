# Feature Flag Registry

| Name | Default | Readers | Scope |
| --- | --- | --- | --- |
| `FEATURE_NOVEL_CATALOG_SYNC` | `false` | manual task factory, MoboReader catalog Worker handler | Allows the proven read-only `getlistpc` catalog workflow to be queued/consumed. |
| `NOVEL_CATALOG_SYNC_ALLOW_WRITE` | `false` | manual task factory, MoboReader catalog Worker handler | Allows protected business writes only when the feature flag is also true and task mode is `apply`. |
| `FEATURE_SITEMAP_AUTO_REFRESH` | `false` | Sitemap refresh enqueue adapter | Allows a filesystem-only Sitemap refresh task to be queued after publication. Disabled means no task row is created. |

The two catalog flags use exact `=== "true"` parsing. A `dry_run` may read and build a plan when the feature flag is true, but the P1 runtime strips its protected write before finalization. The Sitemap flag uses the same exact parsing and defaults off.

`FEATURE_SITEMAP_AUTO_REFRESH` has no separate write-allow flag because its worker does not mutate business tables: the only durable output is an atomically promoted static-file release. GenericTask bookkeeping remains the runtime's standard control-plane write.
