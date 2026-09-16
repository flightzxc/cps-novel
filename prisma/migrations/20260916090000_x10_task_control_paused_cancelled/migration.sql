-- X10 task control (pause/resume/abort): promotes `paused`/`cancelled` from
-- an interim `status = 'disabled'` + `result.taskControl` JSON marker
-- workaround (`src/lib/tasks/task-control.ts`) to two real values in
-- `generic_task_status_check`/`channel_sync_task_status_check`.
--
-- Why the interim shape existed: `20260803090000_p1_initial_schema` (lines
-- 1231/1234) froze both CHECKs to exactly six values with no room for a
-- dedicated `paused`/`cancelled` literal, and the pause/resume/abort feature
-- was built under an explicit "no schema migration" constraint. It reused
-- `disabled` (already the only "administratively pulled out of the runnable
-- set" bucket) for manual pause, manual abort, *and* the worker's own
-- first-occurrence system hold (`worker/handlers/promo-link-claim-system-hold.ts`),
-- distinguishing the three (plus three pre-existing, unrelated `disabled`
-- meanings) only via a `result.taskControl.kind` JSON marker.
--
-- The Owner has now explicitly approved a schema migration to replace that
-- workaround for the two *manual* operations: pause writes `status =
-- 'paused'`, abort writes `status = 'cancelled'`. Status determination reads
-- this column directly from now on; the JSON marker is retained purely as
-- audit metadata (who/why), never as the source of truth for what state a
-- row is in.
--
-- The worker's own system hold deliberately keeps writing `status =
-- 'disabled'` (+ marker) -- it is unchanged by this migration and out of
-- scope for it (see this migration's companion work order). `disabled`
-- therefore stays in both CHECKs unchanged; this migration only adds the two
-- new values alongside it. The 271 pre-existing legacy `disabled` rows, the
-- feature-flag-off-at-creation `disabled` rows, and the catalog-batch
-- double-gate `disabled` rows are untouched -- no data is rewritten by this
-- migration, only the constraint's allowed-value set changes.
--
-- Drop + re-add, no data changes -- same shape as
-- `20260906090000_p2_02b_article_template_cps_parity`'s
-- `article_template_status_check` fix and
-- `20260912100000_carousel_serving_source_check_fix`'s
-- `home_carousel_serving_source_check` fix.
ALTER TABLE "channel_sync_task" DROP CONSTRAINT "channel_sync_task_status_check";
ALTER TABLE "channel_sync_task" ADD CONSTRAINT "channel_sync_task_status_check"
  CHECK ("status" IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'disabled', 'paused', 'cancelled'));

ALTER TABLE "generic_task" DROP CONSTRAINT "generic_task_status_check";
ALTER TABLE "generic_task" ADD CONSTRAINT "generic_task_status_check"
  CHECK ("status" IN ('pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'disabled', 'paused', 'cancelled'));
