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
#   2) Claim-generating services (scheduler, worker, worker-light) are
#      stopped BEFORE this script checks for in-flight work, so "in-flight
#      count is zero" cannot be invalidated by a worker grabbing new work a
#      moment later -- this script does the stopping itself rather than
#      trusting an operator's out-of-band claim.
#   3) Zero rows with status='processing' in either lease-based task-item
#      table (generic_task_item, channel_sync_task_item) after those
#      services are stopped and have had their stop_grace_period to drain.
#      A worker that is SIGTERM'd mid-item is expected (worker/index.ts's
#      drain handling) to release its lease back to 'pending', not leave it
#      'processing' -- a non-zero count here means something did NOT drain
#      cleanly, and this script refuses rather than guessing it is safe to
#      proceed under a stuck lease.
#   4) A fresh, verified, ON-LINE logical backup is taken immediately before
#      the recreate, in addition to whatever the daily backup-timer last
#      produced -- belt-and-suspenders immediately ahead of an operation
#      that, however carefully scoped, still stops and restarts the
#      cluster's own container.
#
# Usage (run from the release checkout root whose postgresql.conf.example /
# compose shm_size you want the running cluster to pick up):
#   PREPROD_RECREATE_POSTGRES_CONFIRMED=YES \
#     scripts/preproduction/recreate-postgres.sh
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

# --- 0) volume identity must already be the stable named volume, unchanged
# by anything this script is about to do. Recorded again after recreate.
docker volume inspect cps_novel_postgres_data >/dev/null 2>&1 || fail volume_missing
volume_created_before="$(docker volume inspect cps_novel_postgres_data --format '{{.CreatedAt}}')"

# --- 1) data fingerprint before touching anything: exact row counts across
# every public table, order-independent, hashed. query_to_xml/xpath is the
# standard one-shot idiom for "COUNT(*) on every table in one query" without
# hand-rolling a PL/pgSQL loop that would need its own error handling.
fingerprint_sql="SELECT md5(string_agg(tablename || '=' || cnt::text, ',' ORDER BY tablename)) FROM (SELECT tablename, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', tablename), false, true, '')))[1]::text::bigint AS cnt FROM pg_tables WHERE schemaname = 'public') t;"
fingerprint_before="$(psql_admin "$fingerprint_sql")" || fail fingerprint_before_failed
[[ -n "$fingerprint_before" ]] || fail fingerprint_before_empty

# --- 2) stop claim-generating services FIRST so the in-flight check below
# cannot be invalidated by new work being picked up between the check and
# the actual recreate. Same stop ordering release.sh already uses.
preprod_compose stop scheduler
preprod_compose stop worker worker-light

processing_generic="$(psql_admin "SELECT count(*) FROM generic_task_item WHERE status = 'processing'")" || fail processing_check_failed
processing_channel_sync="$(psql_admin "SELECT count(*) FROM channel_sync_task_item WHERE status = 'processing'")" || fail processing_check_failed
if [[ "$processing_generic" != "0" || "$processing_channel_sync" != "0" ]]; then
  fail "in_flight_work_present generic_task_item=$processing_generic channel_sync_task_item=$processing_channel_sync"
fi
echo "RECREATE_POSTGRES_PRECHECK=PASS generic_task_item_processing=0 channel_sync_task_item_processing=0"

# --- 3) stop web too -- release.sh's own precedent: no application service
# should be mid-query against a postgres process that is about to stop.
web_stop_epoch="$(date -u '+%s')"
preprod_compose stop web

# --- 4) fresh on-line logical backup immediately ahead of the recreate,
# additional to whatever backup-timer's own daily run last produced. Reuses
# the exact proven script (scripts/db/backup-logical.sh) via the
# already-running backup-timer container, which already carries
# PGHOST/PGUSER=backup_role/PGPASSFILE and the script mount -- no new
# secrets or scripts needed.
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
echo "RECREATE_POSTGRES=PASS"
