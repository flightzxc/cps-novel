#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cps-worker-sigterm.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM
[[ -x "$root/node_modules/.bin/esbuild" ]] || { echo "WORKER_SIGTERM=FAIL"; exit 69; }
"$root/node_modules/.bin/esbuild" \
  "$root/tests/backend/runtime/fixtures/worker-sigterm-child.ts" \
  --bundle --platform=node --format=esm --outfile="$tmp/worker-sigterm-child.mjs" >/dev/null 2>&1

for mode in drain timeout; do
  events="$tmp/$mode.events"; ready="$tmp/$mode.ready"
  : >"$events"
  node "$tmp/worker-sigterm-child.mjs" "$mode" "$events" "$ready" &
  pid=$!
  for _ in {1..100}; do [[ -f "$ready" ]] && break; sleep 0.05; done
  [[ -f "$ready" ]] || { kill "$pid" 2>/dev/null || true; echo "WORKER_SIGTERM=FAIL"; exit 70; }
  kill -TERM "$pid"
  # 45s Compose grace is far above both the real 30s drain and this bounded
  # process proof. No KILL is sent by this harness.
  for _ in {1..200}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.05; done
  if kill -0 "$pid" 2>/dev/null; then
    echo "WORKER_SIGTERM=FAIL"; exit 70
  fi
  wait "$pid"
  grep -qx sigterm_observed "$events"
  grep -qx prisma_disconnected "$events"
  grep -qx process_exit "$events"
  if [[ "$mode" == "drain" ]]; then grep -qx handler_completed "$events"; else grep -qx drain_timeout "$events"; fi
done
echo "WORKER_SIGTERM=PASS"
