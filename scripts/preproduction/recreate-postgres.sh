#!/usr/bin/env bash
set -euo pipefail
set +x

# Capacity work order (Owner 2026-09-27): the ONLY sanctioned way to apply an
# infra/postgres/pitr/postgresql.conf.example edit (or a postgres-service
# compose change such as shm_size) to a RUNNING preproduction/production
# cluster on haiyue-vps.
#
# 🔴 Why this script has to exist at all: scripts/preproduction/release.sh's
# deploy() and rollback() never touch the postgres service (see that file's
# own comment: "这里不碰 postgres 服务、不动 cps_novel_postgres_data 卷、不恢复
# 任何备份"). postgresql.conf and shm_size are both read only when the
# postgres CONTAINER is (re)created -- `docker compose restart` re-execs the
# same container with the same already-resolved config, it does not re-read
# a changed bind-mount source or re-apply a changed shm_size. So a
# postgresql.conf.example edit sitting in a merged release is otherwise
# invisible forever, on a cluster that (as of 2026-09-27, read-only ssh)
# hasn't had its postgres container recreated since 2026-09-22.
#
# 🔴 The postgres container's `postgresql.conf`/init-script bind mounts
# resolve to THIS invocation's own release directory on disk (verified
# live, 2026-09-27: the running container's mount source is the literal
# path of the release directory it was created from, e.g.
# /opt/cps-novel/releases/<commit>/infra/postgres/pitr/postgresql.conf.example
# -- NOT a symlink such as /opt/cps-novel/current that could later move out
# from under it). That release directory must therefore not be deleted
# until the NEXT time this script recreates the container -- deleting it
# out from under a running postgres container that still has it bind-mounted
# either breaks the mount or (depending on the host's bind-mount semantics)
# silently keeps serving the old inode with no path left to inspect it from.
# Whatever release directory this script was run from is the one to keep
# until this script is run again from a different one.
#
# What this script deliberately does NOT do: run `prisma migrate deploy`,
# replay infra/postgres/grants.sql, or touch the cps_novel_postgres_data
# volume in any way. It recreates the postgres CONTAINER only -- same image,
# same volume, same secrets, new config file content / shm_size picked up
# from whatever release checkout this script is invoked from (the runbook
# convention already established for rollback: invoke from the release
# directory whose files you want applied).
#
# Preconditions this script enforces (fail-closed, matching the rest of this
# directory's style):
#   1) PREPROD_RECREATE_POSTGRES_CONFIRMED=YES -- an explicit, separate
#      confirmation from Owner approval to run this AT ALL (mirrors
#      PREPROD_CONFIRM_EMPTY_VOLUME / PREPROD_APPROVED_MIGRATION elsewhere in
#      this directory). This is NOT a substitute for Owner's own approval to
#      change the target machine -- it only prevents an accidental bare
#      invocation from doing anything.
#   1b) The promo-claim batch pause gate (Opus review round 3, 2026-09-27;
#      🔴 CORRECTED 2026-09-27 after a production read-only audit found the
#      first-round implementation checked a query shape that can never match
#      a real row -- see the correction note below the derivation). Every
#      condition below is traced to its own code definition, not guessed:
#        - A "batch" is a `generic_task` row with `task_type =
#          'batch.materialize.v1'` (src/lib/tasks/catalog-batch.ts:12,
#          CATALOG_BATCH_TASK_TYPE) -- this is what `lockLifecycleBatch`
#          actually looks up (src/lib/tasks/promo-claim-batch-control.ts:
#          115-119, `WHERE id = ... AND task_type = ${CATALOG_BATCH_TASK_TYPE}`).
#          A "shard" is a *child* `generic_task` row with `task_type =
#          'promo_link.claim.v1'` (src/lib/tasks/promo-link-claim-
#          limits.ts:21, PROMO_LINK_CLAIM_TASK_TYPE) and `parent_task_id`
#          equal to the batch's id (src/lib/tasks/promo-claim-batch-
#          control.ts:128-142, `lockChildShards`'s WHERE clause: `parent_task_id
#          = ${batchId}::uuid AND task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}`).
#          Batch and shard are two DIFFERENT task_type values in the SAME
#          `generic_task` table, linked by `parent_task_id` -- there is no
#          separate batch/shard table.
#        - 🔴 First-round bug (found 2026-09-27, production read-only audit):
#          the original query here defined "batch" as `task_type =
#          'promo_link.claim.v1' AND parent_task_id IS NULL` -- but per the
#          code citations above, a row with `task_type = 'promo_link.claim.v1'`
#          is ALWAYS a shard (it only ever gets created as a child of a
#          `batch.materialize.v1` row); no batch row has ever had, or can
#          ever have, that task_type. The query therefore matched zero rows
#          on every real host, always printed a trivial PASS, and never
#          checked anything -- confirmed live in production, 2026-09-27:
#          batch eba8f359-a569-43d7-bb55-b71fecc02f6e (status=paused) plus 7
#          other `batch.materialize.v1` parents (all status=completed) all
#          have `promo_link.claim.v1` children, and zero rows anywhere in
#          `generic_task` have `task_type = 'promo_link.claim.v1' AND
#          parent_task_id IS NULL`.
#        - `pausePromoClaimBatchTx` (src/lib/tasks/promo-claim-batch-
#          control.ts:183-218) is what "暂停" actually writes: it sets the
#          BATCH row's own `status` column to exactly `"paused"`
#          (lines 197-200, `tx.genericTask.update({ where: { id: batch.id },
#          data: { status: "paused", ... } })`), then cascades the same
#          `"paused"` status to any of its shards that were currently
#          `pending`/`processing` (lines 204-210) -- shards still queued as
#          `disabled` are left alone. Completed, cancelled, disabled, and
#          paused batches must all NOT block this script; only a batch or
#          shard genuinely mid-flight (`pending`/`processing`) is unsafe to
#          recreate postgres under. This script therefore does not check for
#          the literal string `'paused'` on every batch (that would wrongly
#          refuse on the 7 already-`completed` historical batches) -- it
#          checks that nothing with `promo_link.claim.v1` children is
#          currently `pending`/`processing`, matching `ACTIVE_TASK_STATUSES =
#          ["pending","processing"]` (src/lib/tasks/promo-claim-
#          release.ts:63) applied to the PARENT row.
#      The three conditions actually checked, all independent (any one
#      failing refuses):
#        (a) 有 `promo_link.claim.v1` 子任务的父任务里，没有任何一条处于
#            `pending`/`processing`（即：EXISTS 一个 promo_link.claim.v1 子
#            任务的 generic_task 父行，其自身 status 不属于 pending/processing
#            之外的任何值都放行——已完成/已取消/disabled/paused 的父任务均
#            不阻断，只有父任务自己正在 pending/processing 才阻断）。
#        (b) `promo_link.claim.v1` 任务（批次下的分片本身，不论 parent_task_id
#            是什么）没有任何一条处于 `pending`/`processing`
#            （`ACTIVE_TASK_STATUSES`，src/lib/tasks/promo-claim-
#            release.ts:63，`runPromoClaimReleaseTick` 自己用来判定"正在运行"
#            的同一个常量）。这条独立于 (a) 单独检查——防的是分片行因故未随
#            批次暂停正确级联的情况。
#        (c) `side_effect_intent` 没有任何一条处于非终态
#            （`prepared`/`claim_retry_blocked`）。该表只被推广领取代码创建
#            和消费（grepped：只有 worker/handlers/promo-link-claim.ts 与
#            src/lib/tasks/promo-claim-release.ts 读写它），终态集合是
#            `confirmed`/`failed`/`manual_review_required`
#            （src/lib/tasks/side-effect-intent.ts:107-110，
#            `isAllowedSideEffectTransition` 自己的注释："`manual_review_
#            required`, `confirmed` and `failed` are terminal for the generic
#            worker graph"）；非终态因此恰好是 `prepared`/
#            `claim_retry_blocked`，与 `READBACK_CONFIRMABLE_STATUSES`
#            （同文件 152 行）独立给出的"仍可转移"集合逐字一致——两处交叉核对过，
#            未改动。
#      已完成、已取消、disabled、paused 的父任务都不阻断——只有 (a)/(b)/(c)
#      三条中任意一条命中非零才拒绝。
#      Implemented as `assert_promo_claim_batch_paused()` below, run as the
#      FIRST check (before any service is stopped) -- read-only, so there is
#      no reason to wait, and refusing before touching anything is strictly
#      safer than refusing partway through.
#   2) Claim-generating services (scheduler, worker, worker-light) are
#      stopped BEFORE this script checks for in-flight work, so "in-flight
#      count is zero" cannot be invalidated by a worker grabbing new work a
#      moment later -- this script does the stopping itself rather than
#      trusting an operator's out-of-band claim.
#   3) Zero rows with status='processing' in either lease-based task-item
#      table that BLOCKS this script: generic_task_item, channel_sync_task_item.
#      🔴 catalog_scan_task_item does NOT exist -- migration
#      20260907091500_p3_drop_catalog_scan_task dropped it (and its parent
#      catalog_scan_task) on 2026-09-07; catalog-scan work has lived
#      entirely in generic_task/generic_task_item (task_type='catalog_scan')
#      since. A prior draft of this script's review raised
#      catalog_scan_task_item as a third table to block on; it was checked
#      against prisma/schema.prisma and the migration history and does not
#      exist in the current schema, so it is not queried here. Two OTHER
#      tables (indexnow_outbox, home_carousel_auto_batch) also have a
#      `processing`-shaped status column, but their own worker/scan logic
#      already reclaims a stale `processing` row on its own (indexnow
#      delivery retries; home_carousel's batch compute is a single
#      transaction that never actually persists a `processing` row in
#      practice -- see src/server/home-carousel/service.ts's own comment).
#      Their counts are printed for operator visibility ONLY and never
#      block this script.
#      A worker that is SIGTERM'd mid-item is expected (worker/index.ts's
#      drain handling) to release its lease back to 'pending', not leave it
#      'processing' -- a non-zero count in either BLOCKING table means
#      something did not drain cleanly, and this script refuses rather than
#      guessing it is safe to proceed under a stuck lease.
#   4) A fresh, verified, ON-LINE logical backup is taken immediately before
#      the recreate, in addition to whatever the daily backup-timer last
#      produced -- belt-and-suspenders immediately ahead of an operation
#      that, however carefully scoped, still stops and restarts the
#      cluster's own container.
#
# 🔴 Fingerprint timing (fixed after first-round review, 2026-09-27): the
# per-table row-count fingerprint is taken AFTER every application service
# (scheduler, worker, worker-light, web) has been stopped, not before. Taken
# earlier, it would be racing live writes -- scheduler writes schedule_run
# every tick, worker writes task items, web writes operation_audit -- so
# "before" and "after" would almost never match on a host with real traffic,
# and this script would report a false fingerprint_mismatch and abort with
# the database already recreated and every application service stopped,
# i.e. leave the site down. scripts/db/backup-logical.sh (pg_dump + a
# read-only `pg_restore --list` against the dump FILE + a read-only `SHOW
# server_version`) performs no write of its own, so taking the fingerprint
# immediately after all four services are down and before the backup is
# equally safe as taking it after the backup -- this script takes it right
# after stopping web, the earliest point at which it is safe.
#
# Usage (run from the release checkout root whose postgresql.conf.example /
# compose shm_size you want the running cluster to pick up):
#   PREPROD_RECREATE_POSTGRES_CONFIRMED=YES \
#     scripts/preproduction/recreate-postgres.sh
#
# Rolling back to a previous release's postgres config: invoke THIS SAME
# subcommand from that previous release's own checkout (its own
# postgresql.conf.example / compose shm_size is what gets applied), passing
# PREPROD_RECREATE_EXPECT_* overrides that match ITS values instead of this
# checkout's -- every expected-value default below can be overridden this
# way. See docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md's "Failure
# and rollback" section for the exact override set that reproduces
# out-of-the-box Postgres defaults (i.e. rolling back to a pre-this-branch
# checkout) and a real local rehearsal of that exact path.
#
# Expected downtime: see docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md
# "Controlled postgres recreate" section for the measured local-rehearsal
# figure this script's own RECREATE_POSTGRES_DOWNTIME_SECONDS line is
# expected to land near on the real host.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"
preprod_load_env

fail() { echo "RECREATE_POSTGRES=FAIL reason=$1"; exit "${2:-65}"; }

[[ "${PREPROD_RECREATE_POSTGRES_CONFIRMED:-}" == "YES" ]] || fail confirmation_required

expected_shared_buffers="${PREPROD_RECREATE_EXPECT_SHARED_BUFFERS:-4GB}"
expected_effective_cache_size="${PREPROD_RECREATE_EXPECT_EFFECTIVE_CACHE_SIZE:-10GB}"
expected_work_mem="${PREPROD_RECREATE_EXPECT_WORK_MEM:-16MB}"
expected_maintenance_work_mem="${PREPROD_RECREATE_EXPECT_MAINTENANCE_WORK_MEM:-512MB}"
expected_random_page_cost="${PREPROD_RECREATE_EXPECT_RANDOM_PAGE_COST:-1.1}"
expected_effective_io_concurrency="${PREPROD_RECREATE_EXPECT_EFFECTIVE_IO_CONCURRENCY:-200}"
expected_max_parallel_workers_per_gather="${PREPROD_RECREATE_EXPECT_MAX_PARALLEL_WORKERS_PER_GATHER:-2}"
expected_max_worker_processes="${PREPROD_RECREATE_EXPECT_MAX_WORKER_PROCESSES:-8}"
expected_max_parallel_workers="${PREPROD_RECREATE_EXPECT_MAX_PARALLEL_WORKERS:-4}"
expected_max_connections="${PREPROD_RECREATE_EXPECT_MAX_CONNECTIONS:-100}"
expected_shm_size_bytes="${PREPROD_RECREATE_EXPECT_SHM_SIZE_BYTES:-1073741824}"

psql_admin() {
  preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -U postgres -d cps_novel -Atqc "$1"
}

# --- Promo-claim batch pause gate (see this file's header comment,
# precondition 1b, for the full derivation and code citations behind every
# condition below). Read-only; run first, before anything is stopped.
assert_promo_claim_batch_paused() {
  local active_parent_batches active_claim_tasks non_terminal_intents
  # (a) -- parents (any status) that have at least one promo_link.claim.v1
  # child, restricted to those parents currently pending/processing. See
  # this file's header comment, precondition 1b, for the full derivation and
  # why this replaced the first-round query (task_type='promo_link.claim.v1'
  # AND parent_task_id IS NULL) that could never match a real row.
  active_parent_batches="$(psql_admin "SELECT count(*) FROM generic_task b WHERE b.status IN ('pending','processing') AND EXISTS (SELECT 1 FROM generic_task s WHERE s.parent_task_id = b.id AND s.task_type = 'promo_link.claim.v1')")" \
    || fail promo_claim_gate_query_failed
  # (b) -- the shards themselves (src/lib/tasks/promo-claim-release.ts:63,
  # ACTIVE_TASK_STATUSES). Unchanged from the first round.
  active_claim_tasks="$(psql_admin "SELECT count(*) FROM generic_task WHERE task_type = 'promo_link.claim.v1' AND status IN ('pending','processing')")" \
    || fail promo_claim_gate_query_failed
  # (c) -- non-terminal side-effect intents (src/lib/tasks/side-effect-
  # intent.ts:107-110 / 152). Unchanged from the first round.
  non_terminal_intents="$(psql_admin "SELECT count(*) FROM side_effect_intent WHERE status IN ('prepared','claim_retry_blocked')")" \
    || fail promo_claim_gate_query_failed
  if [[ "$active_parent_batches" != "0" || "$active_claim_tasks" != "0" || "$non_terminal_intents" != "0" ]]; then
    fail "promo_claim_batch_not_paused active_parent_batches=$active_parent_batches active_claim_tasks=$active_claim_tasks non_terminal_side_effect_intents=$non_terminal_intents"
  fi
  echo "RECREATE_POSTGRES_PROMO_CLAIM_GATE=PASS active_parent_batches=0 active_claim_tasks=0 non_terminal_side_effect_intents=0"
}

# --- Failure-path diagnostics (review fix, 2026-09-27): on ANY non-success
# exit, print exactly what an operator needs to triage without re-deriving
# it from scratch -- current service status, whether postgres itself was
# already recreated (the point of no return for "just restart the old
# container" being an option), and the exact commands to bring the
# application back up. `recreate_succeeded`/`postgres_recreated` are plain
# globals (this script has no functions that need their own scope for these)
# flipped at the two points below that make them true; the trap fires on
# every exit path (`fail`'s own `exit`, an unhandled command failure under
# `set -e`, Ctrl-C) and does nothing when the run actually succeeded.
recreate_succeeded=0
postgres_recreated=0
on_exit() {
  local exit_code=$?
  (( recreate_succeeded == 1 )) && return 0
  {
    echo "RECREATE_POSTGRES=FAILED_TRAP exit_code=$exit_code"
    echo "--- service status at failure (preprod_compose ps) ---"
    preprod_compose ps 2>&1 || echo "(preprod_compose ps itself failed)"
    if (( postgres_recreated == 1 )); then
      echo "--- postgres_recreated=YES: the container has already been stopped, removed, and recreated from this checkout's config -- 'restart the old container' is no longer an option, only forward (fix and retry) or a rollback invocation (see this script's own header comment and the runbook's 'Failure and rollback' section) ---"
    else
      echo "--- postgres_recreated=NO: postgres itself was not touched (or the failure happened before reaching that step) ---"
    fi
    echo "--- to bring the application back up, from this same checkout root: ---"
    echo "  source scripts/preproduction/lib.sh && preprod_load_env"
    echo "  preprod_compose_app_up web && preprod_wait_for_service_health web"
    echo "  preprod_compose_app_up worker worker-light && preprod_compose_app_up scheduler"
    echo "  preprod_wait_for_service_health worker worker-light scheduler"
  } >&2
}
trap on_exit EXIT

# Run the pause gate now that the trap is installed, so a refusal here gets
# the same diagnostic dump as any later failure (harmless at this point --
# nothing has been touched yet, so it prints "postgres_recreated=NO" and
# every service still in its normal running state).
assert_promo_claim_batch_paused

# --- 0) volume identity must already be the stable named volume, unchanged
# by anything this script is about to do. Recorded again after recreate.
docker volume inspect cps_novel_postgres_data >/dev/null 2>&1 || fail volume_missing
volume_created_before="$(docker volume inspect cps_novel_postgres_data --format '{{.CreatedAt}}')"

fingerprint_sql="SELECT md5(string_agg(tablename || '=' || cnt::text, ',' ORDER BY tablename)) FROM (SELECT tablename, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', tablename), false, true, '')))[1]::text::bigint AS cnt FROM pg_tables WHERE schemaname = 'public') t;"

# --- 1) stop claim-generating services FIRST so the in-flight check below
# cannot be invalidated by new work being picked up between the check and
# the actual recreate. Same stop ordering release.sh already uses.
preprod_compose stop scheduler
preprod_compose stop worker worker-light

processing_generic="$(psql_admin "SELECT count(*) FROM generic_task_item WHERE status = 'processing'")" || fail processing_check_failed
processing_channel_sync="$(psql_admin "SELECT count(*) FROM channel_sync_task_item WHERE status = 'processing'")" || fail processing_check_failed
if [[ "$processing_generic" != "0" || "$processing_channel_sync" != "0" ]]; then
  fail "in_flight_work_present generic_task_item=$processing_generic channel_sync_task_item=$processing_channel_sync"
fi
# Informational only -- these two are self-reclaiming (see the header
# comment's precondition 3) and never block this script.
processing_indexnow="$(psql_admin "SELECT count(*) FROM indexnow_outbox WHERE status = 'processing'")" || fail processing_check_failed
processing_carousel="$(psql_admin "SELECT count(*) FROM home_carousel_auto_batch WHERE status = 'processing'")" || fail processing_check_failed
echo "RECREATE_POSTGRES_PRECHECK=PASS generic_task_item_processing=0 channel_sync_task_item_processing=0 indexnow_outbox_processing=$processing_indexnow(non_blocking) home_carousel_auto_batch_processing=$processing_carousel(non_blocking)"

# --- 2) stop web too -- release.sh's own precedent: no application service
# should be mid-query against a postgres process that is about to stop.
web_stop_epoch="$(date -u '+%s')"
preprod_compose stop web

# --- 3) data fingerprint, taken here (see this file's header comment on
# fingerprint timing) -- every application service is now stopped, so this
# is the earliest point at which "before" and "after" are comparing the
# same, quiescent data rather than racing live writes.
fingerprint_before="$(psql_admin "$fingerprint_sql")" || fail fingerprint_before_failed
[[ -n "$fingerprint_before" ]] || fail fingerprint_before_empty

# --- 4) fresh on-line logical backup immediately ahead of the recreate,
# additional to whatever backup-timer's own daily run last produced. Reuses
# the exact proven script (scripts/db/backup-logical.sh) via the
# already-running backup-timer container, which already carries
# PGHOST/PGUSER=backup_role/PGPASSFILE and the script mount -- no new
# secrets or scripts needed. (Read-only against the database -- see this
# file's header comment on fingerprint timing -- so it does not matter that
# this runs after the fingerprint rather than before.)
pre_recreate_stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
pre_recreate_backup="/var/lib/cps-novel/backups/logical/cps-novel-${pre_recreate_stamp}-pre-recreate.dump"
preprod_compose exec -T backup-timer /bin/bash /app/scripts/db/backup-logical.sh --output "$pre_recreate_backup" || fail pre_recreate_backup_failed
echo "RECREATE_POSTGRES_BACKUP=PASS output=$pre_recreate_backup"

# --- 5) recreate the postgres CONTAINER only. `stop` + `rm` (no -v) never
# touches a named/external volume -- cps_novel_postgres_data is declared
# `name: cps_novel_postgres_data` in infra/preproduction/docker-compose.yml,
# i.e. it is referenced by name, not owned by this specific container
# instance. `up -d --no-deps postgres` recreates it from THIS invocation's
# merged config (this checkout's postgresql.conf.example content and
# shm_size), same as every other preprod_compose_app_up call already relies
# on for the application services.
preprod_compose stop postgres
preprod_compose rm -f postgres
preprod_compose up -d --no-deps postgres
postgres_recreated=1

# Explicit health wait -- same reasoning as preprod_wait_for_service_health's
# own header comment: `up -d` only waits on DEPENDENCIES' healthchecks, not
# the service just started.
preprod_wait_for_service_health postgres || fail postgres_health_wait_failed

# --- 6) prove the volume was not recreated -- identical CreatedAt.
volume_created_after="$(docker volume inspect cps_novel_postgres_data --format '{{.CreatedAt}}')"
[[ "$volume_created_before" == "$volume_created_after" ]] || fail "volume_identity_changed before=$volume_created_before after=$volume_created_after"

# --- 7) read every tuned GUC back from the now-running container and prove
# it matches what was intended -- "SHOW" is the whole point of "controlled".
show_and_check() {
  local guc="$1" expected="$2" actual
  actual="$(psql_admin "SHOW $guc")" || fail "show_failed guc=$guc"
  [[ "$actual" == "$expected" ]] || fail "guc_mismatch guc=$guc expected=$expected actual=$actual"
  echo "RECREATE_POSTGRES_GUC=PASS $guc=$actual"
}
show_and_check shared_buffers "$expected_shared_buffers"
show_and_check effective_cache_size "$expected_effective_cache_size"
show_and_check work_mem "$expected_work_mem"
show_and_check maintenance_work_mem "$expected_maintenance_work_mem"
show_and_check random_page_cost "$expected_random_page_cost"
show_and_check effective_io_concurrency "$expected_effective_io_concurrency"
show_and_check max_parallel_workers_per_gather "$expected_max_parallel_workers_per_gather"
show_and_check max_worker_processes "$expected_max_worker_processes"
show_and_check max_parallel_workers "$expected_max_parallel_workers"
show_and_check max_connections "$expected_max_connections"

postgres_cid="$(preprod_compose ps -q postgres | head -1)"
[[ -n "$postgres_cid" ]] || fail postgres_container_missing_after_up
actual_shm_size="$(docker inspect "$postgres_cid" --format '{{.HostConfig.ShmSize}}')"
[[ "$actual_shm_size" == "$expected_shm_size_bytes" ]] || fail "shm_size_mismatch expected=$expected_shm_size_bytes actual=$actual_shm_size"
echo "RECREATE_POSTGRES_SHM=PASS bytes=$actual_shm_size"

# --- 8) data fingerprint after -- must be byte-for-byte identical. This is
# the "数据完整（前后行数/校验一致）" proof: not a probabilistic sample, every
# public table's exact row count, hashed.
fingerprint_after="$(psql_admin "$fingerprint_sql")" || fail fingerprint_after_failed
[[ "$fingerprint_before" == "$fingerprint_after" ]] || fail "fingerprint_mismatch before=$fingerprint_before after=$fingerprint_after"
echo "RECREATE_POSTGRES_FINGERPRINT=PASS md5=$fingerprint_after"

# --- 9) bring the application back, same order release.sh uses, each with
# an explicit health wait (up -d only waits on DEPENDENCIES' healthchecks).
preprod_compose_app_up web || fail web_up_failed
preprod_wait_for_service_health web || fail web_health_wait_failed
web_healthy_epoch="$(date -u '+%s')"

# Full role/grant/privilege contract re-check now that web can reach
# postgres again -- proves the recreate did not silently disturb anything
# database.sh's own persistent-check already guards on every deploy.
"$root/scripts/preproduction/database.sh" persistent-check || fail persistent_check_failed

preprod_compose_app_up worker worker-light || fail worker_up_failed
preprod_compose_app_up scheduler || fail scheduler_up_failed
preprod_wait_for_service_health worker worker-light scheduler || fail worker_scheduler_health_wait_failed

downtime_seconds=$(( web_healthy_epoch - web_stop_epoch ))
echo "RECREATE_POSTGRES_DOWNTIME_SECONDS=$downtime_seconds"
recreate_succeeded=1
echo "RECREATE_POSTGRES=PASS"
