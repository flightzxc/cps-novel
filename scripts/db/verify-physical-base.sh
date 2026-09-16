#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: verify-physical-base.sh --backup-dir /absolute/dir [--work-dir /absolute/empty/dir]" >&2
  exit 64
}

backup_dir=""
work_dir=""
while (($#)); do
  case "$1" in
    --backup-dir)
      (($# >= 2)) || usage
      backup_dir="$2"
      shift 2
      ;;
    --work-dir)
      (($# >= 2)) || usage
      work_dir="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$backup_dir" = /* && -d "$backup_dir" ]] || usage

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command not found: $1" >&2
    echo "PHYSICAL_BASE_VERIFY=FAIL"
    exit 69
  }
}
require_command pg_verifybackup
require_command tar
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  echo "required command not found: sha256sum or shasum" >&2
  echo "PHYSICAL_BASE_VERIFY=FAIL"
  exit 69
fi

# Minimal-version contract: all three artifacts are required. A base backup
# without pg_wal.tar.gz cannot be verified for WAL-consistency (we never
# pass pg_verifybackup's --no-parse-wal), and one without backup_manifest
# cannot be verified at all.
for required in base.tar.gz backup_manifest pg_wal.tar.gz; do
  [[ -r "$backup_dir/$required" ]] || {
    echo "missing or unreadable required file: $backup_dir/$required" >&2
    echo "PHYSICAL_BASE_VERIFY=FAIL"
    exit 65
  }
done

cleanup_work_dir=0
if [[ -z "$work_dir" ]]; then
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/verify-physical-base.XXXXXX")"
  cleanup_work_dir=1
else
  [[ "$work_dir" = /* ]] || usage
  [[ ! -e "$work_dir" ]] || {
    [[ -d "$work_dir" && -z "$(find "$work_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
      echo "work directory must not exist or must be empty" >&2
      exit 73
    }
  }
  mkdir -p "$work_dir"
fi
trap '[[ "$cleanup_work_dir" == "1" ]] && rm -rf "$work_dir"' EXIT INT TERM

fail() {
  echo "$1" >&2
  echo "PHYSICAL_BASE_VERIFY=FAIL"
  exit "${2:-70}"
}

umask 077
echo "PHYSICAL_BASE_VERIFY_STARTED=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# pg_verifybackup (PG16/17) only accepts a directory-format backup, so the
# tars are unpacked here rather than verified in place; --no-parse-wal is
# never used, which is what makes this check actually cover WAL continuity
# and not just file checksums.
tar -xzf "$backup_dir/base.tar.gz" -C "$work_dir" || fail "failed to unpack base.tar.gz into work dir" 70
mkdir -p "$work_dir/pg_wal"
tar -xzf "$backup_dir/pg_wal.tar.gz" -C "$work_dir/pg_wal" || fail "failed to unpack pg_wal.tar.gz into work dir/pg_wal" 70
cp "$backup_dir/backup_manifest" "$work_dir/backup_manifest" || fail "failed to copy backup_manifest into work dir" 70

[[ -r "$work_dir/backup_label" ]] || fail "backup_label missing from unpacked base.tar.gz" 70

# backup_label is plain text, e.g.:
#   START WAL LOCATION: 0/3000028 (file 000000010000000000000003)
#   START TIMELINE: 1
start_wal="$(grep -oE '\(file [0-9A-F]{24}\)' "$work_dir/backup_label" | head -1 | grep -oE '[0-9A-F]{24}' || true)"
start_timeline="$(grep -oE '^START TIMELINE: [0-9]+' "$work_dir/backup_label" | head -1 | grep -oE '[0-9]+$' || true)"
[[ -n "$start_wal" ]] || fail "could not parse the START WAL LOCATION file token from backup_label" 70
[[ -n "$start_timeline" ]] || fail "could not parse START TIMELINE from backup_label" 70

# backup_manifest is JSON, possibly pretty-printed across multiple lines.
# sed first trims everything before the WAL-Ranges key (cheaper than
# flattening the whole, possibly large, manifest) and only that tail gets
# flattened; WAL-Ranges entries never nest arrays, so the first "]" after
# "WAL-Ranges" is always that array's own closing bracket.
manifest_tail="$(sed -n '/WAL-Ranges/,$p' "$work_dir/backup_manifest" | tr -d '\n')"
wal_ranges_section="$(printf '%s' "$manifest_tail" | grep -oE '"WAL-Ranges"[[:space:]]*:[[:space:]]*\[[^]]*\]' || true)"
[[ -n "$wal_ranges_section" ]] || fail "could not find a WAL-Ranges array in backup_manifest" 70
manifest_timeline="$(printf '%s' "$wal_ranges_section" | grep -oE '"Timeline"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)"
[[ -n "$manifest_timeline" ]] || fail "could not parse WAL-Ranges[0].Timeline from backup_manifest" 70
[[ "$manifest_timeline" == "$start_timeline" ]] || fail "backup_label START TIMELINE ($start_timeline) does not match backup_manifest WAL-Ranges[0].Timeline ($manifest_timeline)" 70

# Cross-check: WAL-Ranges[0].Start-LSN, converted to a segment filename via
# the standard 16MB-segment formula, must equal the segment name
# backup_label itself recorded -- a mismatch means the manifest and the
# label disagree about where this backup's WAL actually starts.
start_lsn="$(printf '%s' "$wal_ranges_section" | grep -oE '"Start-LSN"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | grep -oE '[0-9A-Fa-f]+/[0-9A-Fa-f]+' || true)"
[[ -n "$start_lsn" ]] || fail "could not parse WAL-Ranges[0].Start-LSN from backup_manifest" 70
lsn_hi_hex="${start_lsn%%/*}"
lsn_lo_hex="${start_lsn##*/}"
lsn_hi=$((16#$lsn_hi_hex))
lsn_lo=$((16#$lsn_lo_hex))
segno=$(( (lsn_hi << 8) | (lsn_lo >> 24) ))
seg_hi=$(( segno >> 8 ))
seg_lo=$(( segno & 255 ))
manifest_derived_seg="$(printf '%08X%08X%08X' "$manifest_timeline" "$seg_hi" "$seg_lo")"
[[ "$manifest_derived_seg" == "$start_wal" ]] || fail "backup_manifest WAL-Ranges[0].Start-LSN ($start_lsn -> $manifest_derived_seg) does not match backup_label (file $start_wal)" 70

if command -v sha256sum >/dev/null 2>&1; then
  manifest_sha256="$(sha256sum "$backup_dir/backup_manifest" | awk '{print $1}')"
else
  manifest_sha256="$(shasum -a 256 "$backup_dir/backup_manifest" | awk '{print $1}')"
fi

if ! pg_verifybackup "$work_dir"; then
  fail "pg_verifybackup reported one or more failures" 71
fi

verified_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
# wal-retention.sh's freshness check reads verified_epoch (a plain
# seconds-since-epoch integer) rather than parsing verified_at -- that
# sidesteps `date -d`, which is a GNU-only flag not available on a
# developer's own BSD/macOS `date`.
verified_epoch="$(date -u '+%s')"
temp_marker="$backup_dir/.VERIFIED.$$"
trap 'rm -f "$temp_marker"; [[ "$cleanup_work_dir" == "1" ]] && rm -rf "$work_dir"' EXIT INT TERM
{
  printf 'verified_at=%s\n' "$verified_at"
  printf 'verified_epoch=%s\n' "$verified_epoch"
  printf 'manifest_sha256=%s\n' "$manifest_sha256"
  printf 'start_wal=%s\n' "$start_wal"
  printf 'start_timeline=%s\n' "$start_timeline"
} >"$temp_marker"
mv "$temp_marker" "$backup_dir/VERIFIED"
trap '[[ "$cleanup_work_dir" == "1" ]] && rm -rf "$work_dir"' EXIT INT TERM

echo "PHYSICAL_BASE_VERIFY=PASS"
