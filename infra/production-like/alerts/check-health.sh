#!/usr/bin/env bash
# RC-7 minimal alert ①: /api/health must return HTTP 200 AND carry the
# `"ok":true` keyword.
#
# Keyword-not-just-status-code is the whole point, ported from CPS 短剧
# (cps-admin, read-only, v8.3.6 / peeled commit
# 16f2e4cfca51f46af0dede899ecf6242a770bbd0): CPS's own /api/health once
# returned HTTP 200 for 103 minutes while its database was completely
# unreachable, and tests/health-backup-route.test.ts:63-65 in that tree
# documents that CPS's external UptimeRobot monitor is deliberately
# Keyword-type, not HTTP-status-type, for exactly this reason. cps-novel's
# own src/server/health/service.ts already returns 503 on a real failure
# (unlike the CPS incident this pattern guards against), but this script
# checks the keyword anyway rather than trusting the status code alone —
# that is the CPS lesson being ported, not a claim that today's novel
# handler has the same bug.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/production-like/alerts/alert-lib.sh
source "${SCRIPT_DIR}/alert-lib.sh"

: "${HEALTH_URL:=http://127.0.0.1:3000/api/health}"
: "${HEALTH_CURL_TIMEOUT_SECONDS:=10}"

# Pure function, no network I/O — kept separate so drill.sh can exercise the
# keyword judgement itself ("keyword-flip" drill) without needing a live
# server. Tolerant of either `"ok":true` or `"ok": true` spacing since we
# don't control the exact serialization the way CPS controls its own
# NextResponse.json() compact output.
is_health_body_ok() {
  printf '%s' "$1" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
}

check_health() {
  local body_file err_file http_code rc
  body_file="$(mktemp "${TMPDIR:-/tmp}/cps-novel-health.XXXXXX")"
  err_file="$(mktemp "${TMPDIR:-/tmp}/cps-novel-health-err.XXXXXX")"

  set +e
  http_code="$(curl -sS --max-time "${HEALTH_CURL_TIMEOUT_SECONDS}" \
    -o "${body_file}" -w '%{http_code}' "${HEALTH_URL}" 2>"${err_file}")"
  rc=$?
  set -e

  if [[ ${rc} -ne 0 ]]; then
    alert_fire "health_probe_unreachable" "critical" \
      "cps-novel /api/health unreachable" \
      "curl failed (exit=${rc}) against HEALTH_URL=${HEALTH_URL}: $(cat "${err_file}")"
    rm -f "${body_file}" "${err_file}"
    return 1
  fi

  local body
  body="$(cat "${body_file}")"
  rm -f "${body_file}" "${err_file}"

  if [[ "${http_code}" != "200" ]]; then
    alert_fire "health_http_status" "critical" \
      "cps-novel /api/health returned non-200" \
      "HTTP ${http_code} from ${HEALTH_URL}. Body: ${body}"
    return 1
  fi

  if ! is_health_body_ok "${body}"; then
    alert_fire "health_keyword_missing" "critical" \
      "cps-novel /api/health missing the ok:true keyword" \
      "HTTP 200 but the ok:true keyword is absent (CPS Keyword-monitor contract, ported). Body: ${body}"
    return 1
  fi

  alert_recover "health_probe_unreachable"
  alert_recover "health_http_status"
  alert_recover "health_keyword_missing"
  alert_log "check-health: OK (${HEALTH_URL})"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  alert_fire_total_reset
  check_health
fi
