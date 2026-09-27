#!/usr/bin/env bash
set -euo pipefail
set +x

# Runs on the Owner's Mac or NAS, NEVER on haiyue-vps. It pulls the most
# recent COMPLETE logical backup off the VPS, verifies it locally, and
# prunes older local copies down to a retention count.
#
# 🔴 Transport (review fix, 2026-09-27): goes through `ssh haiyue-vps docker
# exec -u 0 <container> ...` for every remote read (`ls`, `stat`, `cat`),
# NOT direct ssh file access. The `deploy` ssh user this script
# authenticates as already runs `docker` directly for every release and
# every read-only diagnostic in this repository -- the SAME access this
# script now reuses, no new grant. This sidesteps a real blocker found
# during the first-round rehearsal: the backup files under
# /opt/cps-novel/shared/backups/logical are root:root mode 0600 on the HOST,
# and `deploy` has no passwordless sudo (`sudo -n -l` confirmed refuses
# live) to read them directly. `docker exec -u 0` sidesteps that without
# any VPS-side permission change, sudo grant, or change to any service:
# being able to run `docker exec -u 0` on an arbitrary container is
# inherently as privileged as host root for anything bind-mounted into that
# container (a property of `deploy`'s docker-group membership, which every
# release and every read-only diagnostic here already relies on) --
# confirmed necessary live, not merely convenient: `web` (the fallback
# target used below when backup-timer is down) runs as UID 1001 by default,
# so a plain `docker exec` without `-u 0` gets `Permission denied` on these
# files. `--remote-dir` is therefore the path AS SEEN INSIDE the target
# container (/var/lib/cps-novel/backups/logical, per
# infra/preproduction/docker-compose.yml's own bind mount of
# ${PREPROD_SHARED_ROOT}/backups:/var/lib/cps-novel/backups), not the host
# path outside it.
#
# 🔴 No VPS credential of any kind is stored by this script or belongs on
# the VPS. It authenticates purely via the invoking user's own `ssh`
# configuration (public key, `~/.ssh/config` Host block for
# `haiyue-vps` -- see docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md and
# reference_cps_vps_ssh_kex.md-style notes for that host's own quirks, none
# of which this script hardcodes).
#
# Why "pull mode": the VPS never receives Mac/NAS credentials, an SSH key,
# or any outbound destination -- it only has to answer read-only `ssh
# ... docker exec` commands (`ls`, `stat`, `cat`) issued FROM the Mac/NAS.
# A push design would require the reverse: VPS-resident credentials for the
# Mac/NAS, which is exactly the boundary this design avoids.
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
#     --remote-dir /var/lib/cps-novel/backups/logical \
#     --local-dir /absolute/path/on/mac-or-nas \
#     [--backup-timer-container cps-novel-backup-timer-1] \
#     [--keep 14]
#
# 🔴 --gate mode (2026-09-28, NAS readonly-key round): when a caller does NOT
# hold the `deploy` user's own ssh key -- e.g. a UGREEN NAS pulling over the
# internet with its own dedicated, restricted key -- pass `--gate`. The
# transport changes from direct `ssh $host docker ps|exec ...` (which needs
# `deploy`'s full docker-group access, i.e. host-root-equivalent) to talking
# ONLY to scripts/preproduction/offsite-readonly-gate.sh, installed server-side
# as an ssh forced command (`command="..."` in authorized_keys) for that
# dedicated key: `ssh $host list` and `ssh $host get <name>` replace every
# `docker ps`/`docker exec` call this script would otherwise make itself. The
# gate enforces its own fixed remote directory and container lookup server-side
# -- `--remote-dir` and `--backup-timer-container` are therefore meaningless in
# gate mode; passing `--backup-timer-container` together with `--gate` is a
# usage error (there is nothing for it to select). Every local step after the
# transport -- staging, sha256 recomputation, atomic promotion, retention,
# SHA256SUMS regeneration -- is byte-for-byte the same code path either way.
# See docs/operations/OFFSITE_BACKUP_UGREEN_NAS.md for the NAS-side setup this
# mode exists for, and offsite-readonly-gate.sh's own header comment for the
# server-side security model (forced command, exact two-verb allowlist, no
# stdin-script execution, filename allowlist + list-membership check on `get`).
#
# Prints exactly one machine-readable result line on success:
#   OFFSITE_PULL=PASS file=<name> size=<bytes> sha256=<hex> status=<pulled|already_present>
# or on failure:
#   OFFSITE_PULL=FAIL reason=<reason> [detail=...]
# and exits non-zero on failure.

remote_host="haiyue-vps"
remote_dir="/var/lib/cps-novel/backups/logical"
local_dir=""
keep=14
backup_timer_container=""
gate_mode=0

usage() {
  echo "usage: offsite-pull.sh --local-dir DIR [--remote-host HOST] [--remote-dir DIR] [--backup-timer-container NAME] [--keep N] [--gate]" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --remote-host) remote_host="${2:-}"; shift 2 ;;
    --remote-dir) remote_dir="${2:-}"; shift 2 ;;
    --local-dir) local_dir="${2:-}"; shift 2 ;;
    --backup-timer-container) backup_timer_container="${2:-}"; shift 2 ;;
    --keep) keep="${2:-}"; shift 2 ;;
    --gate) gate_mode=1; shift ;;
    *) usage ;;
  esac
done

if ! [[ -n "$local_dir" && "$local_dir" = /* ]]; then usage; fi
if ! [[ "$remote_dir" = /* ]]; then usage; fi
if ! [[ "$keep" =~ ^[1-9][0-9]*$ ]]; then usage; fi
# --gate talks only to offsite-readonly-gate.sh, which picks its own
# container server-side (see this file's header comment) -- a
# --backup-timer-container value would silently do nothing, which is worse
# than refusing outright.
if [[ "$gate_mode" -eq 1 && -n "$backup_timer_container" ]]; then usage; fi

fail() {
  echo "OFFSITE_PULL=FAIL reason=$1${2:+ detail=$2}"
  exit 65
}

command -v ssh >/dev/null 2>&1 || fail tool_missing ssh
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
# SC2086 is intentionally not applied to these lines.
ssh_opts="${OFFSITE_PULL_SSH_OPTS:-}"

# --- 0) discover the backup-timer container name if not given explicitly.
# Read-only `docker ps` over ssh -- lists, does not start/stop/exec anything
# by itself. `--filter name=...` narrows server-side so a host running
# multiple projects (this one has been observed to, e.g. cps-novel-x8-local-*
# elsewhere) does not return an ambiguous multi-line match.
#
# 🔴 `docker ps` (no `-a`) only lists RUNNING containers -- if backup-timer
# is not currently running, auto-discovery correctly fails closed here
# rather than silently falling back to some other guessed container. This
# is not hypothetical: verified live on haiyue-vps, 2026-09-27, that
# cps-novel-backup-timer-1 has been Exited (137) since 2026-09-22 (flagged
# separately as an operational issue, unrelated to this script -- see this
# branch's own report). For that situation, pass
# `--backup-timer-container cps-novel-web-1` explicitly: `web` also mounts
# the same backups directory (`infra/preproduction/docker-compose.yml`,
# read-only) and was the container this script's own real-host verification
# actually used while backup-timer was down. Any currently-running
# container with that same bind mount works -- the flag name says
# "backup-timer" because that is the intended, always-available target once
# it is running, not because the mechanism requires that specific service.
# Skipped entirely in --gate mode: the gate (offsite-readonly-gate.sh) does
# its own fixed, server-side container lookup for every `list`/`get` call --
# there is no container name for THIS script to discover or pass along.
if [[ "$gate_mode" -eq 0 ]]; then
  if [[ -z "$backup_timer_container" ]]; then
    # shellcheck disable=SC2086
    backup_timer_container="$(ssh $ssh_opts "$remote_host" docker ps --filter name=cps-novel-backup-timer --format '{{.Names}}' | head -1)"
  fi
  if ! [[ -n "$backup_timer_container" ]]; then fail backup_timer_container_not_found; fi
  echo "OFFSITE_PULL_BACKUP_TIMER_CONTAINER=$backup_timer_container" >&2
else
  echo "OFFSITE_PULL_TRANSPORT=gate" >&2
fi

# --- 1) remote listing, run INSIDE the target container as root (`-u 0`).
# 🔴 `-u 0` is required, not optional: verified live that `web` (the
# fallback target above) runs as UID 1001 by default
# (root docker-compose.yml's `x-app-runtime` anchor), so a plain `docker
# exec` without `-u 0` gets `Permission denied` on the root:root 0600
# backup files -- confirmed live on haiyue-vps. `docker exec -u 0` on an
# arbitrary container is exactly as privileged as host root for anything
# bind-mounted into that container; this is an inherent property of being
# able to run `docker exec` at all (i.e. of `deploy`'s docker-group
# membership, which every release and every read-only diagnostic in this
# repository already relies on), not a new privilege this script requests.
# Only .dump files whose BOTH sidecars already exist are "complete". "Most
# recent" is decided by the .metadata sidecar's mtime (written LAST by
# backup-logical.sh, so it is the real completion instant), NOT by filename
# sort -- confirmed live on haiyue-vps (2026-09-27, read-only) that
# filenames are NOT reliably chronologically sortable: a manually made
# backup there is named "cps-novel-v050-20260927T051542Z.dump", which sorts
# after every plain "cps-novel-<timestamp>.dump" name lexically only
# because 'v' > every digit, not because of any guaranteed naming
# discipline. The postgres:16.14 image backup-timer runs (and the app
# image `web`/`worker`/etc. run, for the fallback case) is Debian-based --
# has /bin/sh and GNU stat.
# 🔴 --gate mode: this whole listing step becomes a single `ssh $host list`
# call to offsite-readonly-gate.sh instead of a `docker exec ... sh -s`
# heredoc -- the gate is what runs that heredoc now (its OWN, fixed, not
# stdin-supplied copy of the same "both sidecars present" logic, server-side),
# and hands back one already-complete-only, already-sorted-by-nothing line per
# backup as `name=X size=Y mtime=Z sha256=W`. Reformatted below into the exact
# same `COMPLETE <mtime> <name>` shape the direct-docker path produces, so
# every line after this branch (latest-selection, transfer, retention,
# manifest) is identical code regardless of transport.
if [[ "$gate_mode" -eq 0 ]]; then
  # shellcheck disable=SC2086
  remote_listing="$(
    ssh $ssh_opts "$remote_host" docker exec -u 0 -i "$backup_timer_container" sh -s -- "$remote_dir" <<'REMOTE_SCRIPT'
set -eu
dir="$1"
cd "$dir"
for dump in *.dump; do
  [ -e "$dump" ] || continue
  if [ -f "${dump}.sha256" ] && [ -f "${dump}.metadata" ]; then
    mtime="$(stat -c '%Y' "${dump}.metadata")"
    echo "COMPLETE $mtime $dump"
  else
    echo "IN_PROGRESS 0 $dump" >&2
  fi
done
REMOTE_SCRIPT
  )" || fail remote_listing_failed
else
  # shellcheck disable=SC2086
  if ! gate_listing="$(ssh $ssh_opts "$remote_host" list)"; then fail remote_listing_failed; fi
  remote_listing=""
  if [[ -n "$gate_listing" ]]; then
    while IFS= read -r gate_line; do
      if ! [[ -n "$gate_line" ]]; then continue; fi
      gate_name="${gate_line#*name=}"; gate_name="${gate_name%% *}"
      gate_mtime="${gate_line#*mtime=}"; gate_mtime="${gate_mtime%% *}"
      if ! [[ -n "$gate_name" && -n "$gate_mtime" ]]; then continue; fi
      remote_listing="$remote_listing"$'\n'"COMPLETE $gate_mtime $gate_name"
    done <<<"$gate_listing"
  fi
fi

latest_complete="$(printf '%s\n' "$remote_listing" | awk '$1=="COMPLETE"{print $2, $3}' | sort -k1,1n | tail -1 | awk '{print $2}')"
if ! [[ -n "$latest_complete" ]]; then fail no_complete_backup_found; fi

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
  # code expects to be complete. Streamed via `docker exec ... cat` piped
  # through ssh (review fix: replaces the rsync transport the first-round
  # rehearsal used -- see this file's header comment); no resume-on-interrupt
  # the way rsync's own --partial gave, but correctness (verified by the
  # sha256 recomputation below) does not depend on that, only convenience on
  # a dropped connection does.
  # 🔴 --gate mode: same three files, but each one is a single `ssh $host get
  # <name>` call to offsite-readonly-gate.sh instead of a direct `docker exec
  # ... cat` -- the gate does that `docker exec -u 0 <container> cat ...`
  # itself, server-side, only after re-validating the filename against its own
  # allowlist regex and the current `list` result (see that script's header).
  # This is a straight transport swap: the bytes streamed back and everything
  # done with them below (recompute sha256, atomic promote) are unchanged.
  if [[ "$gate_mode" -eq 0 ]]; then
    for suffix in "" ".sha256" ".metadata"; do
      # shellcheck disable=SC2086
      if ! ssh $ssh_opts "$remote_host" docker exec -u 0 "$backup_timer_container" cat "$remote_dir/${latest_complete}${suffix}" > "$staging_dir/${latest_complete}${suffix}"; then
        fail transfer_failed "${latest_complete}${suffix}"
      fi
    done
  else
    for suffix in "" ".sha256" ".metadata"; do
      # shellcheck disable=SC2086
      if ! ssh $ssh_opts "$remote_host" get "${latest_complete}${suffix}" > "$staging_dir/${latest_complete}${suffix}"; then
        fail transfer_failed "${latest_complete}${suffix}"
      fi
    done
  fi

  # --- 4) local re-computation, NOT trusting the transferred hash file's
  # correctness claim about itself -- recompute from the bytes that actually
  # landed locally and compare to what traveled alongside them (the same
  # value backup-logical.sh computed on the remote side when it made this
  # backup). This is what actually proves the transfer was not corrupted; a
  # bit-identical sidecar file proves nothing about the (much larger) .dump
  # next to it.
  expected_sha256="$(awk '{print $1}' "$staging_dir/${latest_complete}.sha256")"
  if ! [[ -n "$expected_sha256" ]]; then fail sidecar_unparseable "${latest_complete}.sha256"; fi
  actual_sha256="$(sha256_of "$staging_dir/$latest_complete")"
  if ! [[ "$expected_sha256" == "$actual_sha256" ]]; then fail checksum_mismatch "expected=$expected_sha256 actual=$actual_sha256"; fi

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
  if ! [[ -n "$name" ]]; then continue; fi
  all_local_dumps+=("$name")
done < <(
  cd "$local_dir" && for f in cps-novel-*.dump; do
    if ! [[ -f "$f" && -f "${f}.metadata" ]]; then continue; fi
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
