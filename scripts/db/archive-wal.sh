#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || { echo "usage: archive-wal.sh source-path wal-filename" >&2; exit 64; }
source_path="$1"
wal_filename="$2"
: "${P1_06_WAL_ARCHIVE_DIR:?P1_06_WAL_ARCHIVE_DIR is required}"
[[ "$P1_06_WAL_ARCHIVE_DIR" = /* ]] || { echo "WAL archive directory must be absolute" >&2; exit 65; }
[[ "$wal_filename" =~ ^[0-9A-F]{24}(\.[a-z0-9]+)?$ ]] || {
  echo "Invalid WAL archive filename" >&2
  exit 65
}
[[ -r "$source_path" ]] || { echo "WAL source is not readable" >&2; exit 66; }

umask 077
mkdir -p "$P1_06_WAL_ARCHIVE_DIR"
destination="$P1_06_WAL_ARCHIVE_DIR/$wal_filename"

if [[ -e "$destination" ]]; then
  cmp --silent "$source_path" "$destination" && exit 0
  echo "Refusing to overwrite a different archived WAL file" >&2
  exit 73
fi

temporary="$P1_06_WAL_ARCHIVE_DIR/.${wal_filename}.$$"
trap 'rm -f "$temporary"' EXIT INT TERM
cp "$source_path" "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$destination"
trap - EXIT INT TERM
