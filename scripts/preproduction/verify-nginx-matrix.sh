#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for command in docker curl openssl; do command -v "$command" >/dev/null 2>&1 || { echo "NGINX_MATRIX=FAIL"; exit 69; }; done
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cps-nginx-matrix.XXXXXX")"
network="cps-nginx-matrix-$$"
mock="cps-nginx-mock-$$"
edge="cps-nginx-edge-$$"
cleanup() {
  docker rm -f "$edge" "$mock" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

mkdir -p "$tmp/snippets" "$tmp/shared/secrets" "$tmp/shared/maintenance" \
  "$tmp/acme/.well-known/acme-challenge" "$tmp/certs/www.bangbangji.cloud" "$tmp/certs/zbcwf.bangbangji.cloud"
cp "$root"/infra/preproduction/nginx/cps-novel-preprod-*.conf "$tmp/snippets/"
printf 'qa:%s\n' "$(openssl passwd -apr1 matrix-secret)" >"$tmp/shared/secrets/nginx-preprod.htpasswd"
printf 'challenge-ok\n' >"$tmp/acme/.well-known/acme-challenge/probe"
printf '<h1>maintenance</h1>\n' >"$tmp/shared/maintenance/__preprod_maintenance.html"
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

location="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{redirect_url}' \
  --resolve "www.bangbangji.cloud:$http_port:127.0.0.1" "http://www.bangbangji.cloud:$http_port/path?q=1")"
[[ "$location" == "https://www.bangbangji.cloud/path?q=1" ]]
[[ "$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' \
  --resolve "www.bangbangji.cloud:$http_port:127.0.0.1" "http://www.bangbangji.cloud:$http_port/.well-known/acme-challenge/probe")" == "200" ]]

: >"$tmp/shared/maintenance/enabled"
[[ "$(request www.bangbangji.cloud / 1)" == "503" ]]
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
echo "NGINX_MATRIX=PASS"
