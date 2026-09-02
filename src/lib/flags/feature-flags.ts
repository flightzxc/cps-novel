export const NOVEL_CATALOG_SYNC_FEATURE_FLAG = "FEATURE_NOVEL_CATALOG_SYNC";
export const NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG = "NOVEL_CATALOG_SYNC_ALLOW_WRITE";
export const SITEMAP_AUTO_REFRESH_FEATURE_FLAG = "FEATURE_SITEMAP_AUTO_REFRESH";
export const SITEMAP_AUTO_REFRESH_ALLOW_WRITE_FLAG = "SITEMAP_AUTO_REFRESH_ALLOW_WRITE";

export function isNovelCatalogSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NOVEL_CATALOG_SYNC_FEATURE_FLAG] === "true";
}

export function isNovelCatalogSyncWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG] === "true";
}

// -----------------------------------------------------------------------
// P2-11 (Stream E, IndexNow). Two independent capabilities, each its own
// double-gate pair, per this file's "一 flag 一函数、双闸" discipline and the
// round's rollout convention ("enqueue 先行、worker 后开" —
// `P2-07-12-移植审计-2026-08-12/P2-11.md` §11 flag 6): enabling outbox writes
// before delivery lets operators inspect accumulated `indexnow_outbox` rows
// (URLs, eligibility) before the worker ever calls the real IndexNow API.
// registered: docs/governance/feature-flag-registry.md.
// -----------------------------------------------------------------------
export const INDEXNOW_OUTBOX_FEATURE_FLAG = "FEATURE_INDEXNOW_OUTBOX";
export const INDEXNOW_OUTBOX_ALLOW_WRITE_FLAG = "INDEXNOW_OUTBOX_ALLOW_WRITE";
export const INDEXNOW_DELIVERY_FEATURE_FLAG = "FEATURE_INDEXNOW_DELIVERY";
export const INDEXNOW_DELIVERY_ALLOW_WRITE_FLAG = "INDEXNOW_DELIVERY_ALLOW_WRITE";

/** Gates whether `enqueueIndexNow`'s dispatcher handler does anything at all. Off by default: a safe no-op, matching `dispatcher.ts`'s "zero handlers is a safe no-op" contract. */
export function isIndexNowOutboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INDEXNOW_OUTBOX_FEATURE_FLAG] === "true";
}

/** Second key: even with the feature on, `indexnow_outbox` rows are only written when this is also true. */
export function isIndexNowOutboxWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INDEXNOW_OUTBOX_ALLOW_WRITE_FLAG] === "true";
}

/** Gates whether the worker sweeps for due deliveries / creates `GenericTaskItem`s for them at all. */
export function isIndexNowDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INDEXNOW_DELIVERY_FEATURE_FLAG] === "true";
}

/** Second key: even with the feature on, the worker only calls the real IndexNow API / writes attempt or outcome data when this is also true. */
export function isIndexNowDeliveryWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INDEXNOW_DELIVERY_ALLOW_WRITE_FLAG] === "true";
}

export function isSitemapAutoRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SITEMAP_AUTO_REFRESH_FEATURE_FLAG] === "true";
}

export function isSitemapAutoRefreshWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SITEMAP_AUTO_REFRESH_ALLOW_WRITE_FLAG] === "true";
}

// -----------------------------------------------------------------------
// P0-S5 (promo link claim chain). Same "一 flag 一函数、双闸" discipline as
// every pair above. `FEATURE_PROMO_LINK_CLAIM` gates the whole task chain
// (task creation + worker handler) including the zero-upstream-call
// "already-existing promo read" path (`novel-v1-adapter-and-workflow-
// v0.2.1.md` §3.9). `PROMO_LINK_CLAIM_ALLOW_WRITE` additionally gates any
// protected business write and is necessary but never sufficient: that path
// also requires an operator-audited `ChannelCapability.status = 'enabled'`.
// registered: docs/governance/
// feature-flag-registry.md.
// -----------------------------------------------------------------------
export const PROMO_LINK_CLAIM_FEATURE_FLAG = "FEATURE_PROMO_LINK_CLAIM";
export const PROMO_LINK_CLAIM_ALLOW_WRITE_FLAG = "PROMO_LINK_CLAIM_ALLOW_WRITE";

/** Gates whether the promo-link claim task factory and worker handler do anything at all. */
export function isPromoLinkClaimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROMO_LINK_CLAIM_FEATURE_FLAG] === "true";
}

/** Second key: even with the feature on, protected writes and claimPromo only happen when this is also true. */
export function isPromoLinkClaimWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROMO_LINK_CLAIM_ALLOW_WRITE_FLAG] === "true";
}

// -----------------------------------------------------------------------
// RC-6 (`/go` redirect tracking write gate). Semantics ported from CPS
// `getTrackingWriteStatus`/`isPublicTrackingWriteDisabled`
// (`src/lib/cps-tracking.ts:42-56`, v8.3.6 `16f2e4cfca51f46af0dede899ecf6242a770bbd0`),
// collapsed to a single flag: CPS ORs two independent env vars
// (`CPS_PUBLIC_TRACKING_WRITE_DISABLED` / `CPS_TRACKING_DISABLED`) because it
// has several tracked event types; `/go` is this project's only write path,
// so one flag is enough. registered: docs/governance/feature-flag-registry.md.
//
// Deliberately inverted default from CPS. CPS ships this closed by default
// (`.env.example`/`docker-compose.yml` both default `CPS_PUBLIC_TRACKING_WRITE_DISABLED`
// to `1`) because CPS has richer attribution signals elsewhere and treats
// public tracking as opt-in. `/go` is this project's *only* attribution
// signal, so unset must mean writes stay ON here — the opposite of CPS's
// safe-closed default.
//
// Exact-match parsing (`"1"` or `"true"`), matching this file's
// `一 flag 一函数、=== "true"` discipline rather than CPS's regex-based
// `isTruthyEnv`. An unrecognized value (e.g. "false", "0", "yes", garbage)
// is treated as "not disabled" rather than fail-fast throwing: this flag's
// safe default is open (writes on), so a misconfigured value must not
// silently kill the only attribution signal.
// -----------------------------------------------------------------------
export const PUBLIC_TRACKING_WRITE_DISABLED_FLAG = "PUBLIC_TRACKING_WRITE_DISABLED";

/** Default (unset) is false — tracking writes stay ON. Only "1" or "true" turns them off. */
export function isPublicTrackingWriteDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[PUBLIC_TRACKING_WRITE_DISABLED_FLAG];
  return value === "1" || value === "true";
}
