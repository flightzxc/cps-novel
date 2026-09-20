#!/usr/bin/env bash
set -euo pipefail
set +x

# Phase 2C · 归档工件校验器。**这是目标机上实际运行的那一支**。
#
# 用法：
#   verify-release-archive.sh --manifest <绝对路径/manifest.json> [--dir <归档目录>] [--load]
#
#   不带 --load：只做**离线完整性**校验（manifest 形状 + 归档 SHA256）。
#   带  --load：继续 docker load，并核对 config digest / revision / 平台。
#
# 🔴 宿主机工具前置条件（缺失即在任何服务变更之前失败，**不临时安装**）：
#   一律需要：bash、coreutils（sha256sum 或 shasum）、**node**
#   仅 --load 需要：docker、zstd
# node 是必需的——manifest 按 JSON 数据解析，不用 shell 拼字符串去猜结构。
#
# 🔴 manifest 解析与 release.sh / preflight.sh 共用 lib.sh 里的
# preprod_read_release_manifest()，**不是第二份实现**。两份解析器早晚会漂移，
# 而漂移的表现是"校验器说没问题、发布脚本说身份不符"。

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"

refuse() { echo "VERIFY=FAIL reason=$1"; exit 65; }

manifest=""; dir=""; do_load=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) manifest="${2:-}"; shift 2 ;;
    --dir) dir="${2:-}"; shift 2 ;;
    --load) do_load=1; shift ;;
    *) echo "usage: verify-release-archive.sh --manifest FILE [--dir DIR] [--load]" >&2; exit 64 ;;
  esac
done

# --- 工具前置条件（先查，缺什么直接说，不要跑到一半才炸）------------------
command -v node >/dev/null 2>&1 || refuse tool_missing_node
if command -v sha256sum >/dev/null 2>&1; then sha_cmd=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then sha_cmd=(shasum -a 256)
else refuse tool_missing_sha256; fi
if [[ "$do_load" == "1" ]]; then
  command -v docker >/dev/null 2>&1 || refuse tool_missing_docker
  command -v zstd >/dev/null 2>&1 || refuse tool_missing_zstd
fi

[[ -n "$manifest" ]] || refuse manifest_unset
# 与 release.sh 同一个解析器：schemaVersion / transport / 各字段形状 / 路径安全
# 都在那里统一判定。
preprod_read_release_manifest "$manifest" || exit $?

commit="$PREPROD_RELEASE_COMMIT"
config_digest="$PREPROD_RELEASE_IMAGE_DIGEST"
archive_name="$PREPROD_RELEASE_ARCHIVE"
archive_sha="$PREPROD_RELEASE_ARCHIVE_SHA256"
image_tag="$PREPROD_RELEASE_IMAGE_REF"
platform="$PREPROD_RELEASE_PLATFORM"

# --- 归档完整性 ------------------------------------------------------------
# 🔴 归档必须与 manifest 同目录（或 --dir 显式指定的目录）内。archive_filename
# 已在解析器里限定为纯文件名（无 / 无 ..），这里再拼绝对路径，避免越出目录。
dir="${dir:-$(cd "$(dirname "$manifest")" && pwd)}"
[[ "$dir" = /* ]] || refuse dir_not_absolute
archive="$dir/$archive_name"
[[ -r "$archive" ]] || refuse archive_unreadable

actual_sha="$("${sha_cmd[@]}" "$archive" | awk '{print $1}')"
[[ "$actual_sha" == "$archive_sha" ]] || {
  echo "VERIFY=FAIL reason=archive_sha_mismatch expected=$archive_sha actual=$actual_sha"
  exit 65
}

echo "VERIFY_OFFLINE=PASS"
echo "  approved_git_commit=$commit"
echo "  archive_sha256=$actual_sha"
echo "  image_config_digest=$config_digest"
echo "  image_tag=$image_tag"

[[ "$do_load" == "1" ]] || exit 0

# --- 装载并核对镜像身份 ----------------------------------------------------
zstd -d -q -c "$archive" | docker load >/dev/null || refuse docker_load

# 🔴 从 **tag** 出发核对，而不是只按 config digest inspect。
# "manifest 指定的那个 ID 在本地存在"是个弱得多的命题：本机可能早就缓存着它，
# 而同名 tag 却指向别的镜像——Compose 用的是 tag，于是跑起来的是另一个东西。
preprod_assert_local_image "$image_tag" "$config_digest" "$commit" "$platform" || exit 65

echo "VERIFY=PASS"
echo "  loaded_config_digest=$config_digest"
echo "  revision=$commit"
echo "  platform=$platform"
echo "  image_tag=$image_tag"
