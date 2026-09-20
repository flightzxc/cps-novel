#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${PREPROD_OWNER_SUDO_APPROVED:-}" == "YES" ]] || {
  echo "NGINX_INSTALL=REFUSED reason=owner_sudo_approval"; exit 65;
}
command -v nginx >/dev/null 2>&1 || { echo "NGINX_INSTALL=FAIL reason=nginx_missing"; exit 69; }
version="$(nginx -v 2>&1)"
[[ "$version" == *"nginx/1.24."* ]] || { echo "NGINX_INSTALL=REFUSED reason=nginx_version"; exit 65; }

rendered="$(mktemp /tmp/cps-novel-preprod-nginx.XXXXXX)"
trap 'rm -f "$rendered"' EXIT INT TERM
"$root/scripts/preproduction/render-nginx.sh" --output "$rendered" >/dev/null

sudo install -o root -g root -m 0644 \
  "$root/infra/preproduction/nginx/cps-novel-preprod-security.conf" \
  /etc/nginx/snippets/cps-novel-preprod-security.conf
sudo install -o root -g root -m 0644 \
  "$root/infra/preproduction/nginx/cps-novel-preprod-protected.conf" \
  /etc/nginx/snippets/cps-novel-preprod-protected.conf
sudo install -o root -g root -m 0644 \
  "$root/infra/preproduction/nginx/cps-novel-preprod-proxy.conf" \
  /etc/nginx/snippets/cps-novel-preprod-proxy.conf
sudo install -o root -g root -m 0644 "$rendered" /etc/nginx/conf.d/cps-novel-preprod.conf
sudo nginx -t
sudo systemctl reload nginx
echo "NGINX_INSTALL=PASS"
