#!/usr/bin/env bash
set -euo pipefail
set +x

install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/wal-archive
exec /usr/local/bin/docker-entrypoint.sh "$@"
