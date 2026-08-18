# Feature Flag Registry

| Name | Default | Readers | Scope |
| --- | --- | --- | --- |
| `FEATURE_NOVEL_CATALOG_SYNC` | `false` | manual task factory, MoboReader catalog Worker handler | Allows the proven read-only `getlistpc` catalog workflow to be queued/consumed. |
| `NOVEL_CATALOG_SYNC_ALLOW_WRITE` | `false` | manual task factory, MoboReader catalog Worker handler | Allows protected business writes only when the feature flag is also true and task mode is `apply`. |
| `FEATURE_SITEMAP_AUTO_REFRESH` | `false` | Sitemap refresh enqueue adapter | Allows a filesystem-only Sitemap refresh task to be queued after publication. Disabled means no task row is created. |
| `SITEMAP_AUTO_REFRESH_ALLOW_WRITE` | `false` | Sitemap refresh Worker handler | Allows the Worker to generate and atomically promote a static Sitemap only while `FEATURE_SITEMAP_AUTO_REFRESH` is also true. |

All flags use exact `=== "true"` parsing and default off. A catalog `dry_run` may read and build a plan when its feature flag is true, but the P1 runtime strips its protected write before finalization. Sitemap enqueue and filesystem promotion are separate gates: queuing requires `FEATURE_SITEMAP_AUTO_REFRESH`; Worker execution requires both Sitemap flags.
