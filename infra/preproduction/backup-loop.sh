#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

: "${PREPROD_BACKUP_INTERVAL_SECONDS:=86400}"
: "${PREPROD_LOGICAL_RETENTION_DAYS:=14}"
: "${PREPROD_BASE_BACKUP_MIN_AGE_SECONDS:=604800}"
[[ "$PREPROD_BACKUP_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]
[[ "$PREPROD_LOGICAL_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]
[[ "$PREPROD_BASE_BACKUP_MIN_AGE_SECONDS" =~ ^[1-9][0-9]*$ ]]

logical_dir=/var/lib/cps-novel/backups/logical
base_dir=/var/lib/cps-novel/backups/base
status_file=/var/lib/cps-novel/backups/last-success.json
mkdir -p "$logical_dir" "$base_dir"

newest_verified_epoch() {
  local marker epoch newest=0
  while IFS= read -r marker; do
    epoch="$(grep '^verified_epoch=' "$marker" | head -1 | cut -d= -f2- || true)"
    [[ "$epoch" =~ ^[0-9]+$ ]] || continue
    (( epoch > newest )) && newest="$epoch"
  done < <(find "$base_dir" -mindepth 2 -maxdepth 2 -type f -name VERIFIED -print)
  printf '%s' "$newest"
}

run_once() {
  local stamp now latest base_target logical_target temp_status
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  now="$(date -u '+%s')"
  logical_target="$logical_dir/cps-novel-${stamp}.dump"
  /bin/bash /app/scripts/db/backup-logical.sh --output "$logical_target"
  find "$logical_dir" -maxdepth 1 -type f \
    \( -name '*.dump' -o -name '*.dump.sha256' -o -name '*.dump.metadata' \) \
    -mtime "+$PREPROD_LOGICAL_RETENTION_DAYS" -delete

  latest="$(newest_verified_epoch)"
  if (( latest == 0 || now - latest >= PREPROD_BASE_BACKUP_MIN_AGE_SECONDS )); then
    base_target="$base_dir/$stamp"
    /bin/bash /app/scripts/db/backup-physical-base.sh --output-dir "$base_target"
    /bin/bash /app/scripts/db/verify-physical-base.sh \
      --backup-dir "$base_target" --work-dir "$base_dir/.verify-$stamp"
  fi

  # The oldest of the two retained weekly verified bases is the recovery
  # anchor. Applied daily, this keeps roughly seven days of local PITR WAL
  # while refusing cleanup on stale bases or an unhealthy archiver.
  /bin/bash /app/scripts/db/wal-retention.sh \
    --archive-dir /var/lib/postgresql/wal-archive \
    --base-backup-dir "$base_dir" \
    --keep-base 2 \
    --max-backup-age-seconds 691200 \
    --require-archiver-healthy \
    --apply

  temp_status="${status_file}.$$"
  printf '{"finishedAt":"%s","exitCode":0}\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$temp_status"
  # 2026-09-27 (Owner-approved, single change): under the `umask 077` set at
  # the top of this script (correctly kept for everything else -- the dumps
  # themselves must stay 0600), this temp file would otherwise land 0600
  # root:root, and so would the published status file after `mv`. web runs
  # as 1001:1001 and only gets `group_add: ["1000"]` on the bind mount's
  # *directory* (infra/preproduction/docker-compose.yml) -- that grants
  # traverse/list, never a read on a 0600-root file. Without this chmod,
  # /api/health/backup's status-file branch (src/server/health/
  # backup-status.ts) can never successfully read the file and permanently
  # reports "failed" regardless of real backup freshness. Content here is
  # only `{"finishedAt","exitCode"}` -- non-sensitive -- so widen to 0644 on
  # the TEMP file BEFORE the publishing `mv`, so the published path never
  # exists at the wrong mode even momentarily.
  chmod 0644 "$temp_status"
  mv "$temp_status" "$status_file"
  echo "PREPROD_BACKUP_RUN=PASS"
}

while true; do
  run_once
  sleep "$PREPROD_BACKUP_INTERVAL_SECONDS" &
  wait "$!"
done
