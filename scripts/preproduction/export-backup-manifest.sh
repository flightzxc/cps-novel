#!/usr/bin/env bash
set -euo pipefail
set +x

source_dir=""; output=""
while (($#)); do
  case "$1" in
    --source-dir) source_dir="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    *) echo "usage: export-backup-manifest.sh --source-dir DIR --output FILE" >&2; exit 64 ;;
  esac
done
[[ "$source_dir" = /* && -d "$source_dir" && "$output" = /* && ! -e "$output" ]] || exit 64
umask 077
temporary="${output}.tmp.$$"
trap 'rm -f "$temporary"' EXIT INT TERM
output_name="$(basename "$output")"
temporary_name="$(basename "$temporary")"
(
  cd "$source_dir"
  find . -type f ! -name "$output_name" ! -name "$temporary_name" -print0 | sort -z | while IFS= read -r -d '' file; do
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$file"; else shasum -a 256 "$file"; fi
  done
) >"$temporary"
[[ -s "$temporary" ]] || { echo "BACKUP_EXPORT_MANIFEST=FAIL"; exit 65; }
mv "$temporary" "$output"
trap - EXIT INT TERM
echo "BACKUP_EXPORT_MANIFEST=PASS"
