#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for command in docker curl openssl; do command -v "$command" >/dev/null 2>&1 || { echo "NGINX_MATRIX=FAIL"; exit 69; }; done
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cps-nginx-matrix.XXXXXX")"
network="cps-nginx-matrix-$$"
mock="cps-nginx-mock-$$"
edge="cps-nginx-edge-$$"
bootstrap="cps-nginx-bootstrap-$$"
cleanup() {
  docker rm -f "$edge" "$mock" "$bootstrap" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

mkdir -p "$tmp/snippets" "$tmp/shared/secrets" "$tmp/shared/maintenance" \
  "$tmp/acme/.well-known/acme-challenge" "$tmp/certs/www.bangbangji.cloud" "$tmp/certs/zbcwf.bangbangji.cloud"
cp "$root"/infra/preproduction/nginx/cps-novel-preprod-*.conf "$tmp/snippets/"
printf 'qa:%s\n' "$(openssl passwd -apr1 matrix-secret)" >"$tmp/shared/secrets/nginx-preprod.htpasswd"
printf 'challenge-ok\n' >"$tmp/acme/.well-known/acme-challenge/probe"
# Real maintenance page, not a hand-rolled stand-in: verify-release.sh
# grep -qF's the exact known body, and that check is only meaningful here if
# this fixture is the actual file nginx will serve in production.
cp "$root/infra/preproduction/maintenance/__preprod_maintenance.html" "$tmp/shared/maintenance/__preprod_maintenance.html"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=www.bangbangji.cloud' \
  -keyout "$tmp/certs/www.bangbangji.cloud/privkey.pem" \
  -out "$tmp/certs/www.bangbangji.cloud/fullchain.pem" >/dev/null 2>&1
cp "$tmp/certs/www.bangbangji.cloud/privkey.pem" "$tmp/certs/zbcwf.bangbangji.cloud/privkey.pem"
cp "$tmp/certs/www.bangbangji.cloud/fullchain.pem" "$tmp/certs/zbcwf.bangbangji.cloud/fullchain.pem"
PREPROD_NGINX_TEST_MODE=1 "$root/scripts/preproduction/render-nginx.sh" \
  --output "$tmp/preprod.conf" --test-upstream mock-web:80 >/dev/null
cat >"$tmp/mock.conf" <<'EOF'
server {
  listen 80;
  location = /missing { return 404 "NOT_FOUND"; }
  location / { return 200 "BUSINESS_CONTENT"; }
}
EOF

docker network create "$network" >/dev/null
docker run -d --name "$mock" --network "$network" --network-alias mock-web \
  -v "$tmp/mock.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.24.0-alpine >/dev/null
docker run -d --name "$edge" --network "$network" -p 127.0.0.1::80 -p 127.0.0.1::443 \
  -v "$tmp/preprod.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$tmp/snippets:/etc/nginx/snippets:ro" \
  -v "$tmp/certs:/etc/letsencrypt/live:ro" \
  -v "$tmp/shared:/opt/cps-novel/shared" \
  -v "$tmp/acme:/var/lib/letsencrypt:ro" \
  nginx:1.24.0-alpine >/dev/null
docker exec "$edge" nginx -t >/dev/null 2>&1
https_port="$(docker port "$edge" 443/tcp | head -1 | awk -F: '{print $NF}')"
http_port="$(docker port "$edge" 80/tcp | head -1 | awk -F: '{print $NF}')"

request() {
  local host="$1" path="$2" auth="${3:-0}" body="$tmp/body" headers="$tmp/headers"
  local args=(--noproxy '*' --silent --show-error --insecure --resolve "$host:$https_port:127.0.0.1" -D "$headers" -o "$body" -w '%{http_code}')
  [[ "$auth" == "0" ]] || args+=(-u qa:matrix-secret)
  curl "${args[@]}" "https://$host:$https_port$path"
}

paths=(/ /en /novel/example-pabc /api/health /robots.txt /sitemap.xml /sitemap/en.xml /_next/static/example.js /missing)
for path in "${paths[@]}"; do
  code="$(request www.bangbangji.cloud "$path")"
  [[ "$code" == "401" ]] || { echo "NGINX_MATRIX=FAIL path=$path anonymous=$code"; exit 65; }
  ! grep -q BUSINESS_CONTENT "$tmp/body"
  grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$tmp/headers"
  code="$(request www.bangbangji.cloud "$path" 1)"
  if [[ "$path" == "/missing" ]]; then [[ "$code" == "404" ]]; else [[ "$code" == "200" ]]; fi
done
for path in /login /dashboard /api/admin; do
  [[ "$(request www.bangbangji.cloud "$path")" == "404" ]]
  ! grep -q BUSINESS_CONTENT "$tmp/body"
  grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$tmp/headers"
done
[[ "$(request zbcwf.bangbangji.cloud /login)" == "401" ]]
[[ "$(request zbcwf.bangbangji.cloud /login 1)" == "200" ]]
[[ "$(request zbcwf.bangbangji.cloud /)" == "404" ]]
[[ "$(request wrong.bangbangji.cloud /)" == "404" ]]

# --- Admin host: exact-match /api/health closes the prefix-match hole, and
# /_next/static/ is the one new asset location (see ADR). ---
[[ "$(request zbcwf.bangbangji.cloud /_next/static/example.js)" == "401" ]] || {
  echo "NGINX_MATRIX=FAIL case=admin_next_static_anonymous"; exit 65;
}
grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$tmp/headers"
[[ "$(request zbcwf.bangbangji.cloud /_next/static/example.js 1)" == "200" ]] || {
  echo "NGINX_MATRIX=FAIL case=admin_next_static_authenticated"; exit 65;
}
[[ "$(request zbcwf.bangbangji.cloud /api/health)" == "401" ]] || {
  echo "NGINX_MATRIX=FAIL case=admin_health_anonymous"; exit 65;
}
[[ "$(request zbcwf.bangbangji.cloud /api/health 1)" == "200" ]] || {
  echo "NGINX_MATRIX=FAIL case=admin_health_authenticated"; exit 65;
}
# MINOR-7: /api/health/worker and /api/health/backup (see src/app/api/
# health/) were served by the old `^~ /api/health` prefix match; the exact
# `=` match above does not cover them (it matches only the literal path).
# `location ^~ /api/health/` (trailing slash) restores that coverage --
# must not 404.
[[ "$(request zbcwf.bangbangji.cloud /api/health/worker)" == "401" ]] || {
  echo "NGINX_MATRIX=FAIL case=admin_health_worker_subroute_anonymous"; exit 65;
}
[[ "$(request zbcwf.bangbangji.cloud /api/health/worker 1)" == "200" ]] || {
  echo "NGINX_MATRIX=FAIL case=admin_health_worker_subroute_authenticated"; exit 65;
}
# Measured evidence: the old `^~ /api/health` prefix also matched this path.
# The exact `=` match must not.
[[ "$(request zbcwf.bangbangji.cloud /api/health-anything)" == "404" ]] || {
  echo "NGINX_MATRIX=FAIL case=admin_health_anything_anonymous"; exit 65;
}
[[ "$(request zbcwf.bangbangji.cloud /api/health-anything 1)" == "404" ]] || {
  echo "NGINX_MATRIX=FAIL case=admin_health_anything_authenticated"; exit 65;
}

location="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{redirect_url}' \
  --resolve "www.bangbangji.cloud:$http_port:127.0.0.1" "http://www.bangbangji.cloud:$http_port/path?q=1")"
[[ "$location" == "https://www.bangbangji.cloud/path?q=1" ]]
[[ "$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' \
  --resolve "www.bangbangji.cloud:$http_port:127.0.0.1" "http://www.bangbangji.cloud:$http_port/.well-known/acme-challenge/probe")" == "200" ]]

# --- Maintenance ON: business/login surfaces are gated (both anonymous and
# authenticated -- previously only authenticated was tested here), the body
# must be the real maintenance page, and /api/health stays reachable behind
# auth on BOTH hosts because it uses the nomaintenance snippet. ---
: >"$tmp/shared/maintenance/enabled"
[[ "$(request www.bangbangji.cloud / 1)" == "503" ]] || { echo "NGINX_MATRIX=FAIL case=maintenance_authenticated"; exit 65; }
grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$tmp/headers"
grep -qF '<h1>Maintenance in progress</h1>' "$tmp/body" || { echo "NGINX_MATRIX=FAIL case=maintenance_body_authenticated"; exit 65; }
[[ "$(request www.bangbangji.cloud / 0)" == "503" ]] || { echo "NGINX_MATRIX=FAIL case=maintenance_anonymous"; exit 65; }
grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$tmp/headers"
grep -qF '<h1>Maintenance in progress</h1>' "$tmp/body" || { echo "NGINX_MATRIX=FAIL case=maintenance_body_anonymous"; exit 65; }
[[ "$(request www.bangbangji.cloud /api/health 0)" == "401" ]] || { echo "NGINX_MATRIX=FAIL case=maintenance_public_health_anonymous"; exit 65; }
[[ "$(request www.bangbangji.cloud /api/health 1)" == "200" ]] || { echo "NGINX_MATRIX=FAIL case=maintenance_public_health_authenticated"; exit 65; }
[[ "$(request zbcwf.bangbangji.cloud /api/health 0)" == "401" ]] || { echo "NGINX_MATRIX=FAIL case=maintenance_admin_health_anonymous"; exit 65; }
[[ "$(request zbcwf.bangbangji.cloud /api/health 1)" == "200" ]] || { echo "NGINX_MATRIX=FAIL case=maintenance_admin_health_authenticated"; exit 65; }
# MINOR-7: unlike the top-level /api/health exact match (nomaintenance
# snippet), the /api/health/ sub-route block deliberately uses the
# maintenance-gated protected.conf -- prove it actually IS gated, not just
# that it exists.
[[ "$(request zbcwf.bangbangji.cloud /api/health/worker 1)" == "503" ]] || {
  echo "NGINX_MATRIX=FAIL case=maintenance_admin_health_worker_subroute_gated"; exit 65;
}
grep -qF '<h1>Maintenance in progress</h1>' "$tmp/body" || {
  echo "NGINX_MATRIX=FAIL case=maintenance_admin_health_worker_subroute_body"; exit 65;
}
rm "$tmp/shared/maintenance/enabled"

: >"$tmp/rate-codes"
for _ in {1..80}; do
  (request www.bangbangji.cloud /api/health 1 >>"$tmp/rate-codes") &
done
wait
grep -q 429 "$tmp/rate-codes"

docker stop "$mock" >/dev/null
[[ "$(request www.bangbangji.cloud / 1)" == "502" ]]
grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$tmp/headers"

# --- Stage-1 bootstrap template: rendered independently of the edge/mock
# rig above (it has no upstream to point at). Confirms it is structurally
# incapable of serving application content (no cert directive, no reverse
# proxy) and that nginx -t passes with zero certs on disk, then proves the
# ACME path serves on both hosts while everything else is closed. ---
bootstrap_tmp="$tmp/bootstrap"
mkdir -p "$bootstrap_tmp/snippets" "$bootstrap_tmp/acme/.well-known/acme-challenge"
cp "$root/infra/preproduction/nginx/cps-novel-preprod-security.conf" "$bootstrap_tmp/snippets/"
printf 'bootstrap-challenge-ok\n' >"$bootstrap_tmp/acme/.well-known/acme-challenge/probe"
"$root/scripts/preproduction/render-nginx.sh" --bootstrap --output "$bootstrap_tmp/bootstrap.conf" >/dev/null

grep -q 'ssl_certificate' "$bootstrap_tmp/bootstrap.conf" && { echo "NGINX_MATRIX=FAIL case=bootstrap_has_cert_directive"; exit 65; }
grep -q 'proxy_pass' "$bootstrap_tmp/bootstrap.conf" && { echo "NGINX_MATRIX=FAIL case=bootstrap_has_proxy_pass"; exit 65; }

docker run -d --name "$bootstrap" -p 127.0.0.1::80 \
  -v "$bootstrap_tmp/bootstrap.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$bootstrap_tmp/snippets:/etc/nginx/snippets:ro" \
  -v "$bootstrap_tmp/acme:/var/lib/letsencrypt:ro" \
  nginx:1.24.0-alpine >/dev/null
docker exec "$bootstrap" nginx -t >/dev/null 2>&1 || {
  echo "NGINX_MATRIX=FAIL case=bootstrap_nginx_test"; docker logs "$bootstrap"; exit 65;
}
bootstrap_port="$(docker port "$bootstrap" 80/tcp | head -1 | awk -F: '{print $NF}')"

bootstrap_request() {
  local host="$1" path="$2"
  curl --noproxy '*' --silent --show-error -o "$tmp/bootstrap-body" -D "$tmp/bootstrap-headers" --write-out '%{http_code}' \
    --resolve "$host:$bootstrap_port:127.0.0.1" "http://$host:$bootstrap_port$path"
}

[[ "$(bootstrap_request www.bangbangji.cloud /.well-known/acme-challenge/probe)" == "200" ]] || {
  echo "NGINX_MATRIX=FAIL case=bootstrap_acme_public"; exit 65;
}
grep -q bootstrap-challenge-ok "$tmp/bootstrap-body"
[[ "$(bootstrap_request zbcwf.bangbangji.cloud /.well-known/acme-challenge/probe)" == "200" ]] || {
  echo "NGINX_MATRIX=FAIL case=bootstrap_acme_admin"; exit 65;
}
[[ "$(bootstrap_request www.bangbangji.cloud /)" == "404" ]] || {
  echo "NGINX_MATRIX=FAIL case=bootstrap_public_root_404"; exit 65;
}
grep -qi '^X-Robots-Tag: noindex, nofollow, noarchive' "$tmp/bootstrap-headers"
[[ "$(bootstrap_request zbcwf.bangbangji.cloud /)" == "404" ]] || {
  echo "NGINX_MATRIX=FAIL case=bootstrap_admin_root_404"; exit 65;
}
# Unknown host hits `listen 80 default_server; server_name _; return 444;`,
# which closes the connection with no response -- curl fails, proving there
# is no fallback content to serve, not even by falling through to a
# catch-all that returns something.
if curl --noproxy '*' --silent --show-error --output /dev/null \
  --resolve "unknown.example.com:$bootstrap_port:127.0.0.1" "http://unknown.example.com:$bootstrap_port/"; then
  echo "NGINX_MATRIX=FAIL case=bootstrap_unknown_host_not_closed"; exit 65
fi

echo "NGINX_MATRIX=PASS"
