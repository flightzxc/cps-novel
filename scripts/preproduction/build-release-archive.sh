#!/usr/bin/env bash
set -euo pipefail
set +x

# Phase 2C · 不可变镜像归档构建器（CPS 短剧形态的离线运输）。
#
# 产物是一个自包含的归档：approved commit → 镜像 → docker save → zstd → SHA256。
# 下游（Phase 2C 部署）在 VPS 上校验 SHA256 → docker load → 核对 config digest 与
# revision label，全程不需要任何 registry、不需要 docker login、不需要 PAT。
#
# 🔴 不自行发明 build 规则。镜像身份仍由仓库既有的 `scripts/lib/p1-12-local-env.sh`
# 派生（APP_VERSION / GIT_COMMIT / BUILD_DATE / 镜像标签），与
# `build-release-artifact.sh` 以及本机 X8 构建完全同一套。本脚本只替换**运输方式**。
#
# 与同目录 `build-release-artifact.sh` 的关系：那一份把镜像推到 registry 并以
# `repo@sha256:` 作为身份，是 Phase 2C GHCR PoC 的产物；Owner 2026-09-20 裁决
# 生产运输不走 registry，因此**本脚本是生产路径**，那一份保留为 PoC。
# 见 docs/adr/ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION.md。
#
# 用法：
#   APPROVED_GIT_COMMIT=<40-hex> scripts/preproduction/build-release-archive.sh
#
# 可选环境变量：
#   RELEASE_TARGET_PLATFORM   默认 linux/amd64；构建结果必须匹配，否则拒绝
#   RELEASE_ARCHIVE_DIR       默认 <root>/.tmp/preproduction-archive
#   RELEASE_ZSTD_LEVEL        默认 6

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

refuse() { echo "ARCHIVE_BUILD=REFUSED reason=$1"; exit 65; }

: "${APPROVED_GIT_COMMIT:?APPROVED_GIT_COMMIT is required}"
[[ "$APPROVED_GIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || refuse commit_shape

head="$(git -C "$root" rev-parse HEAD)"
[[ "$head" == "$APPROVED_GIT_COMMIT" ]] || refuse unapproved_head
[[ -z "$(git -C "$root" status --porcelain=v1)" ]] || refuse dirty_checkout

command -v zstd >/dev/null 2>&1 || refuse zstd_missing
command -v docker >/dev/null 2>&1 || refuse docker_missing

# 仓库既有的构建契约：创建本机一次性构建密钥，并派生镜像身份。
# shellcheck source=scripts/lib/p1-12-local-env.sh
source "$root/scripts/lib/p1-12-local-env.sh"
prepare_p1_12_local_environment
[[ "$GIT_COMMIT" == "$APPROVED_GIT_COMMIT" ]] || refuse derived_commit

local_image="$CPS_NOVEL_APP_IMAGE"
docker compose -p "$P1_12_COMPOSE_PROJECT" -f "$root/docker-compose.yml" build web

# --- 身份校验：三条都必须过，任何一条不过就不产出归档 ---------------------

# 1) 目标平台。
#    🔴 这条断言不是形式主义。本仓 Dockerfile 把基础镜像钉成
#    `node:20-alpine@sha256:fb4cd12…`，那是一个 **amd64 单架构 manifest**，所以
#    即使在 arm64 的 Mac 上构建，产物也是 linux/amd64。但这层保证是**隐式**的——
#    谁把 NODE_BASE_IMAGE 换成一个 tag 或多架构索引 digest，arm64 机器就会静默
#    产出 arm64 镜像，装到 amd64 的 VPS 上直接跑不起来，而且要到部署时才发现。
#    这里把它变成显式断言。
target_platform="${RELEASE_TARGET_PLATFORM:-linux/amd64}"
actual_platform="$(docker image inspect "$local_image" --format '{{.Os}}/{{.Architecture}}')"
[[ "$actual_platform" == "$target_platform" ]] || {
  echo "ARCHIVE_BUILD=REFUSED reason=platform_mismatch expected=$target_platform actual=$actual_platform"
  exit 65
}

# 2) revision 标签必须等于 approved commit。
revision="$(docker image inspect "$local_image" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$revision" == "$APPROVED_GIT_COMMIT" ]] || refuse revision_label

# 3) config digest（即 image ID）。归档装载后靠它认身份——
#    `docker save`/`load` 不保留 RepoDigest，config digest 才是跨主机稳定的那个。
image_id="$(docker image inspect "$local_image" --format '{{.Id}}')"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse image_id_shape

source_repo="$(docker image inspect "$local_image" \
  --format '{{index .Config.Labels "org.opencontainers.image.source"}}')"

# --- 产出归档 -------------------------------------------------------------

archive_dir="${RELEASE_ARCHIVE_DIR:-$root/.tmp/preproduction-archive}"
mkdir -p "$archive_dir"
umask 077

archive_name="cps-novel-${APP_VERSION}-${APPROVED_GIT_COMMIT:0:7}.tar.zst"
archive="$archive_dir/$archive_name"
[[ ! -e "$archive" ]] || refuse archive_exists

# 🔴 先写临时文件再改名：中途失败不会留下一个看起来成功的半截归档。
tmp_archive="$archive.partial.$$"
trap 'rm -f "$tmp_archive"' EXIT
docker save "$local_image" | zstd -T0 "-${RELEASE_ZSTD_LEVEL:-6}" -q -o "$tmp_archive"
mv "$tmp_archive" "$archive"
trap - EXIT

archive_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
[[ "$archive_sha" =~ ^[0-9a-f]{64}$ ]] || refuse archive_sha

# SHA256SUMS 用相对文件名，便于在 VPS 上 `shasum -a 256 -c SHA256SUMS`。
printf '%s  %s\n' "$archive_sha" "$archive_name" > "$archive_dir/${archive_name}.sha256"

# --- release manifest ------------------------------------------------------
#
# 🔴 身份不能只靠 tag。`image_tag` 只是人类可读的定位符，真正的身份是
# approved_git_commit + image_config_digest + archive_sha256 三者一致。
manifest="$archive_dir/${APPROVED_GIT_COMMIT}.json"
[[ ! -e "$manifest" ]] || refuse manifest_exists
node -e '
  const fs=require("fs");
  const [p,commit,version,tag,imageId,platform,archiveName,archiveSha,builtAt,sourceRepo]=process.argv.slice(1);
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: 1,
    transport: "archive",
    approved_git_commit: commit,
    version,
    image_tag: tag,
    image_config_digest: imageId,
    image_platform: platform,
    archive_filename: archiveName,
    archive_sha256: archiveSha,
    built_at: builtAt,
    source_repository: sourceRepo,
    identityNote: "Identity = approved_git_commit + image_config_digest + archive_sha256. image_tag alone is NOT identity.",
    versionIdentityIssue: "git tag v0.2.0 differs from package.json 0.1.0; commit and digest are authoritative",
  },null,2)+"\n", {mode:0o600,flag:"wx"});
' "$manifest" "$APPROVED_GIT_COMMIT" "$APP_VERSION" "$local_image" "$image_id" \
  "$actual_platform" "$archive_name" "$archive_sha" "$BUILD_DATE" "$source_repo"

echo "ARCHIVE_BUILD=PASS"
echo "ARCHIVE_FILE=$archive"
echo "ARCHIVE_SHA256=$archive_sha"
echo "IMAGE_CONFIG_DIGEST=$image_id"
echo "IMAGE_PLATFORM=$actual_platform"
echo "RELEASE_MANIFEST=$manifest"
