#!/usr/bin/env bash
set -euo pipefail

# Installer/manager for the local-X8 daily WAL retention apply LaunchAgent
# (infra/local-x8/wal-gc-daily-apply.sh). This is the ONLY place in this
# repo allowed to run `launchctl load`/`launchctl unload` for
# com.cpsnovel.x8.wal-gc-apply -- and per this work order's own red lines,
# THIS SESSION never invokes `install` (only `run-once`, via a test-mode
# shim, and only to exercise the operator script's logic). Actually
# installing is left to the Owner/Codex.
#
# usage: x8-local-wal-gc-launchd.sh install|uninstall|status|run-once [--worktree PATH]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_WORKTREE="$(cd "$SCRIPT_DIR/.." && pwd)"

PLIST_LABEL="com.cpsnovel.x8.wal-gc-apply"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

usage() {
  echo "usage: x8-local-wal-gc-launchd.sh install|uninstall|status|run-once [--worktree PATH]" >&2
  exit 64
}

[[ $# -ge 1 ]] || usage
cmd="$1"
shift

WORKTREE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --worktree)
      [[ $# -ge 2 ]] || usage
      WORKTREE="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done
[[ -n "$WORKTREE" ]] || WORKTREE="$DEFAULT_WORKTREE"

require_darwin() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "LOCAL_WAL_GC_LAUNCHD=REFUSED reason=not_darwin" >&2
    exit 65
  fi
}

require_entrypoint() {
  if [[ ! -f "$WORKTREE/scripts/x8-production-like.sh" ]]; then
    echo "LOCAL_WAL_GC_LAUNCHD=REFUSED reason=worktree_missing_entrypoint" >&2
    exit 65
  fi
}

# Renders the plist template with this worktree's absolute path and $HOME
# substituted in, then writes it to the LaunchAgents directory -- does NOT
# load it. The template is read from the given worktree (never a hard-coded
# path), so `install --worktree` always installs an agent that points back
# at the worktree it was installed from.
render_plist() {
  local template="$WORKTREE/infra/local-x8/launchd/com.cpsnovel.x8.wal-gc-apply.plist.template"
  [[ -f "$template" ]] || {
    echo "LOCAL_WAL_GC_LAUNCHD=REFUSED reason=template_missing" >&2
    exit 65
  }
  mkdir -p "$HOME/Library/LaunchAgents"
  sed -e "s#__X8_LOCAL_WORKTREE__#$WORKTREE#g" -e "s#__HOME__#$HOME#g" "$template" >"$PLIST_DEST"
}

install_cmd() {
  require_darwin
  require_entrypoint

  # Owner requirement: before persisting anything, prove this worktree's
  # worktree-binding guard (x8_assert_worktree_stack_binding, exercised
  # every time `wal-gc` runs) actually passes against whatever stack is
  # currently running -- a dry-run only ever reads, never mutates. Refuses
  # to install rather than silently point a daily LaunchAgent at a worktree
  # that would be rejected the first time it actually ran.
  local preflight_out preflight_rc
  set +e
  preflight_out="$(X8_LEVEL=uat "$WORKTREE/scripts/x8-production-like.sh" wal-gc --json 2>&1)"
  preflight_rc=$?
  set -e
  if [[ "$preflight_rc" -ne 0 ]]; then
    echo "LOCAL_WAL_GC_LAUNCHD=REFUSED reason=worktree_not_bound_to_stack" >&2
    printf '%s\n' "$preflight_out" >&2
    exit 65
  fi

  render_plist
  launchctl load -w "$PLIST_DEST"
  echo "LOCAL_WAL_GC_LAUNCHD=INSTALLED plist=$PLIST_DEST"
}

uninstall_cmd() {
  require_darwin
  if [[ -f "$PLIST_DEST" ]]; then
    launchctl unload -w "$PLIST_DEST" >/dev/null 2>&1 || true
    rm -f "$PLIST_DEST"
  fi
  echo "LOCAL_WAL_GC_LAUNCHD=UNINSTALLED"
}

status_cmd() {
  echo "LOCAL_WAL_GC_LAUNCHD_LOADED:"
  if command -v launchctl >/dev/null 2>&1; then
    launchctl list 2>/dev/null | grep -F "$PLIST_LABEL" || echo "not loaded"
  else
    echo "launchctl unavailable"
  fi
  local runtime_dir="${X8_LOCAL_RUNTIME_DIR:-$HOME/Library/Application Support/CPSNovelX8WalGc}"
  local history="$runtime_dir/logs/history.log"
  echo "LOCAL_WAL_GC_HISTORY_TAIL:"
  if [[ -f "$history" ]]; then
    tail -n 5 "$history"
  else
    echo "no history yet"
  fi
}

# Runs the operator script directly, bypassing launchd entirely -- this is
# the only sub-command this work order's own verification is allowed to
# exercise (env overrides such as X8_LOCAL_TEST_MODE/X8_LOCAL_WAL_GC_ENTRY
# pass straight through since this is a plain `exec`, not a fresh launchd
# invocation with its own EnvironmentVariables dict).
run_once_cmd() {
  require_entrypoint
  X8_LOCAL_WORKTREE="$WORKTREE" exec bash "$WORKTREE/infra/local-x8/wal-gc-daily-apply.sh"
}

case "$cmd" in
  install) install_cmd ;;
  uninstall) uninstall_cmd ;;
  status) status_cmd ;;
  run-once) run_once_cmd ;;
  *) usage ;;
esac
