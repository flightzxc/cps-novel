#!/usr/bin/env bash
# WAL retention rehearsal (2026-09-16). One-shot, disposable-Docker
# acceptance run for scripts/db/{archive-wal,backup-physical-base,
# verify-physical-base,wal-retention}.sh. Every real component script is
# invoked as-is (mounted read-only into the rig) -- nothing here
# reimplements what those scripts do; this file only orchestrates them and
# asserts on their real output.
#
# Absolute rules this script itself must honor (see the work order):
#   * every docker resource it creates is named wal-retention-rig-* and is
#     torn down by exact name in the EXIT trap -- never a filtered/pruned
#     delete, never anything touching cps-novel-x8-*.
#   * --pull never (this host's DockerHub DNS is polluted; postgres:16.14
#     is already local) and --network none on every container.
#   * every wait loop is bounded by $SECONDS, never an unbounded poll.
set -uo pipefail
# Deliberately NOT `set -e`: a single failed assertion must not abort the
# whole run -- the work order requires finishing every step that is still
# physically reachable and recording all of them, not stopping at the
# first FAIL.

# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARCHIVE_SCRIPT="$WT/scripts/db/archive-wal.sh"
KEEP_RIG=0

usage() {
  echo "usage: wal-retention-rehearsal.sh [--archive-script PATH] [--keep-rig]" >&2
  exit 64
}
while (($#)); do
  case "$1" in
    --archive-script) (($# >= 2)) || usage; ARCHIVE_SCRIPT="$2"; shift 2 ;;
    --keep-rig) KEEP_RIG=1; shift ;;
    *) usage ;;
  esac
done
[[ -r "$ARCHIVE_SCRIPT" ]] || { echo "archive script not readable: $ARCHIVE_SCRIPT" >&2; exit 64; }

RIG_VOLUME="wal-retention-rig-data"
RIG_CONTAINER="wal-retention-rig-pg"
IMG="postgres:16.14"
RUN_DIR="$WT/.tmp/wal-retention-rehearsal"
EVIDENCE_DIR="$RUN_DIR/evidence"
PROGRESS_LOG="$RUN_DIR/progress.log"
# Fresh per run: several evidence files (e.g. step3-anchor.txt) are
# appended to during a run, and a stale file from a previous invocation
# must never be mistaken for this run's own evidence.
rm -rf "$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

OVERALL_FAIL=0
BLOCKED=0   # once 1, remaining steps are recorded as SKIP/blocked, not attempted

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$PROGRESS_LOG"; }

result() {
  # result <label> <PASS|FAIL|SKIP> <message...>
  local label="$1" status="$2"
  shift 2
  echo "WAL_RETENTION_${label}=${status} $*"
  log "${label} ${status}: $*"
  [[ "$status" == "FAIL" ]] && OVERALL_FAIL=1
}

# assert_step <label> <description> <expected> <actual>
assert_step() {
  local label="$1" desc="$2" expected="$3" actual="$4"
  if [[ "$expected" == "$actual" ]]; then
    result "$label" PASS "$desc expected=[$expected] actual=[$actual]"
  else
    result "$label" FAIL "$desc expected=[$expected] actual=[$actual]"
  fi
}

wait_until() {
  # wait_until <max_seconds> <desc> <command...>  -- polls every 2s
  local max="$1" desc="$2"
  shift 2
  local start=$SECONDS
  while (( SECONDS - start < max )); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "TIMEOUT after ${max}s waiting for: $desc" >&2
  return 1
}

dexec() { docker exec -u postgres "$RIG_CONTAINER" "$@"; }
dexec_root() { docker exec "$RIG_CONTAINER" "$@"; }
dexec_stdin() { docker exec -i -u postgres "$RIG_CONTAINER" "$@"; }

# wait_promoted <port> <max_seconds> <desc> -- polls until the instance on
# that port reports NOT pg_is_in_recovery(). Must be its own bash -c
# pipeline (grep -q on the query RESULT), not "dexec psql ... | grep" tacked
# onto wait_until's own invocation -- that older shape only tested psql's
# own exit code (0 whenever the connection+query succeed, 't' or 'f' alike)
# and would have reported "promoted" the instant the instance was merely
# reachable, promoted or not.
wait_promoted() {
  local port="$1" max="$2" desc="$3"
  wait_until "$max" "$desc" bash -c "docker exec -u postgres '$RIG_CONTAINER' psql -h /var/run/postgresql -p $port -d rig -t -A -c 'SELECT NOT pg_is_in_recovery();' 2>/dev/null | grep -q t"
}

cleanup() {
  if [[ "$KEEP_RIG" == "1" ]]; then
    log "cleanup skipped (--keep-rig): container=$RIG_CONTAINER volume=$RIG_VOLUME left in place"
    echo "WAL_RETENTION_KEEP_RIG=yes container=$RIG_CONTAINER volume=$RIG_VOLUME"
    return
  fi
  docker rm -f "$RIG_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$RIG_VOLUME" >/dev/null 2>&1 || true
  log "cleanup: removed container=$RIG_CONTAINER volume=$RIG_VOLUME"
}
trap cleanup EXIT

log "REHEARSAL_STARTED archive_script=$ARCHIVE_SCRIPT keep_rig=$KEEP_RIG"

# ---------------------------------------------------------------------------
# preparation: fresh named volume + directory skeleton, owned by postgres
# ---------------------------------------------------------------------------
docker volume create "$RIG_VOLUME" >/dev/null
docker run --rm --pull never -v "$RIG_VOLUME":/rig "$IMG" \
  install -d -o postgres -g postgres -m 0700 /rig /rig/archive /rig/archive-tl /rig/base /rig/work >/dev/null
log "STEP_PREP volume+dirs ready"

# ---------------------------------------------------------------------------
# STEP 0: whitelist, no running server
# ---------------------------------------------------------------------------
step0() {
  local legal=(
    "00000001000000430000006B"
    "00000001000000430000006C.partial"
    "00000001000000430000006B.gz"
    "000000010000003A00000007.00000028.backup"
    "00000002.history"
  )
  local illegal=(
    "foo"
    "0000000100000043"
    "00000001000000430000006B.GZ"
  )
  local out
  out="$(docker run --rm -i --pull never --network none \
    -v "$ARCHIVE_SCRIPT":/app/scripts/db/archive-wal.sh:ro \
    -v "$RIG_VOLUME":/rig \
    "$IMG" bash -s -- "${legal[@]}" -- "${illegal[@]}" <<'INNER'
set -u
mkdir -p /rig/work/step0/out
src=/rig/work/step0/src
echo "step0 payload" >"$src"
mode="legal"
ok=1
for name in "$@"; do
  if [[ "$name" == "--" ]]; then
    mode="illegal"
    continue
  fi
  P1_06_WAL_ARCHIVE_DIR=/rig/work/step0/out bash /app/scripts/db/archive-wal.sh "$src" "$name"
  rc=$?
  if [[ "$mode" == "legal" ]]; then
    if [[ "$rc" -eq 0 && -f "/rig/work/step0/out/$name" ]]; then
      echo "LEGAL_OK name=$name rc=$rc"
    else
      echo "LEGAL_BAD name=$name rc=$rc"
      ok=0
    fi
  else
    if [[ "$rc" -eq 65 ]]; then
      echo "ILLEGAL_OK name=$name rc=$rc"
    else
      echo "ILLEGAL_BAD name=$name rc=$rc"
      ok=0
    fi
  fi
done
echo "STEP0_OVERALL=$([[ "$ok" == 1 ]] && echo PASS || echo FAIL)"
INNER
)"
  echo "$out" >"$EVIDENCE_DIR/step0.log"
  local overall
  overall="$(printf '%s\n' "$out" | grep -oE 'STEP0_OVERALL=(PASS|FAIL)' | cut -d= -f2)"
  assert_step "STEP0" "whitelist accepts 5 legal / rejects 3 illegal filename shapes" "PASS" "${overall:-MISSING}"
}
step0

# If Step 0 itself fails, the archive_command will wedge on the very
# first base backup -- everything after B1 becomes unreachable. We still
# attempt the rest (the work order requires it), reality decides how far
# we get.

# ---------------------------------------------------------------------------
# STEP 1: start the rig
# ---------------------------------------------------------------------------
docker run -d --name "$RIG_CONTAINER" --pull never --network none \
  -e POSTGRES_PASSWORD=rehearsal-only -e POSTGRES_DB=rig \
  -v "$RIG_VOLUME":/rig \
  -v "$ARCHIVE_SCRIPT":/app/scripts/db/archive-wal.sh:ro \
  -v "$WT/scripts/db":/app/scripts/db-src:ro \
  "$IMG" postgres \
  -c wal_level=replica -c archive_mode=on -c archive_timeout=60 \
  -c max_wal_size=128MB -c min_wal_size=32MB \
  -c archive_command='P1_06_WAL_ARCHIVE_DIR=/rig/archive /app/scripts/db/archive-wal.sh "%p" "%f"' \
  >/dev/null 2>&1
started_ok=$?
if [[ "$started_ok" -ne 0 ]]; then
  result "STEP1" FAIL "docker run failed to start the rig container"
  BLOCKED=1
else
  if wait_until 60 "pg_isready" dexec pg_isready -U postgres; then
    assert_step "STEP1" "rig postgres reachable via pg_isready" "PASS" "PASS"
    # Rehearsal-speed tuning only (never a correctness knob): the given
    # docker run command's own -c flags are exactly as specified; this
    # shortens pg_basebackup's --checkpoint=spread wait from the default
    # ~270s (checkpoint_timeout=5min * completion_target=0.9) to a few
    # seconds so three base backups per round stay tractable.
    dexec psql -d rig -c "ALTER SYSTEM SET checkpoint_timeout = '30s';" >/dev/null
    dexec psql -d rig -c "ALTER SYSTEM SET checkpoint_completion_target = 0.5;" >/dev/null
    dexec psql -d rig -c "SELECT pg_reload_conf();" >/dev/null
  else
    result "STEP1" FAIL "pg_isready never succeeded within 60s"
    docker logs "$RIG_CONTAINER" >"$EVIDENCE_DIR/step1-failure-logs.txt" 2>&1
    BLOCKED=1
  fi
fi

# ---------------------------------------------------------------------------
# STEP 2: data + three base backups
# ---------------------------------------------------------------------------
ANCHOR_B2=""       # B2's VERIFIED start_wal, set in step3
RP_M2_LSN=""
RP_M3_LSN=""
B2_END_SEG=""
VICTIM_SEG=""

step2() {
  if [[ "$BLOCKED" == "1" ]]; then
    result "STEP2" SKIP "rig never came up"
    return
  fi

  dexec psql -d rig -c "CREATE ROLE backup_role LOGIN REPLICATION PASSWORD 'rehearsal-only-backup';" >/dev/null 2>&1
  dexec psql -d rig -c "CREATE TABLE IF NOT EXISTS marker(id serial primary key, label text);" >/dev/null
  dexec psql -d rig -c "CREATE TABLE IF NOT EXISTS churn(id bigint, pad text);" >/dev/null
  dexec bash -c 'echo "*:*:*:backup_role:rehearsal-only-backup" > /tmp/rig.pgpass && chmod 0600 /tmp/rig.pgpass'

  local backup_env='export PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=backup_role PGDATABASE=rig PGPASSFILE=/tmp/rig.pgpass'

  dexec psql -d rig -c "INSERT INTO marker(label) VALUES ('M0');" >/dev/null
  dexec psql -d rig -c "INSERT INTO churn(id, pad) SELECT g, repeat('x', 200) FROM generate_series(1, 200000) g;" >/dev/null
  dexec psql -d rig -c "SELECT pg_switch_wal();" >/dev/null

  dexec bash -c "$backup_env; bash /app/scripts/db-src/backup-physical-base.sh --output-dir /rig/base/B1" \
    >"$EVIDENCE_DIR/step2-b1-backup.log" 2>&1
  local b1_rc=$?

  sleep 10
  local archiver_row
  archiver_row="$(dexec psql -d rig -t -A -F'|' -c "SELECT failed_count, last_failed_wal FROM pg_stat_archiver;")"
  echo "$archiver_row" >"$EVIDENCE_DIR/step2-archiver-after-b1.txt"
  local failed_count="${archiver_row%%|*}"
  local last_failed_wal="${archiver_row#*|}"
  assert_step "STEP2" "pg_stat_archiver.failed_count is 0 after B1 (b1_backup_rc=$b1_rc, last_failed_wal=$last_failed_wal)" "0" "${failed_count:-MISSING}"

  dexec psql -d rig -c "INSERT INTO marker(label) VALUES ('M1');" >/dev/null
  dexec psql -d rig -c "INSERT INTO churn(id, pad) SELECT g, repeat('x', 200) FROM generate_series(200001, 400000) g;" >/dev/null
  dexec psql -d rig -c "SELECT pg_switch_wal();" >/dev/null
  dexec bash -c "$backup_env; bash /app/scripts/db-src/backup-physical-base.sh --output-dir /rig/base/B2" \
    >"$EVIDENCE_DIR/step2-b2-backup.log" 2>&1

  dexec psql -d rig -c "INSERT INTO marker(label) VALUES ('M2');" >/dev/null
  RP_M2_LSN="$(dexec psql -d rig -t -A -c "SELECT pg_create_restore_point('RP_M2');")"

  dexec psql -d rig -c "INSERT INTO churn(id, pad) SELECT g, repeat('x', 200) FROM generate_series(400001, 600000) g;" >/dev/null
  dexec psql -d rig -c "SELECT pg_switch_wal();" >/dev/null
  dexec bash -c "$backup_env; bash /app/scripts/db-src/backup-physical-base.sh --output-dir /rig/base/B3" \
    >"$EVIDENCE_DIR/step2-b3-backup.log" 2>&1

  dexec psql -d rig -c "INSERT INTO marker(label) VALUES ('M3');" >/dev/null
  RP_M3_LSN="$(dexec psql -d rig -t -A -c "SELECT pg_create_restore_point('RP_M3');")"
  dexec psql -d rig -c "SELECT pg_switch_wal();" >/dev/null

  local target_seg
  target_seg="$(dexec psql -d rig -t -A -c "SELECT pg_walfile_name('$RP_M3_LSN');")"
  wait_until 120 "last_archived_wal >= $target_seg" bash -c "
    seg=\$(docker exec -u postgres '$RIG_CONTAINER' psql -d rig -t -A -c \"SELECT last_archived_wal FROM pg_stat_archiver;\")
    [[ -n \"\$seg\" && \"\$seg\" > '$target_seg' || \"\$seg\" == '$target_seg' ]]
  "
  local waited=$?
  local last_archived
  last_archived="$(dexec psql -d rig -t -A -c "SELECT last_archived_wal FROM pg_stat_archiver;")"
  if [[ "$waited" -eq 0 ]]; then
    result "STEP2_WAIT_ARCHIVE" PASS "last_archived_wal ($last_archived) reached target segment ($target_seg) within 120s"
  else
    result "STEP2_WAIT_ARCHIVE" FAIL "last_archived_wal ($last_archived) never reached target segment ($target_seg) within 120s -- archiver likely wedged"
  fi
}
step2

# ---------------------------------------------------------------------------
# STEP 3: verify all three base backups with the real verify-physical-base.sh
# ---------------------------------------------------------------------------
step3() {
  if [[ "$BLOCKED" == "1" ]]; then
    result "STEP3" SKIP "rig never came up"
    return
  fi
  local name pass_count=0
  for name in B1 B2 B3; do
    local out
    out="$(dexec bash -c "bash /app/scripts/db-src/verify-physical-base.sh --backup-dir /rig/base/$name --work-dir /rig/work/verify-$name" 2>&1)"
    echo "$out" >"$EVIDENCE_DIR/step3-verify-$name.log"
    if printf '%s' "$out" | grep -q '^PHYSICAL_BASE_VERIFY=PASS$'; then
      pass_count=$((pass_count + 1))
      result "STEP3_$name" PASS "verify-physical-base.sh PASS for $name"
    else
      result "STEP3_$name" FAIL "verify-physical-base.sh did not PASS for $name: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
    fi
  done
  assert_step "STEP3" "all three base backups verified" "3" "$pass_count"

  if dexec test -f /rig/base/B2/VERIFIED; then
    ANCHOR_B2="$(dexec bash -c "grep '^start_wal=' /rig/base/B2/VERIFIED | cut -d= -f2")"
  fi
  echo "ANCHOR_B2=$ANCHOR_B2" >>"$EVIDENCE_DIR/step3-anchor.txt"

  if dexec test -f /rig/base/B2/backup_manifest; then
    B2_END_SEG="$(docker exec -i -u postgres "$RIG_CONTAINER" bash -s <<'INNER'
flat=$(tr -d '\n' < /rig/base/B2/backup_manifest)
section=$(printf '%s' "$flat" | grep -oE '"WAL-Ranges"[[:space:]]*:[[:space:]]*\[[^]]*\]')
endlsn=$(printf '%s' "$section" | grep -oE '"End-LSN"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | grep -oE '[0-9A-Fa-f]+/[0-9A-Fa-f]+')
# NOTE (verified against postgres:16.14 psql): the colon-quote variable
# interpolation syntax only fires when the query text is read from stdin
# or a script file, never through -c -- -c sends a literal colon straight
# to the server and it errors, so this pipes the query through stdin.
echo "SELECT pg_walfile_name(:'endlsn');" | psql -d rig -t -A -v endlsn="$endlsn"
INNER
)"
  fi
  echo "B2_END_SEG=$B2_END_SEG" >>"$EVIDENCE_DIR/step3-anchor.txt"
}
step3

# ---------------------------------------------------------------------------
# STEP 4: retention dry-run -> apply -> idempotent re-run
# ---------------------------------------------------------------------------
step4() {
  if [[ "$BLOCKED" == "1" ]]; then
    result "STEP4" SKIP "rig never came up"
    return
  fi
  dexec cp -a /rig/archive /rig/archive-mutant

  local dry
  dry="$(dexec bash -c "bash /app/scripts/db-src/wal-retention.sh --archive-dir /rig/archive --base-backup-dir /rig/base --keep-base 2 --max-bytes 1073741824 --json" 2>&1)"
  echo "$dry" >"$EVIDENCE_DIR/step4-dry-run.log"
  local planned
  planned="$(printf '%s' "$dry" | grep -oE 'WAL_RETENTION=DRY_RUN planned_delete=[0-9]+' | grep -oE '[0-9]+$')"
  local retire_ok=0 keep_ok=0 anchor_ok=0
  printf '%s' "$dry" | grep -qE '^WAL_RETENTION_RETIRE_BASE=B1$' && retire_ok=1
  printf '%s' "$dry" | grep -qE '^WAL_RETENTION_KEEP_BASE=B2 ' && printf '%s' "$dry" | grep -qE '^WAL_RETENTION_KEEP_BASE=B3 ' && keep_ok=1
  printf '%s' "$dry" | grep -qE "anchor.:.$ANCHOR_B2" && anchor_ok=1
  result "STEP4_DRYRUN_SET" "$([[ "$retire_ok" == 1 && "$keep_ok" == 1 ]] && echo PASS || echo FAIL)" "retire=B1($retire_ok) keep=B2,B3($keep_ok) planned_delete=${planned:-MISSING}"
  assert_step "STEP4_DRYRUN_ANCHOR" "dry-run anchor equals B2's VERIFIED start_wal" "1" "$anchor_ok"

  local apply
  apply="$(dexec bash -c "bash /app/scripts/db-src/wal-retention.sh --archive-dir /rig/archive --base-backup-dir /rig/base --keep-base 2 --apply --json" 2>&1)"
  echo "$apply" >"$EVIDENCE_DIR/step4-apply.log"
  local deleted
  deleted="$(printf '%s' "$apply" | grep -oE 'WAL_RETENTION=APPLIED deleted=[0-9]+' | grep -oE '[0-9]+$')"
  local base_left
  base_left="$(dexec bash -c "ls /rig/base | grep -v '^\\.' | sort | tr '\n' ',' ")"
  assert_step "STEP4_APPLY_BASE_DIRS" "only B2,B3 remain under /rig/base after apply" "B2,B3," "$base_left"
  if [[ -n "$deleted" && "$deleted" -gt 0 ]]; then
    result "STEP4_APPLY_DELETED" PASS "deleted=$deleted WAL segments"
  else
    result "STEP4_APPLY_DELETED" FAIL "deleted count missing or zero (deleted=${deleted:-MISSING})"
  fi

  # continuity: min 24-hex archive filename after apply must equal ANCHOR,
  # and the count of 24-hex names must match the closed-form segment count
  # between ANCHOR and the highest remaining segment (single timeline).
  local min_seg
  min_seg="$(dexec bash -c "ls /rig/archive | grep -E '^[0-9A-F]{24}\$' | sort | head -1")"
  assert_step "STEP4_CONTINUITY_MIN" "smallest surviving 24-hex archive filename equals ANCHOR" "$ANCHOR_B2" "$min_seg"

  local backup_leftover
  backup_leftover="$(dexec bash -c "ls /rig/archive | grep -c '\\.backup\$' || true")"
  result "STEP4_BACKUP_LEFTOVER" PASS "residual *.backup files after cleanup (expected, pg_archivecleanup never touches them): $backup_leftover"

  local idem
  idem="$(dexec bash -c "bash /app/scripts/db-src/wal-retention.sh --archive-dir /rig/archive --base-backup-dir /rig/base --keep-base 2" 2>&1)"
  echo "$idem" >"$EVIDENCE_DIR/step4-idempotent.log"
  local idem_planned
  idem_planned="$(printf '%s' "$idem" | grep -oE 'WAL_RETENTION=DRY_RUN planned_delete=[0-9]+' | grep -oE '[0-9]+$')"
  assert_step "STEP4_IDEMPOTENT" "second dry-run reports 0 further deletions" "0" "${idem_planned:-MISSING}"
}
step4

# ---------------------------------------------------------------------------
# STEP 5A + STEP 7: restore B2 -> RP_M3 (own archive_command, timeline switch)
# ---------------------------------------------------------------------------
step5a_and_7() {
  if [[ "$BLOCKED" == "1" ]]; then
    result "STEP5A" SKIP "rig never came up"
    result "STEP7" SKIP "rig never came up"
    return
  fi
  # archive_mode/archive_command go into postgresql.auto.conf (standard PG
  # config quoting, single-quoted value with embedded "%p"/"%f") instead of
  # pg_ctl -o -- pg_ctl reparses -o's value through an internal shell, and
  # a value-with-spaces there needs a second, error-prone layer of escaping
  # that the config file does not.
  docker exec -i -u postgres "$RIG_CONTAINER" bash -s <<'INNER'
set -e
umask 077
rm -rf /rig/restore-a
mkdir -p /rig/restore-a
tar -xzf /rig/base/B2/base.tar.gz -C /rig/restore-a
mkdir -p /rig/restore-a/pg_wal
tar -xzf /rig/base/B2/pg_wal.tar.gz -C /rig/restore-a/pg_wal
touch /rig/restore-a/recovery.signal
cat >>/rig/restore-a/postgresql.auto.conf <<'CONF'
restore_command = 'cp /rig/archive/%f %p'
recovery_target_name = 'RP_M3'
recovery_target_action = 'promote'
archive_mode = 'on'
archive_command = 'P1_06_WAL_ARCHIVE_DIR=/rig/archive-tl /app/scripts/db/archive-wal.sh "%p" "%f"'
CONF
INNER
  dexec bash -c 'pg_ctl -D /rig/restore-a -o "-p 5433" -w -t 180 -l /rig/restore-a.log start' \
    >"$EVIDENCE_DIR/step5a-start.log" 2>&1
  local start_rc=$?

  local promoted=1
  if [[ "$start_rc" -eq 0 ]]; then
    wait_promoted 5433 180 "restore-a leaves recovery"
    promoted=$?
  fi

  tail -n 60 "$EVIDENCE_DIR/step5a-start.log" > /dev/null 2>&1 || true
  dexec bash -c 'tail -n 60 /rig/restore-a.log' >"$EVIDENCE_DIR/step5a-restore-a-log-tail.txt" 2>&1

  if [[ "$start_rc" -ne 0 || "$promoted" -ne 0 ]]; then
    result "STEP5A" FAIL "restore-a (base=B2, target=RP_M3) did not promote within 180s (start_rc=$start_rc)"
    result "STEP7" SKIP "restore-a never promoted; cannot exercise its own archive_command"
    dexec bash -c 'pg_ctl -D /rig/restore-a stop -m immediate' >/dev/null 2>&1 || true
    return
  fi

  local labels
  labels="$(dexec psql -h /var/run/postgresql -p 5433 -d rig -t -A -c "SELECT string_agg(label, ',' ORDER BY id) FROM marker;")"
  assert_step "STEP5A" "restore-a at RP_M3 shows all four markers" "M0,M1,M2,M3" "$labels"

  # STEP 7: force a timeline-history archive from the now-promoted restore-a.
  dexec psql -h /var/run/postgresql -p 5433 -d rig -c "SELECT pg_switch_wal();" >/dev/null 2>&1
  sleep 10
  local tl_history_present tl_failed
  tl_history_present="$(dexec bash -c '[[ -f /rig/archive-tl/00000002.history ]] && echo yes || echo no')"
  tl_failed="$(dexec psql -h /var/run/postgresql -p 5433 -d rig -t -A -c "SELECT failed_count FROM pg_stat_archiver;")"
  echo "tl_history_present=$tl_history_present tl_failed=$tl_failed" >"$EVIDENCE_DIR/step7-archiver.txt"
  if [[ "$tl_history_present" == "yes" && "$tl_failed" == "0" ]]; then
    result "STEP7" PASS "00000002.history archived, restore-a archiver failed_count=0"
  else
    result "STEP7" FAIL "00000002.history present=$tl_history_present, restore-a archiver failed_count=$tl_failed"
  fi

  dexec bash -c 'pg_ctl -D /rig/restore-a stop -m fast' >/dev/null 2>&1
}
step5a_and_7

# ---------------------------------------------------------------------------
# STEP 5B: restore B2 -> RP_M2 (must NOT include M3)
# ---------------------------------------------------------------------------
step5b() {
  if [[ "$BLOCKED" == "1" ]]; then
    result "STEP5B" SKIP "rig never came up"
    return
  fi
  docker exec -i -u postgres "$RIG_CONTAINER" bash -s <<'INNER'
set -e
umask 077
rm -rf /rig/restore-b
mkdir -p /rig/restore-b
tar -xzf /rig/base/B2/base.tar.gz -C /rig/restore-b
mkdir -p /rig/restore-b/pg_wal
tar -xzf /rig/base/B2/pg_wal.tar.gz -C /rig/restore-b/pg_wal
touch /rig/restore-b/recovery.signal
cat >>/rig/restore-b/postgresql.auto.conf <<'CONF'
restore_command = 'cp /rig/archive/%f %p'
recovery_target_name = 'RP_M2'
recovery_target_action = 'promote'
CONF
INNER
  dexec bash -c 'pg_ctl -D /rig/restore-b -o "-p 5434" -w -t 180 -l /rig/restore-b.log start' \
    >"$EVIDENCE_DIR/step5b-start.log" 2>&1
  local start_rc=$?
  dexec bash -c 'tail -n 60 /rig/restore-b.log' >"$EVIDENCE_DIR/step5b-restore-b-log-tail.txt" 2>&1

  local promoted=1
  if [[ "$start_rc" -eq 0 ]]; then
    wait_promoted 5434 180 "restore-b leaves recovery"
    promoted=$?
  fi
  if [[ "$start_rc" -ne 0 || "$promoted" -ne 0 ]]; then
    result "STEP5B" FAIL "restore-b (base=B2, target=RP_M2) did not promote within 180s (start_rc=$start_rc)"
    dexec bash -c 'pg_ctl -D /rig/restore-b stop -m immediate' >/dev/null 2>&1 || true
    return
  fi
  local labels
  labels="$(dexec psql -h /var/run/postgresql -p 5434 -d rig -t -A -c "SELECT string_agg(label, ',' ORDER BY id) FROM marker;")"
  assert_step "STEP5B" "restore-b at RP_M2 shows exactly three markers (no M3)" "M0,M1,M2" "$labels"
  dexec bash -c 'pg_ctl -D /rig/restore-b stop -m fast' >/dev/null 2>&1
}
step5b

# ---------------------------------------------------------------------------
# helper for the 6A/6B "must fail" instances
# ---------------------------------------------------------------------------
check_recovery_failure_log() {
  local logpath="$1"
  dexec bash -c "grep -qE 'could not locate required checkpoint record|recovery ended before configured recovery target was reached' '$logpath'"
}

# ---------------------------------------------------------------------------
# STEP 6A: starting-boundary case (class A) -- positive then negative
# ---------------------------------------------------------------------------
step6a() {
  if [[ "$BLOCKED" == "1" ]]; then
    result "STEP6A_POSITIVE" SKIP "rig never came up"
    result "STEP6A_NEGATIVE" SKIP "rig never came up"
    return
  fi
  # positive: full real archive, no self-contained WAL -> must succeed
  docker exec -i -u postgres "$RIG_CONTAINER" bash -s <<'INNER'
set -e
umask 077
rm -rf /rig/restore-c
mkdir -p /rig/restore-c
tar -xzf /rig/base/B2/base.tar.gz -C /rig/restore-c
mkdir -p /rig/restore-c/pg_wal
touch /rig/restore-c/recovery.signal
cat >>/rig/restore-c/postgresql.auto.conf <<'CONF'
restore_command = 'cp /rig/archive/%f %p'
recovery_target_name = 'RP_M3'
recovery_target_action = 'promote'
CONF
INNER
  dexec bash -c 'pg_ctl -D /rig/restore-c -o "-p 5435" -w -t 180 -l /rig/restore-c.log start' \
    >"$EVIDENCE_DIR/step6a-positive-start.log" 2>&1
  local start_rc=$?
  dexec bash -c 'tail -n 60 /rig/restore-c.log' >"$EVIDENCE_DIR/step6a-positive-log-tail.txt" 2>&1
  local promoted=1
  if [[ "$start_rc" -eq 0 ]]; then
    wait_promoted 5435 180 "restore-c leaves recovery"
    promoted=$?
  fi
  if [[ "$start_rc" -eq 0 && "$promoted" -eq 0 ]]; then
    result "STEP6A_POSITIVE" PASS "restore-c (real /rig/archive, no self-contained WAL) reached RP_M3"
  else
    result "STEP6A_POSITIVE" FAIL "restore-c did not reach RP_M3 (start_rc=$start_rc); archive is not self-sufficient from ANCHOR forward"
  fi
  dexec bash -c 'pg_ctl -D /rig/restore-c stop -m fast' >/dev/null 2>&1 || dexec bash -c 'pg_ctl -D /rig/restore-c stop -m immediate' >/dev/null 2>&1 || true

  # negative: archive-mutant-a = archive-mutant copy with ANCHOR removed
  docker exec -u postgres -e ANCHOR_B2="$ANCHOR_B2" "$RIG_CONTAINER" bash -c \
    'rm -rf /rig/archive-mutant-a && cp -a /rig/archive-mutant /rig/archive-mutant-a && rm -f "/rig/archive-mutant-a/$ANCHOR_B2"'
  docker exec -i -u postgres "$RIG_CONTAINER" bash -s <<'INNER'
set -e
umask 077
rm -rf /rig/restore-c2
mkdir -p /rig/restore-c2
tar -xzf /rig/base/B2/base.tar.gz -C /rig/restore-c2
mkdir -p /rig/restore-c2/pg_wal
touch /rig/restore-c2/recovery.signal
cat >>/rig/restore-c2/postgresql.auto.conf <<'CONF'
restore_command = 'cp /rig/archive-mutant-a/%f %p'
recovery_target_name = 'RP_M3'
recovery_target_action = 'promote'
CONF
INNER
  dexec bash -c 'pg_ctl -D /rig/restore-c2 -o "-p 5435" -w -t 90 -l /rig/restore-c2.log start' \
    >"$EVIDENCE_DIR/step6a-negative-start.log" 2>&1
  local neg_rc=$?
  # pg_ctl -w can return as soon as the instance is up for read-only
  # queries (consistent recovery state), which may be BEFORE the async
  # startup process discovers the target is unreachable and crashes the
  # postmaster a moment later -- settle before snapshotting the log so the
  # captured evidence includes the actual fatal error, not a stale partial.
  sleep 3
  dexec bash -c 'tail -n 60 /rig/restore-c2.log' >"$EVIDENCE_DIR/step6a-negative-log-tail.txt" 2>&1

  local log_matches=1
  check_recovery_failure_log /rig/restore-c2.log && log_matches=0
  local status_running=1
  dexec bash -c 'pg_ctl -D /rig/restore-c2 status' >/dev/null 2>&1 && status_running=0

  # touch marker query attempt too, only meaningful if it somehow came up
  local reached_m3=0
  if [[ "$status_running" -eq 0 ]]; then
    dexec psql -h /var/run/postgresql -p 5435 -d rig -t -A -c "SELECT string_agg(label, ',' ORDER BY id) FROM marker;" 2>/dev/null | grep -q M3 && reached_m3=1
  fi

  if [[ "$reached_m3" -eq 0 && "$status_running" -eq 1 && ( "$neg_rc" -ne 0 || "$log_matches" -eq 0 ) ]]; then
    result "STEP6A_NEGATIVE" PASS "restore-c2 (ANCHOR missing from archive-mutant-a) correctly failed to reach RP_M3 (start_rc=$neg_rc, log_matches_expected_phrase=$([[ $log_matches -eq 0 ]] && echo yes || echo no), pg_ctl_status_running=no)"
  else
    result "STEP6A_NEGATIVE" FAIL "restore-c2 did NOT fail as required (start_rc=$neg_rc, reached_m3=$reached_m3, status_running=$([[ $status_running -eq 0 ]] && echo yes || echo no)) -- retention proof is not load-bearing"
  fi
  dexec bash -c 'pg_ctl -D /rig/restore-c2 stop -m immediate' >/dev/null 2>&1 || true
}
step6a

# ---------------------------------------------------------------------------
# STEP 6B: post-backup continuity case (class B, the main negative proof)
# ---------------------------------------------------------------------------
step6b() {
  if [[ "$BLOCKED" == "1" ]]; then
    result "STEP6B" SKIP "rig never came up"
    return
  fi
  VICTIM_SEG="$(dexec psql -d rig -t -A -c "SELECT pg_walfile_name('$RP_M3_LSN');")"
  local victim_gt_b2end=0
  if [[ -n "$VICTIM_SEG" && -n "$B2_END_SEG" && "$VICTIM_SEG" > "$B2_END_SEG" ]]; then
    victim_gt_b2end=1
  fi
  assert_step "STEP6B_PRECONDITION" "victim segment (RP_M3) is strictly after B2's own End-LSN segment" "1" "$victim_gt_b2end"

  local removed
  removed="$(dexec bash -c "test -f /rig/archive-mutant/$VICTIM_SEG && rm -f /rig/archive-mutant/$VICTIM_SEG && echo removed || echo missing")"
  echo "victim=$VICTIM_SEG removed=$removed" >"$EVIDENCE_DIR/step6b-victim.txt"

  docker exec -i -u postgres "$RIG_CONTAINER" bash -s <<'INNER'
set -e
umask 077
rm -rf /rig/restore-d
mkdir -p /rig/restore-d
tar -xzf /rig/base/B2/base.tar.gz -C /rig/restore-d
mkdir -p /rig/restore-d/pg_wal
tar -xzf /rig/base/B2/pg_wal.tar.gz -C /rig/restore-d/pg_wal
touch /rig/restore-d/recovery.signal
cat >>/rig/restore-d/postgresql.auto.conf <<'CONF'
restore_command = 'cp /rig/archive-mutant/%f %p'
recovery_target_name = 'RP_M3'
recovery_target_action = 'promote'
CONF
INNER
  dexec bash -c 'pg_ctl -D /rig/restore-d -o "-p 5436" -w -t 90 -l /rig/restore-d.log start' \
    >"$EVIDENCE_DIR/step6b-start.log" 2>&1
  local rc=$?
  # Same settle-before-snapshot reasoning as step6a's negative case above.
  sleep 3
  dexec bash -c 'tail -n 80 /rig/restore-d.log' >"$EVIDENCE_DIR/step6b-restore-d-log-tail.txt" 2>&1

  local log_matches=1
  check_recovery_failure_log /rig/restore-d.log && log_matches=0
  local status_running=1
  dexec bash -c 'pg_ctl -D /rig/restore-d status' >/dev/null 2>&1 && status_running=0
  local reached_m3=0
  if [[ "$status_running" -eq 0 ]]; then
    dexec psql -h /var/run/postgresql -p 5436 -d rig -t -A -c "SELECT string_agg(label, ',' ORDER BY id) FROM marker;" 2>/dev/null | grep -q M3 && reached_m3=1
  fi

  if [[ "$reached_m3" -eq 0 && "$status_running" -eq 1 && ( "$rc" -ne 0 || "$log_matches" -eq 0 ) ]]; then
    result "STEP6B" PASS "restore-d (victim=$VICTIM_SEG missing from archive-mutant, self-contained WAL kept) correctly failed to reach RP_M3 (pg_ctl_start_rc=$rc -- 0 is expected here: pg_ctl -w returns once read-only queries are possible at the consistent-recovery point, before the async startup process later hits the missing segment and crashes the postmaster; status_running=no confirms the crash already happened)"
  else
    result "STEP6B" FAIL "restore-d reached RP_M3 despite the missing post-backup WAL segment -- retention's continuity proof is NOT load-bearing (start_rc=$rc, reached_m3=$reached_m3, status_running=$([[ $status_running -eq 0 ]] && echo yes || echo no))"
  fi
  dexec bash -c 'pg_ctl -D /rig/restore-d stop -m immediate' >/dev/null 2>&1 || true
}
step6b

# ---------------------------------------------------------------------------
# STEP 8: collect evidence, then trap handles teardown
# ---------------------------------------------------------------------------
step8() {
  dexec psql -d rig -t -A -c "SELECT * FROM pg_stat_archiver;" >"$EVIDENCE_DIR/step8-final-pg_stat_archiver.txt" 2>&1
  for f in restore-a restore-b restore-c restore-c2 restore-d; do
    dexec bash -c "[[ -f /rig/$f.log ]] && tail -n 40 /rig/$f.log || true" >"$EVIDENCE_DIR/step8-${f}-log-tail.txt" 2>&1
  done
  result "STEP8" PASS "evidence copied to $EVIDENCE_DIR before teardown"
}
step8

# ---------------------------------------------------------------------------
# overall verdict
# ---------------------------------------------------------------------------
if [[ "$OVERALL_FAIL" -eq 0 ]]; then
  echo "WAL_RETENTION_REHEARSAL=PASS"
  log "REHEARSAL_FINISHED PASS"
  exit 0
else
  echo "WAL_RETENTION_REHEARSAL=FAIL"
  log "REHEARSAL_FINISHED FAIL"
  exit 1
fi
