#!/usr/bin/env bash
# RC-7 minimal alerts — runs all three checks. Each check is independent: one
# failing (or alerting) never stops the others from running. Intended to be
# invoked from cron or the compose alerts wiring suggested in
# docs/operations/ALERTS_RUNBOOK_2026-09-03.md.
#
# Exit code = number of checks that alerted (0 = all clear). This is a summary
# signal for cron mail / job runners; the actual alert delivery already
# happened per-check via alert-lib.sh's alert_fire, independent of this exit
# code.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/production-like/alerts/alert-lib.sh
source "${SCRIPT_DIR}/alert-lib.sh"
# shellcheck source=infra/production-like/alerts/check-health.sh
source "${SCRIPT_DIR}/check-health.sh"
# shellcheck source=infra/production-like/alerts/check-worker-locks.sh
source "${SCRIPT_DIR}/check-worker-locks.sh"
# shellcheck source=infra/production-like/alerts/check-backup-freshness.sh
source "${SCRIPT_DIR}/check-backup-freshness.sh"

# NOTE (RC-7 review, verified empirically): errexit is effectively ON from here
# on, despite the `set -uo pipefail` above. Sourcing alert-lib.sh re-enables it
# (that file sets `-euo pipefail`), and every check-*.sh both sets it at load
# and restores `set -e` on the way out of its own `set +e; ...; set -e` probe
# blocks. So "one failing check never stops the others" is delivered by the
# `|| ...` guard on each call below, NOT by the absence of -e. Keep every check
# invocation guarded; an unguarded command here would abort the whole batch.

alert_fire_total_reset
failures=0

alert_log "run-all: check-health starting"
check_health || failures=$(( failures + 1 ))

alert_log "run-all: check-worker-locks starting"
run_worker_checks || failures=$(( failures + 1 ))

alert_log "run-all: check-backup-freshness starting"
check_backup_freshness || failures=$(( failures + 1 ))

alert_log "run-all: complete, failing_checks=${failures} alerts_fired_this_run=$(alert_fire_total)"
exit "${failures}"
