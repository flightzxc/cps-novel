#!/usr/bin/env bash
set -euo pipefail
set +x

# shellcheck source=scripts/lib/runtime-secret-env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/runtime-secret-env.sh"
load_runtime_secret TRACKING_HASH_SALT
load_runtime_secret TOTP_ENCRYPTION_KEY

# B-39: the Turnstile secret is only read when the switch is exactly "true"
# (the same exact-match parse as src/lib/auth/admin-login-turnstile.ts), so a
# host with the switch off never touches it -- there may be no key file at all.
# Deliberately NOT fatal, unlike the two secrets above: web also serves the
# public site, and a missing/unreadable Turnstile secret must only make the
# admin login refuse every attempt (the runtime resolver treats an ON switch
# without a secret as misconfigured and fails closed), not crash-loop the whole
# container. load_runtime_secret already names the offending *_FILE variable on
# stderr without ever printing a value; the deployment preflight is what stops
# this state from being deployed in the first place.
if [[ "${ADMIN_LOGIN_TURNSTILE_ENABLED:-}" == "true" ]]; then
  load_runtime_secret ADMIN_LOGIN_TURNSTILE_SECRET_KEY \
    || echo "WARN: admin login Turnstile secret unavailable; admin logins will be refused (fail-closed)" >&2
fi

tsx scripts/credential-secret-preflight.ts
tsx scripts/two-factor-enforcement-preflight.ts
tsx scripts/admin-login-turnstile-preflight.ts
exec node server.js
