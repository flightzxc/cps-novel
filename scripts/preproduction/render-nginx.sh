#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
template="$root/infra/preproduction/nginx/cps-novel-preprod.conf.template"
bootstrap=0
bootstrap_public=0
mode=preprod
hsts_max_age=86400
output=""
upstream="127.0.0.1:3000"
while (($#)); do
  case "$1" in
    --output) output="${2:-}"; shift 2 ;;
    --bootstrap) bootstrap=1; shift ;;
    --bootstrap-public) bootstrap_public=1; shift ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --hsts-max-age) hsts_max_age="${2:-}"; shift 2 ;;
    --test-upstream)
      [[ "${PREPROD_NGINX_TEST_MODE:-0}" == "1" ]] || {
        echo "ERROR: --test-upstream requires PREPROD_NGINX_TEST_MODE=1" >&2
        exit 65
      }
      upstream="${2:-}"; shift 2 ;;
    *) echo "usage: render-nginx.sh --output FILE [--mode preprod|rehearsal|public] [--hsts-max-age SECONDS] [--bootstrap|--bootstrap-public] [--test-upstream HOST:PORT]" >&2; exit 64 ;;
  esac
done
[[ -n "$output" && "$output" = /* ]] || { echo "ERROR: absolute --output is required" >&2; exit 64; }
case "$mode" in preprod|rehearsal|public) ;; *) echo "ERROR: invalid mode" >&2; exit 64 ;; esac
if (( bootstrap + bootstrap_public > 1 )) || { (( bootstrap + bootstrap_public > 0 )) && [[ "$mode" != "preprod" ]]; }; then
  echo "ERROR: bootstrap and site modes are mutually exclusive" >&2; exit 64
fi
[[ "$hsts_max_age" =~ ^[1-9][0-9]{0,8}$ ]] && (( hsts_max_age <= 31536000 )) || { echo "ERROR: invalid HSTS max-age" >&2; exit 64; }
# The bootstrap template has no __UPSTREAM__ token and no upstream block at
# all (see its own header comment), so it needs no substitution -- it is
# copied through verbatim rather than run through sed.
((bootstrap)) && template="$root/infra/preproduction/nginx/cps-novel-preprod-bootstrap.conf.template"
[[ "$upstream" == "127.0.0.1:3000" || "$upstream" =~ ^[a-z0-9-]+:[1-9][0-9]{0,4}$ ]] || {
  echo "ERROR: invalid upstream" >&2
  exit 65
}
umask 077
mkdir -p "$(dirname "$output")"
temporary="${output}.tmp.$$"
trap 'rm -f "$temporary"' EXIT INT TERM
if ((bootstrap_public)); then
  cp "$root/infra/preproduction/nginx/cps-novel-public-bootstrap.conf.template" "$temporary"
elif [[ "$mode" != "preprod" ]]; then
  node "$root/scripts/preproduction/render-public-nginx.mjs" "$mode" "$upstream" "$hsts_max_age" >"$temporary"
elif ((bootstrap)); then
  cp "$template" "$temporary"
else
  sed "s/__UPSTREAM__/$upstream/g" "$template" >"$temporary"
fi
mv "$temporary" "$output"
trap - EXIT INT TERM
echo "NGINX_RENDER=PASS"
