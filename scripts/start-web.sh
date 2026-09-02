#!/usr/bin/env bash
set -euo pipefail
set +x

tsx scripts/credential-secret-preflight.ts
exec node server.js
