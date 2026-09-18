#!/usr/bin/env bash
set -uo pipefail
# Deliberately NOT `set -e` -- same reasoning as scripts/db/wal-retention-rehearsal.sh:
# this script must always reach its own PASS/FAIL verdict and evidence dump,
# never die silently partway through on an ordinary non-zero (a grep with no
# match, a psql query against a not-yet-ready instance, ...). Every command
# whose exit code matters is captured explicitly.

# Monthly positive PITR smoke (no live writes).
#
# What this proves: that "the OLDEST base backup currently kept by
# wal-retention.sh's own retention rule (the anchor) + the CURRENT WAL
# archive" can still replay forward to the START WAL LOCATION of the NEWEST
# base backup -- i.e. the exact recoverability promise wal-retention.sh's own
# anchor_not_in_archive/timeline_unsupported guards exist to protect stays
# true in practice, not only "the delete plan didn't refuse". This is the
# X8 local-profile "相关代码变更后必跑" companion to
# scripts/db/wal-retention-rehearsal.sh -- that script proves the FULL
# mechanism (Step 0 through Step 8, including the negative/FAIL cases) against
# synthetic rig data; this one is a light monthly POSITIVE-only check against
# whatever base backups + archive the real local X8 stack has actually
# produced, run standalone (no rehearsal harness).
#
# Absolute rules this script itself must honor (same red-line family as
# wal-retention-rehearsal.sh):
#   * every docker resource it creates is named wal-retention-rig-smoke-* and
#     is torn down by exact name in the EXIT trap -- never a filtered/pruned
#     delete, never anything touching cps-novel-x8-*/cps_novel_x8_*.
#   * --pull never, --network none on every container.
#   * the ONLY place this script ever touches a live cps_novel_x8_* resource
#     is the archive-source volume, and ONLY as a read-only (:ro) mount, in a
#     single one-time copy container -- it never mounts it read-write, never
#     execs into the running cps-novel-x8-local-* stack, never touches
#     postgres_data.
#   * zero writes to the live stack: the base-backup-dir input is a HOST
#     directory (the same one wal-gc/base-backup-now already write to,
#     $X8_BASE_BACKUP_DIR) read read-only; nothing here calls
#     base-backup-now, wal-gc, or any command that would create, verify, or
#     delete a base backup or a WAL segment.
#   * every wait loop is bounded by $SECONDS, never an unbounded poll (macOS
#     has no `timeout`).
#
# Anchor/target selection mirrors scripts/db/wal-retention.sh's OWN valid-set
# and anchor computation exactly (sort VERIFIED dirs ascending by start_wal,
# anchor = the (total - keep_base)-th, i.e. the oldest backup retention would
# still KEEP) -- this script does not reimplement retention policy, it only
# re-derives, read-only, which backup retention already promises to protect.

usage() {
  echo "usage: pitr-smoke-local.sh --base-backup-dir /absolute/dir [--archive-source VOLUME] [--keep-base N] [--keep-rig]" >&2
  exit 64
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESTORE_PITR="$SCRIPT_DIR/restore-pitr.sh"

BASE_BACKUP_DIR=""
ARCHIVE_SOURCE="cps_novel_x8_wal_archive"
KEEP_BASE=2
KEEP_RIG=0

while (($#)); do
  case "$1" in
    --base-backup-dir) (($# >= 2)) || usage; BASE_BACKUP_DIR="$2"; shift 2 ;;
    --archive-source) (($# >= 2)) || usage; ARCHIVE_SOURCE="$2"; shift 2 ;;
    --keep-base) (($# >= 2)) || usage; KEEP_BASE="$2"; shift 2 ;;
    --keep-rig) KEEP_RIG=1; shift ;;
    *) usage ;;
  esac
done

[[ "$BASE_BACKUP_DIR" = /* && -d "$BASE_BACKUP_DIR" ]] || usage
[[ "$KEEP_BASE" =~ ^[1-9][0-9]*$ ]] || usage
[[ -n "$ARCHIVE_SOURCE" && "$ARCHIVE_SOURCE" != *"'"* && "$ARCHIVE_SOURCE" != *" "* ]] || usage
[[ -r "$RESTORE_PITR" ]] || { echo "restore-pitr.sh not readable: $RESTORE_PITR" >&2; exit 64; }

RIG_PREFIX="wal-retention-rig-smoke"
RIG_CONTAINER="${RIG_PREFIX}-pg"
COPY_CONTAINER="${RIG_PREFIX}-copy"
RIG_ARCHIVE_VOLUME="${RIG_PREFIX}-archive"
IMG="postgres:16.14"
PGDATA_IN_CONTAINER="/rig/p1-06-pitr-smoke"

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
EVIDENCE_DIR="$WT/.tmp/x8-production-like/pitr-smoke/$STAMP"
mkdir -p "$EVIDENCE_DIR"

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$EVIDENCE_DIR/progress.log"; }

FAIL_REASON=""
fail() {
  FAIL_REASON="$1"
  echo "PITR_SMOKE=FAIL reason=$FAIL_REASON"
  log "FAIL reason=$FAIL_REASON"
  exit 1
}

cleanup() {
  if [[ "$KEEP_RIG" == "1" ]]; then
    log "cleanup skipped (--keep-rig): container=$RIG_CONTAINER volume=$RIG_ARCHIVE_VOLUME left in place"
    echo "PITR_SMOKE_KEEP_RIG=yes container=$RIG_CONTAINER volume=$RIG_ARCHIVE_VOLUME"
    return
  fi
  docker rm -f "$RIG_CONTAINER" "$COPY_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$RIG_ARCHIVE_VOLUME" >/dev/null 2>&1 || true
  log "cleanup: removed container=$RIG_CONTAINER copy_container=$COPY_CONTAINER volume=$RIG_ARCHIVE_VOLUME"
}
trap cleanup EXIT INT TERM

log "PITR_SMOKE_STARTED base_backup_dir=$BASE_BACKUP_DIR archive_source=$ARCHIVE_SOURCE keep_base=$KEEP_BASE evidence_dir=$EVIDENCE_DIR"

# ---------------------------------------------------------------------------
# select anchor (oldest KEPT) + target (newest), same rule as wal-retention.sh
# ---------------------------------------------------------------------------
read_kv() {
  grep "^${2}=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true
}

valid_pairs=()
while IFS= read -r d; do
  [[ -n "$d" ]] || continue
  name="$(basename "$d")"
  if [[ -f "$d/VERIFIED" && ! -f "$d/RETIRED" ]]; then
    sw="$(read_kv "$d/VERIFIED" start_wal)"
    st="$(read_kv "$d/VERIFIED" start_timeline)"
    if [[ "$sw" =~ ^[0-9A-F]{24}$ && "$st" =~ ^[0-9]+$ ]]; then
      valid_pairs+=("${sw}|${name}")
    fi
  fi
done < <(find "$BASE_BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | sort)

if [[ "${#valid_pairs[@]}" -lt "$KEEP_BASE" ]]; then
  fail "insufficient_verified_backups_found_${#valid_pairs[@]}_need_${KEEP_BASE}"
fi

valid_names=()
while IFS='|' read -r sw name; do
  [[ -n "$name" ]] || continue
  valid_names+=("$name")
done < <(printf '%s\n' "${valid_pairs[@]}" | sort -t'|' -k1,1 -k2,2)

total="${#valid_names[@]}"
anchor_index=$((total - KEEP_BASE))
ANCHOR_NAME="${valid_names[$anchor_index]}"
TARGET_NAME="${valid_names[$((total - 1))]}"
ANCHOR_DIR="$BASE_BACKUP_DIR/$ANCHOR_NAME"
TARGET_DIR="$BASE_BACKUP_DIR/$TARGET_NAME"
ANCHOR_START_WAL="$(read_kv "$ANCHOR_DIR/VERIFIED" start_wal)"
ANCHOR_TIMELINE="$(read_kv "$ANCHOR_DIR/VERIFIED" start_timeline)"
EXPECTED_NEW_TIMELINE=$((ANCHOR_TIMELINE + 1))
log "selected anchor=$ANCHOR_NAME (start_wal=$ANCHOR_START_WAL timeline=$ANCHOR_TIMELINE) target=$TARGET_NAME (total_valid=$total keep_base=$KEEP_BASE)"

# Opus review fixup 2026-09-18 (P2-11): if --keep-base (or a thin
# base-backup-dir) makes the anchor and the newest backup the SAME
# directory, "replay the anchor's archive forward to the target's own
# Start-LSN" degenerates to "replay a backup forward to its own start
# point" -- trivially true and proves nothing about retained WAL actually
# reaching a LATER backup. Fail fast rather than let this silently report a
# vacuous PASS.
[[ "$ANCHOR_NAME" != "$TARGET_NAME" ]] || fail "anchor_equals_target_nothing_to_prove"

[[ -r "$ANCHOR_DIR/base.tar.gz" ]] || fail "anchor_base_tar_missing"
[[ -r "$TARGET_DIR/backup_manifest" ]] || fail "target_manifest_missing"

# Target's own Start-LSN, read out of ITS OWN backup_manifest (same
# WAL-Ranges JSON shape wal-retention-rehearsal.sh's step3 already parses for
# End-LSN) -- this is the "START WAL LOCATION" this smoke proves the anchor's
# retained archive can still reach.
flat="$(tr -d '\n' <"$TARGET_DIR/backup_manifest")"
section="$(printf '%s' "$flat" | grep -oE '"WAL-Ranges"[[:space:]]*:[[:space:]]*\[[^]]*\]')"
TARGET_START_LSN="$(printf '%s' "$section" | grep -oE '"Start-LSN"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | grep -oE '[0-9A-Fa-f]+/[0-9A-Fa-f]+')"
[[ -n "$TARGET_START_LSN" ]] || fail "target_start_lsn_unparseable"
log "target_start_lsn=$TARGET_START_LSN"

# ---------------------------------------------------------------------------
# one-time, read-only copy of the live archive volume -> a fresh rig volume.
# THIS is the only line in the whole script that ever references the live
# cps_novel_x8_wal_archive volume, and it is always :ro. Only segments at or
# after the anchor's own start_wal, plus every *.backup/*.history file, are
# copied -- not the whole archive.
# ---------------------------------------------------------------------------
docker volume create "$RIG_ARCHIVE_VOLUME" >/dev/null

copy_log="$EVIDENCE_DIR/archive-copy.log"
docker run --rm -i --pull never --network none --name "$COPY_CONTAINER" \
  -v "${ARCHIVE_SOURCE}:/src:ro" \
  -v "$RIG_ARCHIVE_VOLUME:/dst" \
  "$IMG" bash -s -- "$ANCHOR_START_WAL" >"$copy_log" 2>&1 <<'COPY_ARCHIVE'
set -eu
anchor="$1"
copied=0
for f in /src/*; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  case "$name" in
    *.history|*.backup)
      cp -p "$f" /dst/
      copied=$((copied + 1))
      ;;
    *)
      if [[ "$name" =~ ^[0-9A-F]{24}(\.[A-Za-z0-9]+)?$ ]]; then
        base24="${name:0:24}"
        if [[ "$base24" > "$anchor" || "$base24" == "$anchor" ]]; then
          cp -p "$f" /dst/
          copied=$((copied + 1))
        fi
      fi
      ;;
  esac
done
echo "ARCHIVE_COPY_COUNT=$copied"
# Opus review fixup 2026-09-18 (P2-10): a stat on the DESTINATION (/dst,
# freshly created this run -- never anything but this copy's own output),
# not a re-derivation from the $copied counter above, so this is an
# independent check of what actually landed on disk, not just an echo of
# the loop's own bookkeeping.
history_count=0
for f in /dst/*.history; do
  [[ -e "$f" ]] || continue
  history_count=$((history_count + 1))
done
echo "SMOKE_COPY_HISTORY_FILES=$history_count"
COPY_ARCHIVE
copy_rc=$?

[[ "$copy_rc" -eq 0 ]] || fail "archive_copy_failed_rc_${copy_rc}"
copied_count="$(grep -oE 'ARCHIVE_COPY_COUNT=[0-9]+' "$copy_log" | grep -oE '[0-9]+$' || true)"
[[ -n "$copied_count" && "$copied_count" -gt 0 ]] || fail "archive_copy_empty"
log "archive_copy_count=$copied_count"

# Opus review fixup 2026-09-18 (P2-10): this smoke's whole timeline-ID
# assertion below (EXPECTED_NEW_TIMELINE = anchor's own start_timeline + 1)
# assumes the copied archive slice is "one continuous run with no prior
# timeline switch" -- true whenever the local X8 archive has never gone
# through a real PITR/promotion before. If .history files DID land in /dst
# (a previous timeline switch is recorded in the archive at or after the
# anchor), "+1" is no longer a safe guess at what the NEXT promotion's new
# timeline ID will be -- refuse rather than assert a possibly-wrong number.
smoke_copy_history_files="$(grep -oE 'SMOKE_COPY_HISTORY_FILES=[0-9]+' "$copy_log" | grep -oE '[0-9]+$' || true)"
[[ -n "$smoke_copy_history_files" ]] || fail "smoke_copy_history_files_unparseable"
log "smoke_copy_history_files=$smoke_copy_history_files"
[[ "$smoke_copy_history_files" == "0" ]] || fail "history_files_present_expected_timeline_ambiguous"

# ---------------------------------------------------------------------------
# one-time rig container: read-only anchor base backup + read-only copied
# archive + read-only restore-pitr.sh, running only `sleep infinity` (no
# postgres entrypoint, no networking) until we exec pg_ctl into it ourselves.
# ---------------------------------------------------------------------------
docker run -d --name "$RIG_CONTAINER" --pull never --network none \
  -v "$RIG_ARCHIVE_VOLUME:/rig/archive:ro" \
  -v "$ANCHOR_DIR:/rig/anchor-base:ro" \
  -v "$RESTORE_PITR:/app/scripts/db/restore-pitr.sh:ro" \
  "$IMG" sleep infinity >/dev/null 2>&1
started_rc=$?
[[ "$started_rc" -eq 0 ]] || fail "rig_container_start_failed"

docker exec -u root "$RIG_CONTAINER" install -d -o postgres -g postgres -m 0700 /rig >/dev/null 2>&1
prep_rc=$?
[[ "$prep_rc" -eq 0 ]] || fail "rig_pgdata_dir_prep_failed"

# restore-pitr.sh only supports --target-time (P1_06_PITR_RUNBOOK.md §5); its
# own header comment records this as a known gap ("后续应给 restore-pitr.sh 加
# --target-name"). A dummy value is passed here purely to satisfy its
# argument validation -- the recovery_target_time/pause lines it writes are
# both immediately stripped and replaced below with the LSN-based target this
# smoke actually wants.
restore_prep_log="$EVIDENCE_DIR/restore-pitr-prepare.log"
docker exec -u postgres \
  -e P1_06_ALLOW_DISPOSABLE_PITR=1 \
  -e P1_06_WAL_ARCHIVE_DIR=/rig/archive \
  "$RIG_CONTAINER" bash /app/scripts/db/restore-pitr.sh \
  --base-backup /rig/anchor-base \
  --pgdata "$PGDATA_IN_CONTAINER" \
  --target-time "1970-01-01 00:00:00+00" \
  >"$restore_prep_log" 2>&1
prep_pitr_rc=$?
[[ "$prep_pitr_rc" -eq 0 ]] || fail "restore_pitr_prepare_failed"
grep -q '^PITR_PREPARED=YES$' "$restore_prep_log" || fail "restore_pitr_prepare_no_marker"

# Replace the time-based recovery target restore-pitr.sh wrote with the
# LSN-based one this smoke needs -- recovery_target_lsn +
# recovery_target_action='promote' + recovery_target_timeline='current' (the
# last one is what lets promotion succeed off a base backup taken on an
# EARLIER timeline than the archive's most recent .history file, exactly
# wal-retention-rehearsal.sh Step 5A/7's own scenario).
docker exec -u postgres "$RIG_CONTAINER" bash -c "
set -eu
sed -i '/^recovery_target_time /d; /^recovery_target_action /d' '$PGDATA_IN_CONTAINER/postgresql.auto.conf'
cat >>'$PGDATA_IN_CONTAINER/postgresql.auto.conf' <<CONF
recovery_target_lsn = '$TARGET_START_LSN'
recovery_target_action = 'promote'
recovery_target_timeline = 'current'
CONF
"
rewrite_rc=$?
[[ "$rewrite_rc" -eq 0 ]] || fail "recovery_target_rewrite_failed"
log "recovery_target_lsn=$TARGET_START_LSN recovery_target_action=promote recovery_target_timeline=current"

# ---------------------------------------------------------------------------
# start + wait for promotion (SECONDS-bounded; macOS has no `timeout`)
# ---------------------------------------------------------------------------
start_log="$EVIDENCE_DIR/pg_ctl-start.log"
docker exec -u postgres "$RIG_CONTAINER" bash -c \
  "pg_ctl -D '$PGDATA_IN_CONTAINER' -o '-p 5433' -w -t 180 -l /rig/p1-06-pitr-smoke.log start" \
  >"$start_log" 2>&1
start_rc=$?

promoted_rc=1
if [[ "$start_rc" -eq 0 ]]; then
  wait_start=$SECONDS
  while (( SECONDS - wait_start < 600 )); do
    flag="$(docker exec -u postgres "$RIG_CONTAINER" psql -h /var/run/postgresql -p 5433 -d postgres -t -A -c 'SELECT NOT pg_is_in_recovery();' 2>/dev/null || true)"
    if [[ "$flag" == "t" ]]; then
      promoted_rc=0
      break
    fi
    sleep 2
  done
fi

docker exec "$RIG_CONTAINER" bash -c 'tail -n 200 /rig/p1-06-pitr-smoke.log' >"$EVIDENCE_DIR/postgres.log" 2>&1 || true

if [[ "$start_rc" -ne 0 || "$promoted_rc" -ne 0 ]]; then
  fail "promotion_did_not_complete_within_600s"
fi

# ---------------------------------------------------------------------------
# assertions
# ---------------------------------------------------------------------------
replay_ge_target="$(docker exec -u postgres "$RIG_CONTAINER" psql -h /var/run/postgresql -p 5433 -d postgres -t -A \
  -c "SELECT pg_last_wal_replay_lsn() >= '$TARGET_START_LSN'::pg_lsn;" 2>/dev/null || true)"
replay_lsn_actual="$(docker exec -u postgres "$RIG_CONTAINER" psql -h /var/run/postgresql -p 5433 -d postgres -t -A \
  -c "SELECT pg_last_wal_replay_lsn();" 2>/dev/null || true)"
timeline_id_actual="$(docker exec -u postgres "$RIG_CONTAINER" psql -h /var/run/postgresql -p 5433 -d postgres -t -A \
  -c "SELECT timeline_id FROM pg_control_checkpoint();" 2>/dev/null || true)"

{
  echo "target_start_lsn=$TARGET_START_LSN"
  echo "replay_lsn_actual=$replay_lsn_actual"
  echo "replay_ge_target=$replay_ge_target"
  echo "timeline_id_actual=$timeline_id_actual"
  echo "expected_new_timeline=$EXPECTED_NEW_TIMELINE"
} >"$EVIDENCE_DIR/assertions.txt"
log "replay_lsn_actual=$replay_lsn_actual replay_ge_target=$replay_ge_target timeline_id_actual=$timeline_id_actual expected_new_timeline=$EXPECTED_NEW_TIMELINE"

[[ "$replay_ge_target" == "t" ]] || fail "replay_lsn_below_target (actual=$replay_lsn_actual target=$TARGET_START_LSN)"
[[ "$timeline_id_actual" == "$EXPECTED_NEW_TIMELINE" ]] || fail "unexpected_timeline (actual=$timeline_id_actual expected=$EXPECTED_NEW_TIMELINE)"

log_content="$(cat "$EVIDENCE_DIR/postgres.log" 2>/dev/null || true)"
has_stop_phrase=0
printf '%s' "$log_content" | grep -qE 'recovery stopping (after|before) WAL location' && has_stop_phrase=1
has_new_timeline_line=0
printf '%s' "$log_content" | grep -qE 'selected new timeline ID: [0-9]+' && has_new_timeline_line=1
has_fatal=0
# Opus review fixup 2026-09-18 (P2-11): postgres logs "FATAL:  the database
# system is starting up" for any connection attempt that races the server's
# own startup/recovery window -- normal, expected chatter while THIS script
# itself is polling with psql before promotion completes (see the wait loop
# above), not a real failure. Only a FATAL: line that is NOT that specific,
# benign, still-starting-up message should ever flip has_fatal.
printf '%s' "$log_content" | grep -E 'FATAL:' | grep -qv 'the database system is starting up' && has_fatal=1

[[ "$has_stop_phrase" -eq 1 ]] || fail "log_missing_recovery_stopping_phrase"
[[ "$has_new_timeline_line" -eq 1 ]] || fail "log_missing_selected_new_timeline_line"
[[ "$has_fatal" -eq 0 ]] || fail "log_contains_fatal"

echo "PITR_SMOKE=PASS anchor=$ANCHOR_NAME target=$TARGET_NAME target_start_lsn=$TARGET_START_LSN replay_lsn=$replay_lsn_actual timeline=$timeline_id_actual evidence=$EVIDENCE_DIR"
log "PASS anchor=$ANCHOR_NAME target=$TARGET_NAME"
exit 0
