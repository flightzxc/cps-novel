-- Phase C (task model migration), step C-1: schema-first, no drop.
--
-- `TASK_ARCHITECTURE_DECISION = MIGRATE_TO_CPS_TASK_MODEL`
-- (`CPS海阅_短剧到小说全链路Parity审计与收敛规划_2026-09-06.md` §4/§0):
-- `CatalogScanTask`/`CatalogScanTaskItem` are being folded into
-- `GenericTask`/`GenericTaskItem` (`task_type = 'catalog_scan'`,
-- `generic_task_item.target_type = 'catalog_page'`). This migration only adds
-- two partial indexes on `generic_task`, equivalent to the two existing
-- `catalog_scan_task` indexes referenced by the work order
-- (`catalog_scan_status_created_idx`, `catalog_scan_scope_idx`;
-- `prisma/schema.prisma:728-729`), so list/detail and active-scope lookups for
-- catalog-scan rows keep the same access-path shape once the application
-- layer starts writing `generic_task` instead of `catalog_scan_task`.
--
-- Does NOT touch `catalog_scan_task`/`catalog_scan_task_item` in any way, does
-- NOT drop any table or column, and does NOT change any CHECK/FK. The item-level
-- claim/expired-lease access paths need no new index: `generic_task_item`'s
-- existing `generic_task_item_target_key` UNIQUE(task_id, target_type,
-- target_id) already covers `(task_id, page_index)` uniqueness, and the
-- existing `generic_task_active_scope_uidx` UNIQUE(task_type,
-- channel_account_id, channel_app_id, operation_scope_hash) WHERE status IN
-- ('pending','processing') already covers the single-active-scan-per-scope
-- exclusivity that `catalog_scan_active_scope_uidx` used to provide, once the
-- application layer folds `project_type` into `operation_scope_hash` for
-- `task_type = 'catalog_scan'` rows (see C-2).
--
-- Both indexes below are scoped with `WHERE task_type = 'catalog_scan'` so
-- they add zero overhead to every other `generic_task` row and never compete
-- with `generic_task_claim_idx`/`generic_task_account_app_idx`.

-- Equivalent to `catalog_scan_status_created_idx` (status, created_at):
-- supports `/tasks` list/detail ordering for catalog-scan rows once they live
-- in `generic_task`.
CREATE INDEX "generic_task_catalog_scan_status_created_idx"
  ON "generic_task" ("status", "created_at")
  WHERE "task_type" = 'catalog_scan';

-- Equivalent to `catalog_scan_scope_idx` (channel_account_id, channel_app_id,
-- project_type): `project_type` is not a physical column on `generic_task`
-- (it moves into `params` JSONB per C-2), so the third key is the same value
-- read as an integer expression off `params->>'projectType'`.
CREATE INDEX "generic_task_catalog_scan_scope_idx"
  ON "generic_task" ("channel_account_id", "channel_app_id", (("params"->>'projectType')::int))
  WHERE "task_type" = 'catalog_scan';
