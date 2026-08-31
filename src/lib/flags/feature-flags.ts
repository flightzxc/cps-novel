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
