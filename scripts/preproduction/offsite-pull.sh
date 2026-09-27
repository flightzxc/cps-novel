#!/usr/bin/env bash
set -euo pipefail
set +x

# Runs on the Owner's Mac or NAS, NEVER on haiyue-vps. It pulls the most
# recent COMPLETE logical backup off the VPS over `ssh`/`rsync` (read-only on
# the VPS side -- this script never writes anything remote), verifies it
# locally, and prunes older local copies down to a retention count.
#
# 🔴 No VPS credential of any kind is stored by this script or belongs on
# the VPS. It authenticates purely via the invoking user's own `ssh`
# configuration (public key, `~/.ssh/config` Host block for
# `haiyue-vps` -- see docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md and
# reference_cps_vps_ssh_kex.md-style notes for that host's own quirks, none
# of which this script hardcodes).
#
# Why "pull mode": the VPS never receives Mac/NAS credentials, an SSH key,
# or any outbound destination -- it only has to answer read-only `ssh`
# commands (`ls`, `stat`, `cat` a checksum file) issued FROM the Mac/NAS,
# and serve file bytes over the SAME already-authenticated ssh session via
# rsync. A push design would require the reverse: VPS-resident credentials
# for the Mac/NAS, which is exactly the boundary this design avoids.
#
# Completion detection: scripts/db/backup-logical.sh's own sequence is
# pg_dump --file=X.dump (writes the .dump), pg_restore --list (read-only
# validation of that .dump), THEN write X.dump.sha256, THEN write
# X.dump.metadata -- in that order. A backup is therefore complete iff BOTH
# sidecar files exist next to the .dump; a .dump still being written has
# neither sidecar yet. This script only ever considers a remote .dump whose
# .sha256 AND .metadata both exist, so an in-progress backup is silently
# skipped (reported on stderr, not treated as an error) rather than pulled
# half-written.
#
# Usage:
#   scripts/preproduction/offsite-pull.sh \
#     --remote-host haiyue-vps \
#     --remote-dir /opt/cps-novel/shared/backups/logical \
#     --local-dir /absolute/path/on/mac-or-nas \
#     [--keep 14]
#
# Prints exactly one machine-readable result line on success:
#   OFFSITE_PULL=PASS file=<name> size=<bytes> sha256=<hex> status=<pulled|already_present>
# or on failure:
#   OFFSITE_PULL=FAIL reason=<reason> [detail=...]
# and exits non-zero on failure.

remote_host="haiyue-vps"
remote_dir="/opt/cps-novel/shared/backups/logical"
local_dir=""
keep=14

usage() {
  echo "usage: offsite-pull.sh --local-dir DIR [--remote-host HOST] [--remote-dir DIR] [--keep N]" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --remote-host) remote_host="${2:-}"; shift 2 ;;
    --remote-dir) remote_dir="${2:-}"; shift 2 ;;
    --local-dir) local_dir="${2:-}"; shift 2 ;;
    --keep) keep="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$local_dir" && "$local_dir" = /* ]] || usage
[[ "$remote_dir" = /* ]] || usage
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || usage

fail() {
  echo "OFFSITE_PULL=FAIL reason=$1${2:+ detail=$2}"
  exit 65
}

command -v ssh >/dev/null 2>&1 || fail tool_missing ssh
command -v rsync >/dev/null 2>&1 || fail tool_missing rsync
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | awk '{print $1}'; }
else
  command -v shasum >/dev/null 2>&1 || fail tool_missing sha256sum_or_shasum
  sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

umask 077
mkdir -p "$local_dir"
# A prior run killed hard (power loss, kill -9) before its own EXIT trap ran
# leaves a stale .offsite-pull-staging.<oldpid> directory behind -- these
# never match the cps-novel-*.dump retention glob below and would otherwise
# sit in $local_dir forever, and get needlessly hashed into SHA256SUMS by
# export-backup-manifest.sh's own `find .` at the end. Sweep them first.
rm -rf "$local_dir"/.offsite-pull-staging.*
staging_dir="$local_dir/.offsite-pull-staging.$$"
mkdir -p "$staging_dir"
cleanup() { rm -rf "$staging_dir"; }
trap cleanup EXIT INT TERM

# 🔴 Plain string, not a bash array: bash 3.2 (this Mac's default
# /bin/bash) treats "${arr[@]}" on a genuinely empty array as an unbound
# variable under `set -u`, the same hazard scripts/preproduction/lib.sh
# documents at length for its own arrays. A plain string has no such
# hazard, and unquoted expansion below is deliberate word-splitting (this
# is how an operator passes e.g. "-o ProxyJump=bastion") -- shellcheck
# SC2086 is intentionally not applied to these two lines.
ssh_opts="${OFFSITE_PULL_SSH_OPTS:-}"

# --- 1) remote listing: only .dump files whose BOTH sidecars already exist
# are "complete". "Most recent" is decided by the .metadata sidecar's mtime
# (written LAST by backup-logical.sh, so it is the real completion instant),
# NOT by filename sort -- confirmed live on haiyue-vps (2026-09-27, read-only)
# that filenames are NOT reliably chronologically sortable: a manually made
# backup there is named "cps-novel-v050-20260927T051542Z.dump", which sorts
# after every plain "cps-novel-<timestamp>.dump" name lexically only because
# 'v' > every digit, not because of any guaranteed naming discipline. Runs
# entirely read-only on the VPS (ls/stat/test only, no write, no delete).
# shellcheck disable=SC2086
remote_listing="$(
  ssh $ssh_opts "$remote_host" bash -s -- "$remote_dir" <<'REMOTE_SCRIPT'
set -euo pipefail
dir="$1"
cd "$dir"
shopt -s nullglob
for dump in *.dump; do
  if [[ -f "${dump}.sha256" && -f "${dump}.metadata" ]]; then
    mtime="$(stat -c '%Y' "${dump}.metadata" 2>/dev/null || stat -f '%m' "${dump}.metadata")"
    echo "COMPLETE $mtime $dump"
  else
    echo "IN_PROGRESS 0 $dump" >&2
  fi
done
REMOTE_SCRIPT
)" || fail ssh_listing_failed

latest_complete="$(printf '%s\n' "$remote_listing" | awk '$1=="COMPLETE"{print $2, $3}' | sort -k1,1n | tail -1 | awk '{print $2}')"
[[ -n "$latest_complete" ]] || fail no_complete_backup_found

echo "OFFSITE_PULL_REMOTE_LATEST=$latest_complete" >&2

# --- 2) idempotency fast path: already pulled and still verifies locally ->
# skip the transfer itself, but still fall through to retention and manifest
# regeneration below (both idempotent) so every invocation leaves $local_dir
# in the same fully-consistent, restore-ready state regardless of which path
# was taken.
pull_status="pulled"
local_dump="$local_dir/$latest_complete"
local_sha256_sidecar="$local_dump.sha256"
if [[ -f "$local_dump" && -f "$local_sha256_sidecar" ]]; then
  expected_existing="$(awk '{print $1}' "$local_sha256_sidecar")"
  actual_existing="$(sha256_of "$local_dump")"
  if [[ "$expected_existing" == "$actual_existing" ]]; then
    pull_status="already_present"
    size_bytes="$(wc -c <"$local_dump" | tr -d ' ')"
    actual_sha256="$actual_existing"
  else
    # Local copy exists but no longer verifies (partial write from an
    # interrupted earlier run, local corruption, ...) -- re-pull rather than
    # trust it. Fall through to the transfer block below.
    echo "OFFSITE_PULL_LOCAL_REVERIFY=MISMATCH expected=$expected_existing actual=$actual_existing -- re-pulling" >&2
  fi
fi

if [[ "$pull_status" == "pulled" ]]; then
  # --- 3) pull all three files (.dump, .dump.sha256, .dump.metadata) into a
  # private staging directory first -- nothing lands in $local_dir under its
  # final name until it has verified, so a reader of $local_dir never
  # observes a partially-transferred file under a name retention/restore
  # code expects to be complete.
  for suffix in "" ".sha256" ".metadata"; do
    rsync -e "ssh $ssh_opts" -a --partial \
      "$remote_host:$remote_dir/${latest_complete}${suffix}" \
      "$staging_dir/${latest_complete}${suffix}" \
      || fail rsync_failed "${latest_complete}${suffix}"
  done

  # --- 4) local re-computation, NOT trusting the transferred hash file's
  # correctness claim about itself -- recompute from the bytes that actually
  # landed locally and compare to what traveled alongside them. This is what
  # actually proves the transfer was not corrupted; a bit-identical sidecar
  # file proves nothing about the (much larger) .dump next to it.
  expected_sha256="$(awk '{print $1}' "$staging_dir/${latest_complete}.sha256")"
  [[ -n "$expected_sha256" ]] || fail sidecar_unparseable "${latest_complete}.sha256"
  actual_sha256="$(sha256_of "$staging_dir/$latest_complete")"
  [[ "$expected_sha256" == "$actual_sha256" ]] || fail checksum_mismatch "expected=$expected_sha256 actual=$actual_sha256"

  size_bytes="$(wc -c <"$staging_dir/$latest_complete" | tr -d ' ')"

  # --- 5) atomic promotion into the final directory -- rename, not copy, so
  # a concurrent reader never observes a half-moved file under the final
  # name.
  mv -f "$staging_dir/$latest_complete" "$local_dir/$latest_complete"
  mv -f "$staging_dir/${latest_complete}.sha256" "$local_dir/${latest_complete}.sha256"
  mv -f "$staging_dir/${latest_complete}.metadata" "$local_dir/${latest_complete}.metadata"
fi

# --- 6) retention: keep the newest $keep complete local backups, delete the
# rest -- all three files per older backup. Never deletes anything not
# matching the cps-novel-*.dump(.sha256|.metadata) triple shape, so
# SHA256SUMS (regenerated below) or an operator's own file dropped into
# $local_dir is left alone.
#
# 🔴 bash 3.2/5 dual-compat (this runs on a Mac, whose default /bin/bash is
# still 3.2 for licensing reasons -- same constraint scripts/preproduction/
# lib.sh documents for its own bash 3.2/5 support): no `mapfile`/
# `readarray`, build the array with a plain while/read loop instead.
#
# 🔴 Sorted by each backup's own .metadata mtime, NOT by filename -- same
# reason as the remote listing above: filenames are not a reliable
# chronological order (a manually named backup can sort anywhere lexically).
local_stat_mtime() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1" 2>/dev/null
}
all_local_dumps=()
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  all_local_dumps+=("$name")
done < <(
  cd "$local_dir" && for f in cps-novel-*.dump; do
    [[ -f "$f" && -f "${f}.metadata" ]] || continue
    printf '%s %s\n' "$(local_stat_mtime "${f}.metadata")" "$f"
  done 2>/dev/null | sort -k1,1n | awk '{print $2}'
)
total="${#all_local_dumps[@]}"
if (( total > keep )); then
  to_delete=$(( total - keep ))
  for ((i = 0; i < to_delete; i++)); do
    old="${all_local_dumps[$i]}"
    rm -f "$local_dir/$old" "$local_dir/${old}.sha256" "$local_dir/${old}.metadata"
    echo "OFFSITE_PULL_RETENTION_DELETED=$old" >&2
  done
fi

# --- 7) regenerate SHA256SUMS over the whole local directory, via the SAME
# script the VPS side already uses to produce this exact format
# (scripts/preproduction/export-backup-manifest.sh) -- no second manifest
# format invented here. This is what makes $local_dir immediately usable as
# --offhost-dir for scripts/preproduction/restore-offhost-rehearsal.sh
# without a separate manual step: that script's own usage
# (docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md, "Backups, WAL,
# export, and restore") already expects exactly a `--dump FILE --manifest
# SHA256SUMS` pair sitting in the copied directory. Regenerated on every
# run (export-backup-manifest.sh itself refuses to overwrite an existing
# file), because retention above may have changed the file set since the
# last run -- a stale manifest here would make restore-offhost-rehearsal.sh
# verify against a set of files that no longer matches what is on disk.
manifest_path="$local_dir/SHA256SUMS"
rm -f "$manifest_path"
"$(dirname "${BASH_SOURCE[0]}")/export-backup-manifest.sh" --source-dir "$local_dir" --output "$manifest_path" \
  || fail manifest_generation_failed

echo "OFFSITE_PULL=PASS file=$latest_complete size=$size_bytes sha256=$actual_sha256 status=$pull_status manifest=$manifest_path"
