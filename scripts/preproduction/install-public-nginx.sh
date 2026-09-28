#!/usr/bin/env bash
# Called by install-nginx.sh after its approval and nginx-version checks.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${PREPROD_OWNER_SUDO_APPROVED:-}" == YES ]] || { echo 'NGINX_INSTALL=REFUSED reason=owner_sudo_approval'; exit 65; }
mode=preprod
bootstrap_public=0
hsts=86400
restore=""
while (($#)); do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --hsts-max-age) hsts="${2:-}"; shift 2 ;;
    --bootstrap-public) bootstrap_public=1; shift ;;
    --restore-backup) restore="${2:-}"; shift 2 ;;
    *) echo 'NGINX_INSTALL=REFUSED reason=usage'; exit 64 ;;
  esac
done
shared="${PREPROD_SHARED_ROOT:-/opt/cps-novel/shared}"
[[ "$shared" = /* ]] || { echo 'NGINX_INSTALL=REFUSED reason=shared_root'; exit 64; }
case "$mode" in preprod|rehearsal|public) ;; *) echo 'NGINX_INSTALL=REFUSED reason=mode'; exit 64 ;; esac
if ((bootstrap_public)) && [[ "$mode" != preprod ]]; then echo 'NGINX_INSTALL=REFUSED reason=bootstrap_mode'; exit 64; fi
if [[ -n "$restore" ]] && { ((bootstrap_public)) || [[ "$mode" != preprod ]]; }; then echo 'NGINX_INSTALL=REFUSED reason=restore_mode'; exit 64; fi
# Fixed inventory: never restore arbitrary paths supplied by a backup manifest.
paths=(
  /etc/nginx/conf.d/cps-novel-preprod.conf
  /etc/nginx/conf.d/cps-novel-public-bootstrap.conf
  /etc/nginx/snippets/cps-novel-preprod-security.conf
  /etc/nginx/snippets/cps-novel-preprod-protected.conf
  /etc/nginx/snippets/cps-novel-preprod-protected-nomaintenance.conf
  /etc/nginx/snippets/cps-novel-preprod-proxy.conf
  /etc/nginx/snippets/cps-novel-edge-public-security.conf
  /etc/nginx/snippets/cps-novel-edge-admin-security.conf
  /etc/nginx/snippets/cps-novel-edge-maintenance.conf
  /etc/nginx/sites-enabled/default
)
validate_backup() {
  local dir="$1" i
  case "$dir" in "$shared"/nginx-backups/install.*) ;; *) return 65 ;; esac
  sudo test -f "$dir/READY" || return 65
  for ((i=0; i<${#paths[@]}; i++)); do
    if sudo test -f "$dir/$i.present"; then
      { sudo test -e "$dir/$i.file" || sudo test -L "$dir/$i.file"; } || return 65
      if sudo test -e "$dir/$i.absent"; then return 65; fi
    else
      sudo test -f "$dir/$i.absent" || return 65
    fi
  done
}
restore_files() {
  local dir="$1" i
  validate_backup "$dir" || { echo "NGINX_INSTALL=REFUSED reason=backup_invalid backup_dir=$dir"; return 65; }
  for ((i=0; i<${#paths[@]}; i++)); do
    sudo rm -f "${paths[$i]}" || return 70
    if sudo test -f "$dir/$i.present"; then
      sudo cp -a "$dir/$i.file" "${paths[$i]}" || return 70
    fi
  done
}
if [[ -n "$restore" ]]; then validate_backup "$restore" || { echo 'NGINX_INSTALL=REFUSED reason=backup_invalid'; exit 65; }; fi
rendered="$(mktemp)"
backup_dir=""
mutated=0
finished=0
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  rm -f "$rendered"
  if (( mutated && ! finished )); then
    if restore_files "$backup_dir" && sudo nginx -t && sudo systemctl reload nginx; then
      echo "NGINX_INSTALL=REFUSED reason=candidate_failed_restored backup_dir=$backup_dir" >&2
    else
      echo "NGINX_INSTALL=REFUSED reason=rollback_failed backup_dir=$backup_dir" >&2
      status=71
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -z "$restore" ]]; then
  if ((bootstrap_public)); then
    "$root/scripts/preproduction/render-nginx.sh" --bootstrap-public --output "$rendered"
  else
    "$root/scripts/preproduction/render-nginx.sh" --mode "$mode" --hsts-max-age "$hsts" --output "$rendered"
  fi
fi
sudo mkdir -p "$shared/nginx-backups"
backup_dir="$(sudo mktemp -d "$shared/nginx-backups/install.XXXXXXXX")"
for ((i=0; i<${#paths[@]}; i++)); do
  if sudo test -e "${paths[$i]}" || sudo test -L "${paths[$i]}"; then
    sudo cp -a "${paths[$i]}" "$backup_dir/$i.file"
    sudo touch "$backup_dir/$i.present"
  else
    sudo touch "$backup_dir/$i.absent"
  fi
done
sudo touch "$backup_dir/READY"
echo "NGINX_BACKUP=$backup_dir"
mutated=1
if [[ -n "$restore" ]]; then
  restore_files "$restore"
elif ((bootstrap_public)); then
  sudo install -o root -g root -m 0644 "$rendered" /etc/nginx/conf.d/cps-novel-public-bootstrap.conf
else
  sudo mkdir -p /etc/nginx/snippets
  for name in cps-novel-preprod-security cps-novel-preprod-protected cps-novel-preprod-protected-nomaintenance cps-novel-preprod-proxy cps-novel-edge-public-security cps-novel-edge-admin-security cps-novel-edge-maintenance; do
    sudo install -o root -g root -m 0644 "$root/infra/preproduction/nginx/$name.conf" "/etc/nginx/snippets/$name.conf"
  done
  sudo install -o root -g root -m 0644 "$rendered" /etc/nginx/conf.d/cps-novel-preprod.conf
  if [[ "$mode" == public ]]; then sudo rm -f /etc/nginx/conf.d/cps-novel-public-bootstrap.conf; fi
  if sudo test -e /etc/nginx/sites-enabled/default && sudo grep -q default_server /etc/nginx/sites-enabled/default; then
    sudo rm -f /etc/nginx/sites-enabled/default
  fi
fi
sudo nginx -t
sudo systemctl reload nginx
finished=1
echo "NGINX_INSTALL=PASS mode=$mode bootstrap_public=$bootstrap_public backup_dir=$backup_dir"
