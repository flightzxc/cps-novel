#!/usr/bin/env bash
# Called by install-nginx.sh after its approval and nginx-version checks.
set -euo pipefail
# Physical root: through the /opt/cps-novel/current symlink a logical pwd made
# the Node renderer render nothing (2026-10-05); resolve to the real release.
root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
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
# Everything the readiness wait observes must be present BEFORE anything is
# written: discovering a missing tool after the reload would roll back a good
# install for no reason.
required_tools="pgrep ps ss systemctl"
# The candidate check (and, for the site modes, the renderer) runs under Node.
if [[ -z "$restore" ]]; then required_tools="$required_tools node"; fi
for tool in $required_tools; do
  command -v "$tool" >/dev/null 2>&1 || { echo "NGINX_INSTALL=REFUSED reason=ready_tool_missing tool=$tool"; exit 69; }
done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || { echo 'NGINX_INSTALL=REFUSED reason=ready_tool_missing tool=sha256sum'; exit 69; }

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{ print $1 }'; else shasum -a 256 | awk '{ print $1 }'; fi
}

# --- Gate 1: candidate sanity, before ANY write (no backup directory, no
# /etc/nginx file, no nginx -t, no reload). `nginx -t` passes for an empty site
# file and a reload into it drops every 443 listener, so syntax validity is not
# evidence that the candidate is the site we meant to install.
assert_candidate() {
  local check_mode="$1" report
  if ! [[ -s "$rendered" ]]; then
    echo 'NGINX_INSTALL=REFUSED reason=candidate_empty'
    exit 65
  fi
  if ! report="$(node "$root/scripts/preproduction/verify-nginx-candidate.mjs" --mode "$check_mode" --hsts-max-age "$hsts" "$rendered" 2>&1)"; then
    printf '%s\n' "$report"
    echo 'NGINX_INSTALL=REFUSED reason=candidate_incomplete'
    exit 65
  fi
  # A verifier that silently did nothing must not read as a pass.
  if ! [[ "$report" == *NGINX_CANDIDATE=PASS* ]]; then
    echo 'NGINX_INSTALL=REFUSED reason=candidate_unverified'
    exit 65
  fi
  printf '%s\n' "$report"
}

# --- Gate 2: what is on disk must be byte-identical to what was verified.
verify_installed() {
  local want="$1" dst="$2" got
  got="$(sudo cat "$dst" 2>/dev/null | sha256_stdin)" || got=""
  if [[ "$got" != "$want" ]]; then
    echo "NGINX_INSTALL=FAIL reason=installed_hash_mismatch file=$dst installed_sha256=${got:-unreadable} expected_sha256=$want"
    return 72
  fi
  return 0
}

# --- Gate 3: reload readiness. `systemctl reload nginx` (nginx -s reload)
# returns as soon as the signal is delivered; the master then re-reads the
# configuration, starts NEW workers, and only afterwards tells the OLD ones to
# quit. Probing right after the return can still hit the old configuration or a
# half-switched listener (2026-10-05 A/B and 2026-10-07 first public attempt).
# Signal: the master PID is unchanged, at least one child process exists that was
# not there before the reload, every pre-reload child has exited or announces
# "shutting down", and each expected port has a TCP listener. All of it is
# readable by an unprivileged user (systemctl show, pgrep, ps, ss); no log
# access and no business-level HTTP probe -- that stays with verify-release.sh.
ready_rounds=10
ready_interval=1
pre_master=""
pre_children=""

in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }
nginx_master_pid() {
  local value
  value="$(systemctl show --no-pager --property=MainPID nginx 2>/dev/null | sed -n 's/^MainPID=//p' || true)"
  if [[ "$value" =~ ^[1-9][0-9]*$ ]]; then printf '%s' "$value"; fi
  return 0
}
nginx_children() { pgrep -P "$1" 2>/dev/null | sort -n | tr '\n' ' ' || true; }
port_listening() {
  ss -ltn 2>/dev/null | awk -v want=":$1" '$1 == "LISTEN" { a = $4; if (length(a) >= length(want) && substr(a, length(a) - length(want) + 1) == want) f = 1 } END { exit f ? 0 : 1 }'
}
handoff_complete() {
  local master="$1" now pid title fresh=0
  now="$(nginx_children "$master")"
  for pid in $now; do
    if ! in_list "$pid" "$pre_children"; then fresh=1; fi
  done
  if ((! fresh)); then return 1; fi
  for pid in $pre_children; do
    if in_list "$pid" "$now"; then
      title="$(ps -o args= -p "$pid" 2>/dev/null || true)"
      case "$title" in *"shutting down"*|"") ;; *) return 1 ;; esac
    fi
  done
  return 0
}
snapshot_nginx() {
  pre_master="$(nginx_master_pid)"
  if [[ -z "$pre_master" ]]; then
    echo 'NGINX_INSTALL=FAIL reason=ready_master_missing'
    return 73
  fi
  pre_children="$(nginx_children "$pre_master")"
}
wait_ready() {
  local phase="$1" round=1 master handoff missing port reason
  shift
  while :; do
    master="$(nginx_master_pid)"
    # A different master means nginx was restarted underneath us; fail at once.
    # An unreadable master (a transient systemctl hiccup) is not evidence of
    # anything: count the round as not yet ready and look again.
    if [[ -n "$master" && "$master" != "$pre_master" ]]; then
      echo "NGINX_INSTALL=FAIL reason=ready_master_changed phase=$phase before=$pre_master after=$master round=$round"
      return 73
    fi
    handoff=pending
    if [[ -n "$master" ]] && handoff_complete "$master"; then handoff=ok; fi
    missing=""
    for port in "$@"; do
      port_listening "$port" || missing="$missing $port"
    done
    if [[ "$handoff" == ok && -z "$missing" ]]; then
      echo "NGINX_READY=PASS phase=$phase round=$round master=$master listeners=${*:-none}"
      return 0
    fi
    if ((round >= ready_rounds)); then
      reason=ready_listener_missing
      if [[ "$handoff" != ok ]]; then reason=ready_handoff_timeout; fi
      echo "NGINX_INSTALL=FAIL reason=$reason phase=$phase rounds=$ready_rounds handoff=$handoff master=${master:-unreadable} missing_listeners=${missing# }"
      return 73
    fi
    round=$((round + 1))
    sleep "$ready_interval"
  done
}
# usage: reload_and_wait PHASE [PORT...]
reload_and_wait() {
  local phase="$1"
  shift
  snapshot_nginx || return "$?"
  sudo systemctl reload nginx || return "$?"
  wait_ready "$phase" "$@"
}
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
    if restore_files "$backup_dir" && sudo nginx -t && reload_and_wait rollback; then
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
candidate_sha=""
if [[ -z "$restore" ]]; then
  if ((bootstrap_public)); then
    "$root/scripts/preproduction/render-nginx.sh" --bootstrap-public --output "$rendered"
    assert_candidate bootstrap-public
  else
    "$root/scripts/preproduction/render-nginx.sh" --mode "$mode" --hsts-max-age "$hsts" --output "$rendered"
    assert_candidate "$mode"
  fi
  candidate_sha="$(sha256_stdin <"$rendered")"
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
if [[ -z "$restore" ]]; then
  if ((bootstrap_public)); then
    verify_installed "$candidate_sha" /etc/nginx/conf.d/cps-novel-public-bootstrap.conf || exit "$?"
  else
    for name in cps-novel-preprod-security cps-novel-preprod-protected cps-novel-preprod-protected-nomaintenance cps-novel-preprod-proxy cps-novel-edge-public-security cps-novel-edge-admin-security cps-novel-edge-maintenance; do
      verify_installed "$(sha256_stdin <"$root/infra/preproduction/nginx/$name.conf")" "/etc/nginx/snippets/$name.conf" || exit "$?"
    done
    verify_installed "$candidate_sha" /etc/nginx/conf.d/cps-novel-preprod.conf || exit "$?"
  fi
fi
sudo nginx -t
# Listeners the installed configuration must serve: both ports for a site mode,
# only :80 for the additive HTTP bootstrap. A restore returns to whatever the
# backup held, so it asserts the worker handoff but no particular port.
if ((bootstrap_public)); then expected_ports="80"; elif [[ -n "$restore" ]]; then expected_ports=""; else expected_ports="80 443"; fi
reload_and_wait install $expected_ports || exit "$?"
finished=1
echo "NGINX_INSTALL=PASS mode=$mode bootstrap_public=$bootstrap_public backup_dir=$backup_dir"
