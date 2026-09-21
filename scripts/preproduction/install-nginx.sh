#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${PREPROD_OWNER_SUDO_APPROVED:-}" == "YES" ]] || {
  echo "NGINX_INSTALL=REFUSED reason=owner_sudo_approval"; exit 65;
}
command -v nginx >/dev/null 2>&1 || { echo "NGINX_INSTALL=FAIL reason=nginx_missing"; exit 69; }
version="$(nginx -v 2>&1)"
[[ "$version" == *"nginx/1.24."* ]] || { echo "NGINX_INSTALL=REFUSED reason=nginx_version"; exit 65; }

bootstrap=0
for arg in "$@"; do
  case "$arg" in
    --bootstrap) bootstrap=1 ;;
    *) echo "NGINX_INSTALL=REFUSED reason=usage"; echo "usage: install-nginx.sh [--bootstrap]" >&2; exit 64 ;;
  esac
done

shared="${PREPROD_SHARED_ROOT:-/opt/cps-novel/shared}"
default_site="/etc/nginx/sites-enabled/default"
default_site_state="$shared/nginx-default-site-state.txt"
default_site_backup="$shared/nginx-default-site.backup"

security_snippet_dst="/etc/nginx/snippets/cps-novel-preprod-security.conf"
protected_snippet_dst="/etc/nginx/snippets/cps-novel-preprod-protected.conf"
nomaintenance_snippet_dst="/etc/nginx/snippets/cps-novel-preprod-protected-nomaintenance.conf"
proxy_snippet_dst="/etc/nginx/snippets/cps-novel-preprod-proxy.conf"
site_dst="/etc/nginx/conf.d/cps-novel-preprod.conf"

rendered="$(mktemp /tmp/cps-novel-preprod-nginx.XXXXXX)"
file_backup_dir="$(mktemp -d /tmp/cps-novel-preprod-nginx-backup.XXXXXX)"
trap 'rm -f "$rendered"; rm -rf "$file_backup_dir"' EXIT INT TERM

if ((bootstrap)); then
  "$root/scripts/preproduction/render-nginx.sh" --bootstrap --output "$rendered" >/dev/null
else
  "$root/scripts/preproduction/render-nginx.sh" --output "$rendered" >/dev/null
fi

# --- Back up everything this invocation is about to overwrite, so a failed
# `nginx -t` below can restore the host completely, not just delete one
# file. Bootstrap mode only ever touches the security snippet and the site
# file, so the other snippets are simply never backed up/installed in that
# mode. ---
backup_existing() {
  local src="$1" name="$2"
  [[ -e "$src" ]] && sudo cp -a "$src" "$file_backup_dir/$name"
  return 0
}
backup_existing "$security_snippet_dst" security.conf
backup_existing "$protected_snippet_dst" protected.conf
backup_existing "$nomaintenance_snippet_dst" nomaintenance.conf
backup_existing "$proxy_snippet_dst" proxy.conf
backup_existing "$site_dst" site.conf

# --- Root cause D: Ubuntu ships /etc/nginx/sites-enabled/default with its
# own `listen 80 default_server;`, which collides with this template's own
# default_server blocks and makes `nginx -t` fail with "duplicate default
# server for 0.0.0.0:80". Hand it over -- record its original state under
# the shared root, then disable it -- BEFORE running `nginx -t` below.
# Only touch it if it actually declares default_server: an unrelated,
# already-customized default site is left alone entirely (nothing recorded,
# nothing to restore). ---
default_site_disabled=0
if { [[ -e "$default_site" ]] || [[ -L "$default_site" ]]; } \
  && grep -q 'default_server' "$default_site" 2>/dev/null; then
  sudo mkdir -p "$shared"
  if [[ -L "$default_site" ]]; then
    printf 'kind=symlink\ntarget=%s\n' "$(readlink "$default_site")" | sudo tee "$default_site_state" >/dev/null
  else
    printf 'kind=file\n' | sudo tee "$default_site_state" >/dev/null
  fi
  # `cp -a` on a symlink source copies the link itself (does not follow it),
  # so this is a byte/link-for-link backup regardless of which kind it is.
  sudo cp -a "$default_site" "$default_site_backup"
  sudo rm -f "$default_site"
  default_site_disabled=1
fi

# --- Install the candidate files, then test BEFORE reloading. Previously
# this script installed the site config first and only ran `sudo nginx -t`
# afterward, with no way back -- a failing test left an invalid file
# installed as the live config with nginx still running the old (valid) one
# in memory, i.e. exactly the "file installed but config invalid" state we
# want to avoid. nginx does not re-read conf.d/snippets until reloaded, so
# as long as we never call `systemctl reload` before a passing `nginx -t`,
# the *serving* process is never handed an invalid config; the backups above
# let us also put the *files on disk* back to a known-good state
# immediately if the test fails, rather than leaving a broken file sitting
# in place. ---
sudo install -o root -g root -m 0644 \
  "$root/infra/preproduction/nginx/cps-novel-preprod-security.conf" "$security_snippet_dst"
if ((bootstrap)); then
  sudo install -o root -g root -m 0644 "$rendered" "$site_dst"
else
  sudo install -o root -g root -m 0644 \
    "$root/infra/preproduction/nginx/cps-novel-preprod-protected.conf" "$protected_snippet_dst"
  sudo install -o root -g root -m 0644 \
    "$root/infra/preproduction/nginx/cps-novel-preprod-protected-nomaintenance.conf" "$nomaintenance_snippet_dst"
  sudo install -o root -g root -m 0644 \
    "$root/infra/preproduction/nginx/cps-novel-preprod-proxy.conf" "$proxy_snippet_dst"
  sudo install -o root -g root -m 0644 "$rendered" "$site_dst"
fi

# --- Rollback restores every path this invocation touched: all snippets,
# the site config, AND the default-site symlink/file -- not just "delete one
# file" -- then re-tests and reloads so the running process matches the
# restored files. ---
rollback_all() {
  restore_one() {
    local dst="$1" name="$2"
    if [[ -e "$file_backup_dir/$name" ]]; then
      sudo install -o root -g root -m 0644 "$file_backup_dir/$name" "$dst"
    else
      sudo rm -f "$dst"
    fi
  }
  restore_one "$security_snippet_dst" security.conf
  restore_one "$protected_snippet_dst" protected.conf
  restore_one "$nomaintenance_snippet_dst" nomaintenance.conf
  restore_one "$proxy_snippet_dst" proxy.conf
  restore_one "$site_dst" site.conf
  if [[ "$default_site_disabled" == "1" ]]; then
    sudo cp -a "$default_site_backup" "$default_site"
    sudo rm -f "$default_site_backup" "$default_site_state"
  fi
}

if ! sudo nginx -t; then
  rollback_all
  # Confirm the rollback itself leaves a valid config before reloading into it.
  sudo nginx -t
  sudo systemctl reload nginx
  echo "NGINX_INSTALL=REFUSED reason=nginx_test_failed"
  exit 65
fi

sudo systemctl reload nginx
echo "NGINX_INSTALL=PASS"
