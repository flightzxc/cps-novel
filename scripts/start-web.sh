#!/usr/bin/env bash
set -euo pipefail
set +x

# shellcheck source=scripts/lib/runtime-secret-env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/runtime-secret-env.sh"
load_runtime_secret TRACKING_HASH_SALT
load_runtime_secret TOTP_ENCRYPTION_KEY

tsx scripts/credential-secret-preflight.ts
tsx scripts/two-factor-enforcement-preflight.ts
exec node server.js
