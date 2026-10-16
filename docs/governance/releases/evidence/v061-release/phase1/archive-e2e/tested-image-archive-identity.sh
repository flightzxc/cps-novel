#!/bin/bash
set -euo pipefail
set +x
source scripts/preproduction/lib.sh
preprod_read_release_manifest "$PWD/.tmp/preproduction-archive/cb255e0f1c93041eda6aefeefbb541d7eddfc15f.json"
if ! preprod_assert_local_image 'cps-novel:cutover-local-cb255e0'; then exit 65; fi
echo 'TESTED_IMAGE_EQUALS_ARCHIVE=PASS'
