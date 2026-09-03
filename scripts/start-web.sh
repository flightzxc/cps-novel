#!/usr/bin/env bash
set -euo pipefail
set +x

tsx scripts/credential-secret-preflight.ts
tsx scripts/two-factor-enforcement-preflight.ts
exec node server.js
