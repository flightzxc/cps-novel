#!/usr/bin/env bash
set -euo pipefail
set +x

# Phase 2C · 归档工件校验器。**这是目标机上实际运行的那一支**。
#
# 用法：
#   verify-release-archive.sh --manifest <绝对路径/manifest.json> [--dir <归档目录>]
#                             [--expected-archive-sha256 <64hex>]
#                             [--approved-commit <40hex>]
#                             [--load]
#
#   不带 --load：离线校验（manifest 形状 + 归档 SHA256 + 归档内容 ↔ manifest 双向核对）。
#   带  --load：继续 docker load，并按 image store 的字段能力核对镜像身份。
#
# 🔴 宿主机工具前置条件（缺失即在任何服务变更之前失败，**不临时安装**）：
#   一律需要：bash、coreutils（sha256sum 或 shasum）、**node**、**zstd**
#   仅 --load 需要：docker
# node 是必需的——归档与 manifest 都按数据解析，不用 shell 拼字符串去猜结构。
# zstd 现在离线阶段就需要：要解压扫描归档内容，而不是只算整包哈希。
#
# 🔴 解析与判定共用 scripts/preproduction/image-identity.mjs，**不是第二份实现**。
# 两份实现早晚会漂移，而漂移的表现是"校验器说没问题、发布脚本说身份不符"。
#
# 🔴 批准记录独立于收到的文件：--expected-archive-sha256 来自构建交付记录，
# 与归档旁边的 manifest 无关。只证明"archive 与它旁边的 manifest 互相一致"是
# 不够的——伪造者把两边一起写就通过了。

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"
identity_tool="$root/scripts/preproduction/image-identity.mjs"

refuse() { echo "VERIFY=FAIL reason=$1"; exit 65; }

manifest=""; dir=""; do_load=0; expected_sha=""; approved_commit=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) manifest="${2:-}"; shift 2 ;;
    --dir) dir="${2:-}"; shift 2 ;;
    --expected-archive-sha256) expected_sha="${2:-}"; shift 2 ;;
    --approved-commit) approved_commit="${2:-}"; shift 2 ;;
    --load) do_load=1; shift ;;
    *) echo "usage: verify-release-archive.sh --manifest FILE [--dir DIR] [--expected-archive-sha256 HEX] [--approved-commit HEX] [--load]" >&2; exit 64 ;;
  esac
done

# --- 工具前置条件（先查，缺什么直接说，不要跑到一半才炸）------------------
command -v node >/dev/null 2>&1 || refuse tool_missing_node
command -v zstd >/dev/null 2>&1 || refuse tool_missing_zstd
if command -v sha256sum >/dev/null 2>&1; then sha_cmd=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then sha_cmd=(shasum -a 256)
else refuse tool_missing_sha256; fi
if [[ "$do_load" == "1" ]]; then
  command -v docker >/dev/null 2>&1 || refuse tool_missing_docker
fi

[[ -n "$manifest" ]] || refuse manifest_unset
# 与 release.sh 同一个解析器：schemaVersion / transport / 各字段形状 / OCI
# descriptor 关系 / 路径安全都在那里统一判定。v1 在这里被明确拒绝。
preprod_read_release_manifest "$manifest" || exit $?

# --- 归档完整性 ------------------------------------------------------------
# 🔴 归档必须与 manifest 同目录（或 --dir 显式指定的目录）内。archive_filename
# 已在解析器里限定为纯文件名（无 / 无 ..），这里再拼绝对路径，避免越出目录。
dir="${dir:-$(cd "$(dirname "$manifest")" && pwd)}"
[[ "$dir" = /* ]] || refuse dir_not_absolute
archive="$dir/$PREPROD_RELEASE_ARCHIVE"
[[ -r "$archive" ]] || refuse archive_unreadable

actual_sha="$("${sha_cmd[@]}" "$archive" | awk '{print $1}')"
[[ "$actual_sha" == "$PREPROD_RELEASE_ARCHIVE_SHA256" ]] || {
  echo "VERIFY=FAIL reason=archive_sha_mismatch expected=$PREPROD_RELEASE_ARCHIVE_SHA256 actual=$actual_sha"
  exit 65
}

# 🔴 与**批准记录**核对，而不是只与随行 manifest 核对。
if [[ -n "$expected_sha" ]]; then
  [[ "$actual_sha" == "$expected_sha" ]] || {
    echo "VERIFY=FAIL reason=archive_sha_not_approved approved=$expected_sha actual=$actual_sha"
    exit 65
  }
fi
if [[ -n "$approved_commit" ]]; then
  [[ "$PREPROD_RELEASE_COMMIT" == "$approved_commit" ]] || {
    echo "VERIFY=FAIL reason=commit_not_approved approved=$approved_commit manifest=$PREPROD_RELEASE_COMMIT"
    exit 65
  }
fi

# 🔴 归档实际内容 ↔ manifest 声明，双向核对：target → platform manifest → config
# 的引用链实际走通，每个 digest 按原始字节复算，层全部在档。
"$identity_tool" verify-archive-against-manifest --manifest "$manifest" --archive "$archive" || exit 65

echo "VERIFY_OFFLINE=PASS"
echo "  approved_git_commit=$PREPROD_RELEASE_COMMIT"
echo "  archive_sha256=$actual_sha"
echo "  image_tag=$PREPROD_RELEASE_IMAGE_REF"
echo "  approval_record_checked=$( [[ -n "$expected_sha$approved_commit" ]] && echo yes || echo no )"

[[ "$do_load" == "1" ]] || exit 0

# --- 装载并核对镜像身份 ----------------------------------------------------
zstd -d -q -c "$archive" | docker load >/dev/null || refuse docker_load

# 🔴 从 **tag** 出发核对，而不是按某个 digest inspect。
# "manifest 指定的那个对象在本地存在"是个弱得多的命题：本机可能早就缓存着它，
# 而同名 tag 却指向别的镜像——Compose 用的是 tag，于是跑起来的是另一个东西。
#
# 锚点由字段能力决定（见 lib.sh 与 image-identity.mjs）：
#   containerd image store → .Descriptor
#   经典 graphdriver       → .Id（即 config digest）
preprod_assert_local_image "$PREPROD_RELEASE_IMAGE_REF" || exit 65

echo "VERIFY=PASS"
echo "  image_tag          =$PREPROD_RELEASE_IMAGE_REF"
echo "  target             =$PREPROD_RELEASE_TARGET_DIGEST"
echo "  platform_manifest  =$PREPROD_RELEASE_MANIFEST_DIGEST"
echo "  config             =$PREPROD_RELEASE_CONFIG_DIGEST"
echo "  platform           =$PREPROD_RELEASE_PLATFORM"
echo "  revision           =$PREPROD_RELEASE_REVISION"
