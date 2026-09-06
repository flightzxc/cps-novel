/**
 * Reviewable SQL predicates for P1-05B's partial indexes. Runtime queries in
 * store.ts use these exact, family-specific shapes and never combine them
 * with OR.
 *
 * Phase C (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md`):
 * collapsed from three families to two — `catalog_scan` is now a
 * `GenericTask.taskType` value, not a physical family; its former
 * `catalog_scan_task_item_pending_global_idx`/`catalog_scan_task_item_expired_lease_idx`
 * indexes were dropped with the table (C-4). The `generic` claim query below
 * additionally excludes a `catalog_page` item whose same-task, lower-numbered
 * sibling is still pending/processing (the sequential page-ordering
 * invariant CatalogScan's own family used to enforce) — see
 * `src/lib/tasks/store.ts`'s `selectPending`.
 */
export const TASK_CLAIM_SQL_CONTRACTS = {
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
      "WITH candidates AS MATERIALIZED: status = 'pending' AND (target_type <> 'catalog_page' OR NOT EXISTS(earlier pending/processing catalog_page sibling)) ORDER BY created_at, id LIMIT 128 FOR UPDATE SKIP LOCKED",
    expired:
      "WITH candidates AS MATERIALIZED: status = 'processing' AND locked_until < transaction_timestamp() ORDER BY locked_until, id LIMIT 128 FOR UPDATE SKIP LOCKED",
    pendingIndex: "generic_task_item_pending_global_idx",
    expiredIndex: "generic_task_item_expired_lease_idx",
  },
} as const;
