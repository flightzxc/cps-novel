#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
template="$root/infra/preproduction/nginx/cps-novel-preprod.conf.template"
output=""
upstream="127.0.0.1:3000"
while (($#)); do
  case "$1" in
    --output) output="${2:-}"; shift 2 ;;
    --test-upstream)
      [[ "${PREPROD_NGINX_TEST_MODE:-0}" == "1" ]] || {
        echo "ERROR: --test-upstream requires PREPROD_NGINX_TEST_MODE=1" >&2
        exit 65
      }
      upstream="${2:-}"; shift 2 ;;
    *) echo "usage: render-nginx.sh --output FILE [--test-upstream HOST:PORT]" >&2; exit 64 ;;
  esac
done
[[ -n "$output" && "$output" = /* ]] || { echo "ERROR: absolute --output is required" >&2; exit 64; }
[[ "$upstream" == "127.0.0.1:3000" || "$upstream" =~ ^[a-z0-9-]+:[1-9][0-9]{0,4}$ ]] || {
  echo "ERROR: invalid upstream" >&2
  exit 65
}
umask 077
mkdir -p "$(dirname "$output")"
temporary="${output}.tmp.$$"
trap 'rm -f "$temporary"' EXIT INT TERM
sed "s/__UPSTREAM__/$upstream/g" "$template" >"$temporary"
mv "$temporary" "$output"
trap - EXIT INT TERM
echo "NGINX_RENDER=PASS"
