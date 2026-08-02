/**
 * Reviewable SQL predicates for P1-05B's six partial indexes. Runtime queries in
 * store.ts use these exact, family-specific shapes and never combine them with OR.
 */
export const TASK_CLAIM_SQL_CONTRACTS = {
  catalog_scan: {
    pending:
      "WITH candidates AS MATERIALIZED: status = 'pending' ORDER BY created_at, id LIMIT 128 FOR UPDATE SKIP LOCKED",
    expired:
      "WITH candidates AS MATERIALIZED: status = 'processing' AND locked_until < transaction_timestamp() ORDER BY locked_until, id LIMIT 128 FOR UPDATE SKIP LOCKED",
    pendingIndex: "catalog_scan_task_item_pending_global_idx",
    expiredIndex: "catalog_scan_task_item_expired_lease_idx",
  },
  channel_sync: {
    pending:
      "WITH candidates AS MATERIALIZED: status = 'pending' ORDER BY created_at, id LIMIT 128 FOR UPDATE SKIP LOCKED",
    expired:
      "WITH candidates AS MATERIALIZED: status = 'processing' AND locked_until < transaction_timestamp() ORDER BY locked_until, id LIMIT 128 FOR UPDATE SKIP LOCKED",
    pendingIndex: "channel_sync_task_item_pending_global_idx",
    expiredIndex: "channel_sync_task_item_expired_lease_idx",
  },
  generic: {
    pending:
      "WITH candidates AS MATERIALIZED: status = 'pending' ORDER BY created_at, id LIMIT 128 FOR UPDATE SKIP LOCKED",
    expired:
      "WITH candidates AS MATERIALIZED: status = 'processing' AND locked_until < transaction_timestamp() ORDER BY locked_until, id LIMIT 128 FOR UPDATE SKIP LOCKED",
    pendingIndex: "generic_task_item_pending_global_idx",
    expiredIndex: "generic_task_item_expired_lease_idx",
  },
} as const;
