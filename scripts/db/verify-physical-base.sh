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
cp "$backup_dir/backup_manifest" "$work_dir/backup_manifest"

[[ -r "$work_dir/backup_label" ]] || fail "backup_label missing from unpacked base.tar.gz" 70

# backup_label is plain text, e.g.:
#   START WAL LOCATION: 0/3000028 (file 000000010000000000000003)
#   START TIMELINE: 1
start_wal="$(grep -oE '\(file [0-9A-F]{24}\)' "$work_dir/backup_label" | head -1 | grep -oE '[0-9A-F]{24}' || true)"
start_timeline="$(grep -oE '^START TIMELINE: [0-9]+' "$work_dir/backup_label" | head -1 | grep -oE '[0-9]+$' || true)"
[[ -n "$start_wal" ]] || fail "could not parse the START WAL LOCATION file token from backup_label" 70
[[ -n "$start_timeline" ]] || fail "could not parse START TIMELINE from backup_label" 70

# backup_manifest is JSON, possibly pretty-printed across multiple lines;
# flattening first makes the extraction robust to either layout. WAL-Ranges
# entries never nest arrays, so the first "]" after "WAL-Ranges" is always
# that array's own closing bracket.
manifest_flat="$(tr -d '\n' <"$work_dir/backup_manifest")"
wal_ranges_section="$(printf '%s' "$manifest_flat" | grep -oE '"WAL-Ranges"[[:space:]]*:[[:space:]]*\[[^]]*\]' || true)"
[[ -n "$wal_ranges_section" ]] || fail "could not find a WAL-Ranges array in backup_manifest" 70
manifest_timeline="$(printf '%s' "$wal_ranges_section" | grep -oE '"Timeline"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)"
[[ -n "$manifest_timeline" ]] || fail "could not parse WAL-Ranges[0].Timeline from backup_manifest" 70
[[ "$manifest_timeline" == "$start_timeline" ]] || fail "backup_label START TIMELINE ($start_timeline) does not match backup_manifest WAL-Ranges[0].Timeline ($manifest_timeline)" 70

if command -v sha256sum >/dev/null 2>&1; then
  manifest_sha256="$(sha256sum "$backup_dir/backup_manifest" | awk '{print $1}')"
else
  manifest_sha256="$(shasum -a 256 "$backup_dir/backup_manifest" | awk '{print $1}')"
fi

if ! pg_verifybackup "$work_dir"; then
  fail "pg_verifybackup reported one or more failures" 71
fi

verified_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
temp_marker="$backup_dir/.VERIFIED.$$"
trap 'rm -f "$temp_marker"; [[ "$cleanup_work_dir" == "1" ]] && rm -rf "$work_dir"' EXIT INT TERM
{
  printf 'verified_at=%s\n' "$verified_at"
  printf 'manifest_sha256=%s\n' "$manifest_sha256"
  printf 'start_wal=%s\n' "$start_wal"
  printf 'start_timeline=%s\n' "$start_timeline"
} >"$temp_marker"
mv "$temp_marker" "$backup_dir/VERIFIED"
trap '[[ "$cleanup_work_dir" == "1" ]] && rm -rf "$work_dir"' EXIT INT TERM

echo "PHYSICAL_BASE_VERIFY=PASS"
