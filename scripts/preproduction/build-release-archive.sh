#!/usr/bin/env bash
set -euo pipefail
set +x

# Phase 2C · 不可变镜像归档构建器（CPS 短剧形态的离线运输）。
#
# 产物是一个自包含的归档：approved commit → 镜像 → docker save → zstd → SHA256。
# 下游（Phase 2C 部署）在目标机上校验 SHA256 → docker load → 核对镜像身份与
# revision label，全程不需要任何 registry、不需要 docker login、不需要 PAT。
#
# 🔴 身份字段一律来自**解析归档实际内容**（scripts/preproduction/image-identity.mjs），
# 不再把构建机 `docker inspect .Id` 无条件当成 config digest 写进 manifest。
# 那个值是随 image store 后端漂移的：经典 graphdriver 报 config digest，
# containerd image store 报 manifest digest。构建机恰好是哪一种，不该决定工件身份。
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

# 🔴 平台在**构建输入端**显式选定，不是只在构建后检查。
# 只做事后检查的话，在 arm64 主机上会先花十几分钟构建出一个 arm64 镜像、
# 再在最后一步被拒——而且一旦哪天事后检查被放宽，就再没有东西选定平台了。
target_platform="${RELEASE_TARGET_PLATFORM:-linux/amd64}"
export DOCKER_DEFAULT_PLATFORM="$target_platform"
docker compose -p "$P1_12_COMPOSE_PROJECT" -f "$root/docker-compose.yml" build web

# --- 身份校验：三条都必须过，任何一条不过就不产出归档 ---------------------

# 1) 目标平台。
#    🔴 这条断言不是形式主义。本仓 Dockerfile 把基础镜像钉成
#    `node:20-alpine@sha256:fb4cd12…`，那是一个 **amd64 单架构 manifest**，所以
#    即使在 arm64 的 Mac 上构建，产物也是 linux/amd64。但这层保证是**隐式**的——
#    谁把 NODE_BASE_IMAGE 换成一个 tag 或多架构索引 digest，arm64 机器就会静默
#    产出 arm64 镜像，装到 amd64 的 VPS 上直接跑不起来，而且要到部署时才发现。
#    这里把它变成显式断言。
actual_platform="$(docker image inspect "$local_image" --format '{{.Os}}/{{.Architecture}}')"
[[ "$actual_platform" == "$target_platform" ]] || {
  echo "ARCHIVE_BUILD=REFUSED reason=platform_mismatch expected=$target_platform actual=$actual_platform"
  exit 65
}

# 2) revision 标签必须等于 approved commit。
revision="$(docker image inspect "$local_image" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$revision" == "$APPROVED_GIT_COMMIT" ]] || refuse revision_label

# 3) 🔴 这里**不再**读 `.Id` 当作 config digest。见文件头说明。
#    真正的 config digest 在归档产出后由 image-identity.mjs 从 config blob 的
#    原始字节算出来。

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

# --- 解析归档实际内容，得到身份 -------------------------------------------
#
# 🔴 顺序很重要：先产出归档，再**从归档里**把身份读出来。反过来（先记下构建机
# 的读数、再产出归档）就是上一轮出事的形态——manifest 说的和归档里的可以不一致，
# 而且没人会发现。
identity="$("$root/scripts/preproduction/image-identity.mjs" resolve \
  --archive "$archive" --tag "$local_image" --platform "$target_platform")" || {
  echo "ARCHIVE_BUILD=REFUSED reason=identity_resolve"
  echo "$identity"
  exit 65
}

read -r target_digest target_media target_size \
       manifest_digest manifest_media manifest_size \
       config_digest config_size resolved_platform resolved_revision <<<"$(
  node -e '
    const id = JSON.parse(process.argv[1]);
    process.stdout.write([
      id.oci.target.digest, id.oci.target.mediaType, id.oci.target.size,
      id.oci.platform_manifest.digest, id.oci.platform_manifest.mediaType, id.oci.platform_manifest.size,
      id.oci.config.digest, id.oci.config.size,
      id.image_platform, id.image_revision,
    ].join(" "));
  ' "$identity")"

# 归档解析出来的事实必须与批准记录一致；不一致说明归档与批准对象不是一回事。
[[ "$resolved_revision" == "$APPROVED_GIT_COMMIT" ]] || refuse archive_revision
[[ "$resolved_platform" == "$target_platform" ]] || refuse archive_platform

# 🔴 用**下游同一套判据**回检构建机上的镜像。构建器自己验一遍，
# 等于在发货前就跑了一次消费端的判定逻辑；两边规则漂移会在这里当场暴露。
docker image inspect "$local_image" --format '{{json .}}' \
  | "$root/scripts/preproduction/image-identity.mjs" assert-image \
      --target-digest "$target_digest" --target-mediatype "$target_media" \
      --target-size "$target_size" --config-digest "$config_digest" \
      --platform "$target_platform" --revision "$APPROVED_GIT_COMMIT" || {
  echo "ARCHIVE_BUILD=REFUSED reason=builder_self_check"
  exit 65
}

# --- release manifest（schemaVersion 2）------------------------------------
#
# 🔴 身份不能只靠 tag，也不能只靠任何单一 digest。三类对象语义各不相同：
#   target descriptor   —— 归档 index.json 里指向本 tag 的那个对象
#   platform manifest   —— linux/amd64 实际使用的那份清单（单清单布局下与 target 同一对象）
#   config              —— 清单引用的 config blob
# containerd image store 认 manifest digest，经典 graphdriver 认 config digest，
# 两者都必须在案，消费端才能按自己的字段能力去判。
manifest="$archive_dir/${APPROVED_GIT_COMMIT}.json"
[[ ! -e "$manifest" ]] || refuse manifest_exists
"$root/scripts/preproduction/image-identity.mjs" build-manifest \
  --archive "$archive" --tag "$local_image" --platform "$target_platform" \
  --commit "$APPROVED_GIT_COMMIT" --version "$APP_VERSION" \
  --archive-filename "$archive_name" --archive-sha256 "$archive_sha" \
  --built-at "$BUILD_DATE" --source-repository "$source_repo" \
  --out "$manifest" >/dev/null || { echo "ARCHIVE_BUILD=REFUSED reason=manifest_build"; exit 65; }

# 🔴 最后再把 manifest 与归档双向核一遍。走的是消费端将来用的同一条路径：
# "manifest 自洽"毫无意义，必须是"manifest 所述 == 归档实际内容"。
"$root/scripts/preproduction/image-identity.mjs" verify-archive-against-manifest \
  --manifest "$manifest" --archive "$archive" >/dev/null || {
  echo "ARCHIVE_BUILD=REFUSED reason=manifest_archive_disagree"
  rm -f "$manifest"
  exit 65
}

echo "ARCHIVE_BUILD=PASS"
echo "ARCHIVE_FILE=$archive"
echo "ARCHIVE_SHA256=$archive_sha"
echo "IMAGE_TARGET_DIGEST=$target_digest"
echo "IMAGE_PLATFORM_MANIFEST_DIGEST=$manifest_digest"
echo "IMAGE_CONFIG_DIGEST=$config_digest"
echo "IMAGE_PLATFORM=$resolved_platform"
echo "IMAGE_REVISION=$resolved_revision"
echo "RELEASE_MANIFEST=$manifest"
