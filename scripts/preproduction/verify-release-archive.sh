#!/usr/bin/env bash
set -euo pipefail
set +x

# Phase 2C · 归档工件校验器。**这是 VPS 侧实际运行的那一支**。
#
# 它刻意不依赖本仓代码、不依赖 registry、不依赖网络：输入只有归档文件与
# release manifest，两者都随工件一起 SCP 过去。VPS 上只需要 bash + coreutils
# （或 shasum）+ zstd + docker。
#
# 用法：
#   verify-release-archive.sh --manifest <manifest.json> [--dir <归档所在目录>] [--load]
#
#   不带 --load：只做**离线完整性**校验（manifest 形状 + 归档 SHA256）。
#               这一步必须先过，再决定要不要把内容装进 Docker。
#   带  --load：继续 docker load，并核对 config digest / revision label / 平台。
#
# 🔴 任何一项不符即以非零码退出并打印 VERIFY=FAIL reason=...，**不得继续部署**。

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

[[ -n "$manifest" && -r "$manifest" ]] || refuse manifest_unreadable
command -v node >/dev/null 2>&1 || refuse node_missing

read_field() { node -e '
  const m=require(process.argv[1]);
  const v=m[process.argv[2]];
  process.stdout.write(typeof v === "string" ? v : "");
' "$manifest" "$1" 2>/dev/null || true; }

commit="$(read_field approved_git_commit)"
config_digest="$(read_field image_config_digest)"
archive_name="$(read_field archive_filename)"
archive_sha="$(read_field archive_sha256)"
image_tag="$(read_field image_tag)"
platform="$(read_field image_platform)"
transport="$(read_field transport)"

# --- manifest 形状 ---------------------------------------------------------
[[ "$transport" == "archive" ]]                  || refuse manifest_transport
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]                || refuse manifest_commit_shape
[[ "$config_digest" =~ ^sha256:[0-9a-f]{64}$ ]]  || refuse manifest_config_digest_shape
[[ "$archive_sha" =~ ^[0-9a-f]{64}$ ]]           || refuse manifest_archive_sha_shape
[[ -n "$archive_name" ]]                         || refuse manifest_archive_filename
[[ -n "$image_tag" ]]                            || refuse manifest_image_tag

# --- 归档完整性 ------------------------------------------------------------
dir="${dir:-$(cd "$(dirname "$manifest")" && pwd)}"
archive="$dir/$archive_name"
[[ -r "$archive" ]] || refuse archive_unreadable

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
else
  refuse no_sha256_tool
fi

# 🔴 篡改归档、传输截断、manifest 被改成别的 sha —— 三种都在这一行被挡住。
[[ "$actual_sha" == "$archive_sha" ]] || {
  echo "VERIFY=FAIL reason=archive_sha_mismatch expected=$archive_sha actual=$actual_sha"
  exit 65
}

echo "VERIFY_OFFLINE=PASS"
echo "  approved_git_commit=$commit"
echo "  archive_sha256=$actual_sha"
echo "  image_config_digest=$config_digest"

[[ "$do_load" == "1" ]] || exit 0

# --- 装载并核对镜像身份 ----------------------------------------------------
command -v docker >/dev/null 2>&1 || refuse docker_missing
command -v zstd >/dev/null 2>&1 || refuse zstd_missing

zstd -d -q -c "$archive" | docker load >/dev/null || refuse docker_load

inspect() { docker image inspect "$config_digest" --format "$1" 2>/dev/null || true; }

# 🔴 用 config digest 而不是 tag 去 inspect：tag 可以被任何人在本地随便指到
# 另一个镜像上，config digest 不行。这一步是"装进来的确实是 manifest 描述的
# 那个镜像"的唯一证明。
loaded_id="$(inspect '{{.Id}}')"
[[ "$loaded_id" == "$config_digest" ]] || refuse loaded_digest_mismatch

loaded_revision="$(inspect '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$loaded_revision" == "$commit" ]] || {
  echo "VERIFY=FAIL reason=revision_mismatch expected=$commit actual=$loaded_revision"
  exit 65
}

loaded_platform="$(inspect '{{.Os}}/{{.Architecture}}')"
if [[ -n "$platform" && "$loaded_platform" != "$platform" ]]; then
  echo "VERIFY=FAIL reason=platform_mismatch expected=$platform actual=$loaded_platform"
  exit 65
fi

echo "VERIFY=PASS"
echo "  loaded_config_digest=$loaded_id"
echo "  revision=$loaded_revision"
echo "  platform=$loaded_platform"
echo "  image_tag=$image_tag"
