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
# 🔴 MAJOR-3 fix: only ever auto-delete the disposable rendered-candidate
# file here. The old trap also `rm -rf`'d $file_backup_dir on INT/TERM --
# reproduced: a SIGTERM delivered to this script's process group while
# `sudo nginx -t` runs as the foreground child is deferred by bash until
# that command returns; this trap then ran and destroyed the backups BEFORE
# rollback_all() (below) got a chance to use them, so the subsequent
# `nginx -t` failure (the killed child returning non-zero) made
# rollback_all() read every "no backup" as "this file should not exist" and
# delete the live site config and security snippet -- then reload into the
# empty result and report a clean-looking REFUSED, having actually taken
# down both hosts. The backup directory (and, if used, the default-site
# backup/state files -- see rollback_all() and the bottom of this script)
# must survive an interrupted run; they are only ever cleaned up on a
# confirmed-successful exit path, explicitly, near the bottom of this
# script -- never implicitly via a signal trap.
trap 'rm -f "$rendered"' EXIT

# N2 fix: $file_backup_dir is a `mktemp -d`-random path under /tmp, which
# Ubuntu's systemd-tmpfiles/boot cleanup can remove -- and every path that
# deliberately KEEPS it (the rollback_state_invalid and backup_dir_missing
# REFUSED reasons below, plus an invocation that is interrupted before ever
# reaching either) previously printed nothing about where it actually is, so
# an operator re-running after an interruption had no way to find the one
# copy of whatever this invocation backed up. This handler ONLY
# echoes the retained path on INT/TERM; it must never delete anything --
# that deletion was MAJOR-3 (see the EXIT trap above and its comment). After
# echoing, it restores the signal's default disposition and re-raises it
# against this process, so the script still terminates promptly on
# interrupt exactly as it did with no trap registered at all (the EXIT trap
# above still runs on the way out, and still only ever removes $rendered) --
# it does not swallow the signal and let the script carry on past the point
# it was told to stop.
on_interrupt() {
  echo "NGINX_INSTALL_INTERRUPTED backup_dir=$file_backup_dir" >&2
  trap - INT TERM
  kill -s "$1" "$$"
}
trap 'on_interrupt INT' INT
trap 'on_interrupt TERM' TERM

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
    # 🔴 MAJOR-3 fix: fail closed if the backup directory itself is gone or
    # unreadable. "No backup for this name" legitimately means "this file
    # did not exist before this invocation" ONLY when file_backup_dir is
    # intact (backup_existing() above always runs for every name,
    # regardless of --bootstrap, before any install happens) -- if the
    # directory itself was lost (e.g. this run was interrupted), that
    # invariant no longer holds, and reading "not present" as "should not
    # exist" is exactly what let a stray signal delete a live, previously-
    # installed file. Refuse instead of guessing.
    if [[ ! -d "$file_backup_dir" || ! -r "$file_backup_dir" ]]; then
      echo "NGINX_INSTALL=REFUSED reason=backup_dir_missing backup_dir=$file_backup_dir"
      exit 70
    fi
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
    # MINOR-6 fix: do NOT remove $default_site_backup/$default_site_state
    # here. They are the only record of what this invocation found on the
    # host; removing them before the caller's post-rollback `nginx -t` has
    # actually confirmed the restore is valid loses that record if the
    # restored state itself turns out to fail `nginx -t` (e.g. the host was
    # already broken -- an old site.conf and the default site both present
    # -- before this invocation ever ran).
    #
    # N1 fix: the caller does NOT remove them on a later confirmed success
    # either, not just here. They used to be deleted on both of this script's
    # confirmed-successful exit paths (the nginx_test_failed-after-rollback
    # branch below, and the ordinary PASS path at the bottom), which made
    # ADR-PREPROD-EDGE-MAINTENANCE-AND-ADMIN-ASSETS.md's claim that the
    # script "record[s] what that file was ... under the shared root" true
    # only until the very next successful run -- for Ubuntu's stock
    # `kind=symlink` default site the *target* under sites-available/ still
    # survives, so a human could still re-link it by hand, but for a
    # `kind=file` default site the content was gone for good after the first
    # successful install, with no record left of what it had been. They are
    # kept permanently now: a later run leaves them alone regardless, because
    # by then $default_site has already been removed by the run that created
    # them, so `[[ -e "$default_site" ]] || [[ -L "$default_site" ]]` is
    # false and this whole default-site block (including this backup/state
    # write) is skipped entirely -- default_site_disabled stays 0 and nothing
    # here ever looks at the retained files again.
  fi
}

if ! sudo nginx -t; then
  rollback_all
  # Confirm the rollback itself leaves a valid config before reloading into
  # it. This must NOT rely on `set -e` to enforce "do not reload on
  # failure": letting `set -e` abort the script here would exit with no
  # NGINX_INSTALL= line at all (MINOR-6) and no distinction from any other
  # failure -- make both the "do not reload" and "report distinctly"
  # guarantees explicit instead.
  if sudo nginx -t; then
    sudo systemctl reload nginx
    # N1 fix: $file_backup_dir (the snippet/site-config backups) is still
    # disposable once restored and confirmed, so it is still removed here.
    # $default_site_backup/$default_site_state are NOT -- see the N1 comment
    # on the write side above, in rollback_all().
    rm -rf "$file_backup_dir"
    echo "NGINX_INSTALL=REFUSED reason=nginx_test_failed"
    exit 65
  fi
  # MINOR-6: the state this invocation found already fails `nginx -t` on its
  # own (e.g. a pre-existing broken pair of default-site files) -- restoring
  # it byte-for-byte is correct, but it cannot be reloaded into a serving
  # nginx. Do not reload, and leave the backup/state files in place for an
  # operator to inspect: they are otherwise the only record of what this
  # invocation found, and would be lost silently.
  echo "NGINX_INSTALL=REFUSED reason=rollback_state_invalid backup_dir=$file_backup_dir"
  exit 71
fi

sudo systemctl reload nginx
# N1 fix: as above, $file_backup_dir is still disposable and removed on a
# genuine PASS; $default_site_backup/$default_site_state are kept permanently
# instead of being deleted here -- see the N1 comment in rollback_all().
rm -rf "$file_backup_dir"
echo "NGINX_INSTALL=PASS"
