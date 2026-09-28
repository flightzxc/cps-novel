#!/usr/bin/env bash
# Local-only: build this Dockerfile and verify the approved image asset.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
commit="$(git rev-parse HEAD)"
version="$(node -p 'require("./package.json").version')"
image="cps-novel:cutover-local-${commit:0:7}"
container="cps-cutover-brand-$$"
tmp="$(mktemp -d)"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT INT TERM
docker build --platform linux/amd64 --build-arg "APP_VERSION=$version" \
  --build-arg "GIT_COMMIT=$commit" --build-arg "BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg "NEXT_PUBLIC_BUILD_VERSION=v$version" -t "$image" .
docker run -d --name "$container" -p 127.0.0.1::3000 \
  -e SITE_URL=https://pulsenovels.com -e ADMIN_CANONICAL_ORIGIN=https://zbcwf.pulsenovels.com \
  -e "APP_VERSION=$version" -e "GIT_COMMIT=$commit" "$image" >/dev/null
port="$(docker port "$container" 3000/tcp | awk -F: 'NR==1 {print $NF}')"
ready=0
for attempt in $(seq 1 60); do
  if curl --noproxy '*' --silent --show-error --fail -H 'Host: pulsenovels.com' \
    -D "$tmp/headers" -o "$tmp/image.png" "http://127.0.0.1:$port/brand/og-default.png"; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { docker logs "$container"; echo 'BRAND_IMAGE=FAIL reason=http'; exit 65; }
grep -Eq '^HTTP/[0-9.]+ 200([[:space:]]|$)' "$tmp/headers" || { echo 'BRAND_IMAGE=FAIL reason=status'; exit 65; }
grep -qi '^Content-Type: image/png' "$tmp/headers" || { echo 'BRAND_IMAGE=FAIL reason=content_type'; exit 65; }
cmp public/brand/og-default.png "$tmp/image.png" || { echo 'BRAND_IMAGE=FAIL reason=bytes'; exit 65; }
checksum="$(shasum -a 256 "$tmp/image.png" | awk '{print $1}')"
[[ "$checksum" == c4a4a7f4d89a6bce6a3bbf6b50c965cfce53982f85c8aed76be17367731627fb ]] || { echo 'BRAND_IMAGE=FAIL reason=sha256'; exit 65; }
echo "BRAND_IMAGE=PASS image=$image status=200 content_type=image/png sha256=$checksum"
