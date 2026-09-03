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
| `FEATURE_SITEMAP_AUTO_REFRESH` | `false` | Sitemap refresh enqueue adapter | Allows a filesystem-only Sitemap refresh task to be queued after publication. Disabled means no task row is created. |
| `SITEMAP_AUTO_REFRESH_ALLOW_WRITE` | `false` | Sitemap refresh Worker handler | Allows the Worker to generate and atomically promote a static Sitemap only while `FEATURE_SITEMAP_AUTO_REFRESH` is also true. |

All flags use exact `=== "true"` parsing and default off. A catalog `dry_run` may read and build a plan when its feature flag is true, but the P1 runtime strips its protected write before finalization. Sitemap enqueue and filesystem promotion are separate gates: queuing requires `FEATURE_SITEMAP_AUTO_REFRESH`; Worker execution requires both Sitemap flags.

| `FEATURE_PROMO_LINK_CLAIM` | `false` | `src/lib/tasks/promo-link-claim.ts`'s task factory, `worker/handlers/promo-link-claim.ts` | Allows the promo-link claim task chain to run at all. The handler first performs the evidenced `getlistpc` readback; an explicitly enabled `claimPromo` capability may then permit one `getcode` mutation, followed by readback. Unknown recovery is readback-only. |
| `PROMO_LINK_CLAIM_ALLOW_WRITE` | `false` | same as above | Allows protected `PromoLink`/`SideEffectIntent` writes; both this and `FEATURE_PROMO_LINK_CLAIM` must be `true` and task mode must be `apply`. Necessary but not sufficient for the disabled `claimPromo` branch specifically — that also requires `ChannelCapability.status = 'enabled'` for capability key `claimPromo`. P0-S6 added the audited, evidence-required `scripts/set-channel-capability-status.ts` toggle; no automatic or unaudited path enables it. |

`FEATURE_PROMO_LINK_CLAIM`/`PROMO_LINK_CLAIM_ALLOW_WRITE` follow the same "一 flag 一函数、双闸" discipline and exact `=== "true"` parsing as every pair above. dry-run walks the real §3.9/§3.10 decision tree (feature flag, TTL, scope resolution, already-fetched short-circuit, existing-promo pre-read) but makes zero adapter calls and zero writes regardless of the write-allow flag — see that handler's own header comment for the full decision table.

| `PUBLIC_TRACKING_WRITE_DISABLED` | `false`（未设置 = 写入开启） | `src/lib/flags/feature-flags.ts` 的 `isPublicTrackingWriteDisabled`，唯一调用方为 `src/app/go/_lib/tracking-guard.ts` 的 `shouldRecordGoRedirect`（再由 `src/app/go/[code]/route.ts` 调用） | RC-6 安全阀：置真时 `GET /go/[code]` 不再写 `TrackingEvent` 行，跳转行为（302/404、目标 URL、`Cache-Control: no-store`）完全不受影响。用于刷量高峰或数据库写压力下的临时止血。 |

| `ADMIN_TWO_FACTOR_ENFORCEMENT` | `required`（未设置 = 强制） | `src/lib/auth/two-factor-enforcement.ts` 的 `readTwoFactorEnforcement`/`isTwoFactorEnforced`，调用方遍布 `src/lib/auth/capabilities.ts`（`requireAdminTwoFactor`）、`src/server/auth/guards.ts`（`enforceAdminSessionTwoFactor`）、`src/app/(admin)/_lib/page-guard.ts`、`src/app/(admin-auth)/login/_actions.ts`、`src/app/(admin-auth)/_lib/auth-session.ts`（`postAuthDestination`） | RC-10 全局开关：`disabled` 时后台跳过强制 2FA 注册/挑战，任何未完成 2FA 的会话都被当作已完成；`required`（默认）时行为与 RC-10 之前逐字相同。 |

`ADMIN_TWO_FACTOR_ENFORCEMENT` 取值解析也不是简单 `=== "true"`（与下面的 `PUBLIC_TRACKING_WRITE_DISABLED` 同类，但失败方向相反），单独说明：

1. **不是能力开关，是强制开关，且失败方向是"保持强制"。** 唯一能关闭 2FA 强制的值是精确（trim 后大小写不敏感）的 `disabled`；未设置、`required`、拼错的值（`Disable`/`off`/`0`/`no`）一律解析为 `required`。这是本登记表里唯一一个"认不出的值 → 更严格"的 flag——刻意如此：这是安全边界，不是普通功能开关。
2. **默认值必须是 `required`。** `.env.example`、`docker-compose.yml` 的 `web` 服务、`scripts/lib/x8-levels.json` 的 Level 0/Level R 均显式或隐式落在 `required`；唯一允许 `disabled` 的是 `scripts/lib/x8-levels.json` 的 Level UAT（`X8_LEVEL=uat` 本地拓扑）。
3. **关闭时打一次启动期告警。** `warnTwoFactorDisabledOnce()`（同文件）在进程内只 `console.error` 一次，由 `scripts/two-factor-enforcement-preflight.ts` 在 `scripts/start-web.sh` 里、`node server.js` 启动前调用；不在每次请求的 guard 里调用，避免刷屏。

`PUBLIC_TRACKING_WRITE_DISABLED` 是本登记表里**唯二的例外**，两处都是有意为之，不是疏漏：

1. **默认开而非默认关。** 上面每一个 flag 都是「能力开关」，默认关 = 能力不启用 = 安全。这一个是「停写开关」，默认关 = 写入照常发生。搬自 CPS `getTrackingWriteStatus`（`src/lib/cps-tracking.ts:42-56`，v8.3.6 `16f2e4cfca51f46af0dede899ecf6242a770bbd0`）但**默认值反转**：CPS 生产默认 `1`（`.env.example:160`、`docker-compose.yml:92`）因为它另有归因信号；本仓 `/go` 是唯一归因信号，未设置必须等于「写」。
2. **取值解析不用 `=== "true"`，而是照搬 CPS `isTruthyEnv` 的 `/^(1|true|yes|on)$/i` + `trim()`**（`src/lib/cps-tracking.ts:585-587`）。理由是失败方向：其它 flag 认不出的值 → 能力保持关闭 = 安全；这一个认不出的值 → 写入保持开启，即安全阀在最需要它的时刻静默失灵。运维在事故中按 CPS 习惯写 `on`/`yes`/`TRUE`、或在 Compose `environment:` 条目里留了尾空格（Compose 不会去掉），在严格匹配下都会变成静默 no-op。非真值（`0`/`false`/空/乱码）仍按「未停写」处理，安全默认保持为开。
