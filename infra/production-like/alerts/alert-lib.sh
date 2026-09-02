#!/usr/bin/env bash
# RC-7 minimal alerts — shared push/debounce/fail-closed library.
#
# Ported from the CPS 短剧 (cps-admin) v8.3.6 keyword-alert contract, not from
# any single CPS push script — there isn't one. CPS's own ops evidence
# (git -C <cps-admin, read-only> show v8.3.6:DEVLOG.md around the 2026-08
# backup-silent-failure incident, and v8.3.6:src/app/api/health/backup/route.ts
# + v8.3.6:src/lib/health-backup-status.ts) shows the CPS chain is: an HTTP
# endpoint exposes a compact-JSON body carrying a literal success keyword
# (`"backupStatus":"ok"` / `"ok":true`), and an external Keyword-type uptime
# monitor (UptimeRobot free tier — see tests/health-backup-route.test.ts:63-65
# in the same read-only tree) does the actual push. UptimeRobot's Keyword
# monitor type is load-bearing on purpose: CPS's own /api/health once returned
# HTTP 200 for 103 minutes while the database was completely unreachable
# (health-liveness.ts deliberately not touching the DB), so a plain HTTP-status
# monitor would have stayed silent through that outage — only a monitor that
# greps the body for the success keyword catches it.
#
# cps-novel's X8 local production-like stack is 127.0.0.1-only (no public
# uptime monitor can reach it), so this library replicates the *contract* the
# CPS routes enforce (keyword-based judgement, fail-closed on "can't tell" and
# not just on "explicitly bad", 26h backup staleness threshold copied from
# src/lib/health-backup-status.ts DEFAULT_STALE_THRESHOLD_HOURS=26) and adds a
# generic outbound webhook push so Owner can wire ALERT_PUSH_ENDPOINT /
# ALERT_PUSH_TOKEN to whatever channel CPS's alerts already land in — per the
# Owner decision to reuse the existing channel rather than stand up a new one.
# No token/endpoint value is hardcoded anywhere in this file; see
# docs/operations/ALERTS_RUNBOOK_2026-09-03.md for the env placeholder list.
#
# Every check-*.sh in this directory sources this file. It is a library: it
# defines functions and returns cleanly when sourced, and is never meant to be
# executed directly.
set -euo pipefail

: "${ALERT_STATE_DIR:=/tmp/cps-novel-alerts}"
: "${ALERT_DEBOUNCE_SECONDS:=900}"
: "${ALERT_PUSH_TIMEOUT_SECONDS:=10}"
: "${DRY_RUN:=0}"

alert_log() {
  printf '[%s] cps-novel-alerts: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

alert_state_dir() {
  mkdir -p "${ALERT_STATE_DIR}"
  printf '%s' "${ALERT_STATE_DIR}"
}

# Sanitizes an alert key into a filesystem-safe debounce state filename.
alert_debounce_file() {
  local key="$1" safe dir
  safe="$(printf '%s' "${key}" | tr -c 'A-Za-z0-9_.-' '_')"
  dir="$(alert_state_dir)"
  printf '%s/%s.last_sent' "${dir}" "${safe}"
}

# True (0) if an alert for this key was successfully delivered within the
# debounce window, i.e. it should be suppressed this run.
alert_should_suppress() {
  local key="$1" file last now delta
  file="$(alert_debounce_file "${key}")"
  [[ -f "${file}" ]] || return 1
  last="$(cat "${file}" 2>/dev/null || printf '0')"
  [[ "${last}" =~ ^[0-9]+$ ]] || last=0
  now="$(date +%s)"
  delta=$(( now - last ))
  [[ ${delta} -lt ${ALERT_DEBOUNCE_SECONDS} ]]
}

# Records that an alert for this key was delivered, starting its debounce
# window. DRY_RUN never writes it: a dry run that left a real .last_sent behind
# would silently suppress the next *genuine* alert for up to
# ALERT_DEBOUNCE_SECONDS — a dry run must never be able to make the live chain
# quieter. Skipping the write only ever costs an extra (undelivered) dry-run
# alert, which is the fail-closed direction. drill.sh is unaffected: it asserts
# on the fire counter, and each of its scenarios uses a distinct key.
alert_mark_sent() {
  local key="$1" file
  if [[ "${DRY_RUN}" == "1" ]]; then
    alert_log "[DRY_RUN] debounce state NOT recorded for key=${key} (a dry run must never suppress a later real alert)"
    return 0
  fi
  file="$(alert_debounce_file "${key}")"
  date +%s > "${file}"
}

# Clears debounce state for a key. Call this once a check observes the
# corresponding condition has recovered, so the next real incident is not
# silently swallowed by a stale debounce window, and so an operator watching
# ALERT_STATE_DIR can see which keys are currently "open".
alert_recover() {
# DRY_RUN is read-only here too, for the same reason as alert_mark_sent: a dry
# run must observe the live debounce state, never mutate it.
  local key="$1" file
  file="$(alert_debounce_file "${key}")"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  if [[ "${DRY_RUN}" == "1" ]]; then
    alert_log "[DRY_RUN] would clear debounce state for key=${key} (not clearing)"
    return 0
  fi
  rm -f "${file}"
  alert_log "recovered: key=${key} (debounce state cleared)"
}

# Fired-alert counter, file-backed rather than a plain shell variable on
# purpose: several call sites in this directory invoke alert_fire from inside
# a `$(...)` command substitution (e.g. check-backup-freshness.sh resolving a
# marker mtime while also handling the "can't read it at all" case in the same
# breath). A command substitution runs in a subshell, so a shell-variable
# increment made inside one is silently lost the moment it returns — a file
# write is not. drill.sh asserts on this counter, which is what caught the
# bug during RC-7 build (see docs/operations/ALERTS_RUNBOOK_2026-09-03.md).
alert_fire_total_file() {
  printf '%s/.fire_total' "$(alert_state_dir)"
}

alert_fire_total() {
  local f value
  f="$(alert_fire_total_file)"
  if [[ -f "${f}" ]]; then
    value="$(cat "${f}" 2>/dev/null || printf '0')"
  else
    value=0
  fi
  [[ "${value}" =~ ^[0-9]+$ ]] || value=0
  printf '%s' "${value}"
}

alert_fire_total_increment() {
  local f cur
  f="$(alert_fire_total_file)"
  cur="$(alert_fire_total)"
  printf '%s' "$(( cur + 1 ))" > "${f}"
}

# Resets the fired-alert counter to 0. Call this once at the start of a
# polling cycle (each check-*.sh does this in its own standalone-execution
# guard; run-all.sh does it once for the whole batch) so the counter means
# "alerts fired this run", not "alerts fired ever since ALERT_STATE_DIR was
# created".
alert_fire_total_reset() {
  printf '0' > "$(alert_fire_total_file)"
}

# Minimal JSON string escaping: backslash, double quote, tab, CR, LF. The
# messages this library emits are plain diagnostic text (command output,
# psql/curl error text), never pre-formed JSON, so this is sufficient.
alert_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  printf '%s' "${s}"
}

alert_build_payload() {
  local key="$1" severity="$2" title="$3" message="$4" host ts
  host="$(hostname 2>/dev/null || printf 'unknown-host')"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"source":"cps-novel-x8-alerts","key":"%s","severity":"%s","title":"%s","message":"%s","host":"%s","timestamp":"%s"}' \
    "$(alert_json_escape "${key}")" \
    "$(alert_json_escape "${severity}")" \
    "$(alert_json_escape "${title}")" \
    "$(alert_json_escape "${message}")" \
    "$(alert_json_escape "${host}")" \
    "${ts}"
}

# Delivers one alert. DRY_RUN=1 (required by RC-7 gates) prints the payload to
# stderr instead of POSTing it — no real endpoint is ever contacted in that
# mode. Returns 0 on a delivered (or dry-run) push, 1 if delivery failed or
# ALERT_PUSH_ENDPOINT is unset — the caller decides whether that failure
# should also count as "not yet acknowledged" (see alert_fire below).
alert_dispatch_push() {
  local key="$1" severity="$2" title="$3" message="$4" payload
  payload="$(alert_build_payload "${key}" "${severity}" "${title}" "${message}")"

  if [[ "${DRY_RUN}" == "1" ]]; then
    alert_log "[DRY_RUN] would push alert key=${key} severity=${severity} title=\"${title}\""
    printf '%s\n' "${payload}" >&2
    return 0
  fi

  if [[ -z "${ALERT_PUSH_ENDPOINT:-}" ]]; then
    alert_log "ALERT_PUSH_ENDPOINT is not configured; alert NOT delivered (key=${key} title=\"${title}\")"
    return 1
  fi

  local curl_args=(-fsS --max-time "${ALERT_PUSH_TIMEOUT_SECONDS}" -X POST "${ALERT_PUSH_ENDPOINT}" -H "Content-Type: application/json")
  if [[ -n "${ALERT_PUSH_TOKEN:-}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${ALERT_PUSH_TOKEN}")
  fi
  curl_args+=(-d "${payload}")

  if ! curl "${curl_args[@]}" >/dev/null 2>&1; then
    alert_log "push delivery failed (key=${key} title=\"${title}\")"
    return 1
  fi
  return 0
}

# The one entry point check-*.sh scripts call to raise an alert. Debounced per
# key; alert_fire_total() counts every non-suppressed invocation (drill.sh
# asserts on this counter rather than parsing log output). Debounce state is
# only recorded on a *successful* push — a delivery failure leaves the window
# open so the very next run retries instead of silently going quiet for
# ALERT_DEBOUNCE_SECONDS.
alert_fire() {
  local key="$1" severity="$2" title="$3" message="$4"
  if alert_should_suppress "${key}"; then
    alert_log "suppressed (debounce <${ALERT_DEBOUNCE_SECONDS}s): key=${key} title=\"${title}\""
    return 0
  fi
  alert_fire_total_increment
  alert_log "ALERT key=${key} severity=${severity} title=\"${title}\""
  if alert_dispatch_push "${key}" "${severity}" "${title}" "${message}"; then
    alert_mark_sent "${key}"
  else
    alert_log "delivery failed; debounce NOT recorded so the next run retries: key=${key}"
  fi
}

# fail_closed_run <key> <title> -- <command...>
#
# Runs a probe command. If it exits non-zero, fires a fail-closed alert (the
# probe itself could not execute — CPS's own rule of thumb, ported verbatim
# from the health-backup-status.ts header comment: "看不懂/看不到 = 不可信",
# i.e. an unreadable/unreachable probe is treated as failing, never as
# silently healthy) and returns 1. On success, prints the command's combined
# output and returns 0.
fail_closed_run() {
  local key="$1" title="$2"
  shift 2
  [[ "${1:-}" == "--" ]] && shift
  local out rc
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  set -e
  if [[ ${rc} -ne 0 ]]; then
    alert_fire "${key}" "critical" "${title}" "probe command failed (exit=${rc}): $* -- output: ${out}"
    return 1
  fi
  printf '%s' "${out}"
  return 0
}
