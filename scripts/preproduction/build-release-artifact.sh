#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
push=0
[[ "${1:-}" != "--push" ]] || push=1
: "${APPROVED_GIT_COMMIT:?APPROVED_GIT_COMMIT is required}"
: "${REGISTRY_IMAGE:?REGISTRY_IMAGE is required, without a tag or digest}"
[[ "$APPROVED_GIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "RELEASE_BUILD=REFUSED reason=commit_shape"; exit 65; }
registry_basename="${REGISTRY_IMAGE##*/}"
[[ "$REGISTRY_IMAGE" != *@* && "$registry_basename" != *:* ]] || {
  echo "RELEASE_BUILD=REFUSED reason=registry_image_shape"; exit 65;
}
head="$(git -C "$root" rev-parse HEAD)"
[[ "$head" == "$APPROVED_GIT_COMMIT" ]] || { echo "RELEASE_BUILD=REFUSED reason=unapproved_head"; exit 65; }
[[ -z "$(git -C "$root" status --porcelain=v1)" ]] || { echo "RELEASE_BUILD=REFUSED reason=dirty_checkout"; exit 65; }

# Required repository build contract; this creates local-only disposable
# build secrets and derives APP_VERSION/GIT_COMMIT/image tag from this HEAD.
# shellcheck source=scripts/lib/p1-12-local-env.sh
source "$root/scripts/lib/p1-12-local-env.sh"
prepare_p1_12_local_environment
[[ "$GIT_COMMIT" == "$APPROVED_GIT_COMMIT" ]] || { echo "RELEASE_BUILD=REFUSED reason=derived_commit"; exit 65; }
local_image="$CPS_NOVEL_APP_IMAGE"
docker compose -p "$P1_12_COMPOSE_PROJECT" -f "$root/docker-compose.yml" build web

release_tag="${APP_VERSION}-${GIT_COMMIT:0:7}"
registry_tag="$REGISTRY_IMAGE:$release_tag"
docker tag "$local_image" "$registry_tag"
if [[ "$push" == "1" ]]; then
  docker push "$registry_tag"
fi
repo_digest="$(docker image inspect "$registry_tag" --format '{{range .RepoDigests}}{{println .}}{{end}}' \
  | grep "^${REGISTRY_IMAGE}@sha256:" | head -1 || true)"
[[ "$repo_digest" =~ @sha256:[0-9a-f]{64}$ ]] || {
  echo "RELEASE_BUILD=REFUSED reason=immutable_registry_digest_missing"; exit 65;
}

manifest_dir="$root/.tmp/preproduction-release"
manifest="$manifest_dir/${GIT_COMMIT}.json"
mkdir -p "$manifest_dir"
umask 077
node -e '
  const fs=require("fs");
  const [path,commit,version,tag,digest,builtAt]=process.argv.slice(1);
  // versionIdentityIssue (git tag v0.2.0 vs package.json 0.1.0) was resolved
  // by unifying package.json/env templates/image tag prefix to 0.3.0
  // (Owner decision, 2026-09-23); no longer written here.
  fs.writeFileSync(path, JSON.stringify({schemaVersion:1,commit,version,tag,image:digest,builtAt},null,2)+"\n", {mode:0o600,flag:"wx"});
' "$manifest" "$GIT_COMMIT" "$APP_VERSION" "$registry_tag" "$repo_digest" "$BUILD_DATE"
echo "RELEASE_BUILD=PASS"
echo "RELEASE_MANIFEST=$manifest"
