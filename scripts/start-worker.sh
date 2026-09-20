#!/usr/bin/env bash
set -euo pipefail
set +x

exec tsx worker/index.ts
