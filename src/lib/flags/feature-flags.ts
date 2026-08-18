export const NOVEL_CATALOG_SYNC_FEATURE_FLAG = "FEATURE_NOVEL_CATALOG_SYNC";
export const NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG = "NOVEL_CATALOG_SYNC_ALLOW_WRITE";

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
