#!/usr/bin/env bash

PREPROD_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${PREPROD_ENV_FILE:=/opt/cps-novel/shared/env/preprod.env}"

# 🔴 应用镜像的**唯一真源是 release manifest**，不是 shared env。
# shared env 里若也写了 CPS_NOVEL_APP_IMAGE，会把 manifest 指定的新版本悄悄
# 覆盖回旧版本（`set -a; source env` 会覆盖已导出的同名变量），而容器照样能起来，
# 只是跑的是上一版。preprod_load_env() 因此在 source 前后比对这一个变量。
preprod_load_env() {
  [[ "$PREPROD_ENV_FILE" = /* && -r "$PREPROD_ENV_FILE" ]] || {
    echo "ERROR: PREPROD_ENV_FILE must be an absolute readable file" >&2
    return 66
  }
  local inherited_image="${CPS_NOVEL_APP_IMAGE:-}" inherited_commit="${GIT_COMMIT:-}"
  set -a
  # shellcheck disable=SC1090
  source "$PREPROD_ENV_FILE"
  set +a
  [[ "${P1_12_COMPOSE_PROJECT:-}" == "cps-novel" ]] || {
    echo "ERROR: P1_12_COMPOSE_PROJECT must equal cps-novel" >&2
    return 65
  }
  if [[ -n "$inherited_image" && "${CPS_NOVEL_APP_IMAGE:-}" != "$inherited_image" ]]; then
    echo "ERROR: env file overrides CPS_NOVEL_APP_IMAGE (manifest=$inherited_image env=${CPS_NOVEL_APP_IMAGE:-})" >&2
    return 65
  fi
  if [[ -n "$inherited_commit" && "${GIT_COMMIT:-}" != "$inherited_commit" ]]; then
    echo "ERROR: env file overrides GIT_COMMIT (manifest=$inherited_commit env=${GIT_COMMIT:-})" >&2
    return 65
  fi
  [[ -z "$inherited_image" ]] || export CPS_NOVEL_APP_IMAGE="$inherited_image"
  [[ -z "$inherited_commit" ]] || export GIT_COMMIT="$inherited_commit"
}

preprod_compose() {
  docker compose --env-file "$PREPROD_ENV_FILE" -p cps-novel \
    -f "$PREPROD_REPO_ROOT/docker-compose.yml" \
    -f "$PREPROD_REPO_ROOT/infra/preproduction/docker-compose.yml" "$@"
}

# 🔴 应用镜像入口一律经此函数，绝不允许隐式 pull 或就地 build。
# 根 compose 的 x-app-runtime 同时带 image: 与 build:，镜像缺失时 `up` 会直接
# 在目标机上构建——那等于把"发布的是被批准的那个工件"这条契约作废。
# --no-build 挡构建，--pull never 挡拉取；overlay 里的 pull_policy: never 是第二道。
preprod_compose_app_up() {
  preprod_compose up -d --no-deps --no-build --pull never "$@"
}

preprod_compose_app_run() {
  preprod_compose run --rm --no-deps --no-build --pull never "$@"
}

# --- release manifest：统一读取入口 ----------------------------------------
#
# 🔴 deploy 与 rollback 必须走同一个读取器，否则两条路径的身份校验会各自漂移。
# 🔴 解析与判定的**唯一实现**在 scripts/preproduction/image-identity.mjs。
#    这里只负责把结果搬进 shell 变量，不在 bash 里再写一份规则。
#
# 成功后导出（调用方只认这几个变量，不再自己解析 manifest）：
#   PREPROD_RELEASE_COMMIT            approved 40-hex commit
#   PREPROD_RELEASE_IMAGE_REF         交给 Compose 的镜像引用（= image_tag）
#   PREPROD_RELEASE_PLATFORM          目标平台
#   PREPROD_RELEASE_REVISION          镜像 revision 标签（== commit）
#   PREPROD_RELEASE_ARCHIVE           归档文件名（纯文件名，不含路径）
#   PREPROD_RELEASE_ARCHIVE_SHA256    归档 SHA256
#   PREPROD_RELEASE_TARGET_DIGEST     归档 index 中指向本 tag 的对象
#   PREPROD_RELEASE_TARGET_MEDIATYPE  同上的 mediaType
#   PREPROD_RELEASE_TARGET_SIZE       同上的字节数
#   PREPROD_RELEASE_MANIFEST_DIGEST   linux/amd64 实际使用的那份清单
#   PREPROD_RELEASE_CONFIG_DIGEST     清单引用的 config blob
#
# 🔴 刻意不再导出名为 PREPROD_RELEASE_IMAGE_DIGEST 的变量。那个名字没有说清
#    "哪一种 digest"，正是上一轮把 manifest digest 和 config digest 混为一谈的入口。
preprod_read_release_manifest() {
  local manifest="$1"
  [[ "$manifest" = /* ]] || { echo "MANIFEST=REFUSED reason=manifest_path_not_absolute"; return 66; }
  command -v node >/dev/null 2>&1 || { echo "MANIFEST=REFUSED reason=node_missing"; return 69; }

  local parsed status
  parsed="$(node "$PREPROD_REPO_ROOT/scripts/preproduction/image-identity.mjs" \
    read-manifest --manifest "$manifest")"
  status=$?
  if (( status != 0 )); then echo "$parsed"; return "$status"; fi

  {
    read -r PREPROD_RELEASE_COMMIT
    read -r PREPROD_RELEASE_IMAGE_REF
    read -r PREPROD_RELEASE_PLATFORM
    read -r PREPROD_RELEASE_REVISION
    read -r PREPROD_RELEASE_ARCHIVE
    read -r PREPROD_RELEASE_ARCHIVE_SHA256
    read -r PREPROD_RELEASE_TARGET_DIGEST
    read -r PREPROD_RELEASE_TARGET_MEDIATYPE
    read -r PREPROD_RELEASE_TARGET_SIZE
    read -r PREPROD_RELEASE_MANIFEST_DIGEST
    read -r PREPROD_RELEASE_MANIFEST_MEDIATYPE
    read -r PREPROD_RELEASE_MANIFEST_SIZE
    read -r PREPROD_RELEASE_CONFIG_DIGEST
    read -r PREPROD_RELEASE_CONFIG_SIZE
  } <<<"$parsed"
  export PREPROD_RELEASE_COMMIT PREPROD_RELEASE_IMAGE_REF PREPROD_RELEASE_PLATFORM \
    PREPROD_RELEASE_REVISION PREPROD_RELEASE_ARCHIVE PREPROD_RELEASE_ARCHIVE_SHA256 \
    PREPROD_RELEASE_TARGET_DIGEST PREPROD_RELEASE_TARGET_MEDIATYPE PREPROD_RELEASE_TARGET_SIZE \
    PREPROD_RELEASE_MANIFEST_DIGEST PREPROD_RELEASE_MANIFEST_MEDIATYPE PREPROD_RELEASE_MANIFEST_SIZE \
    PREPROD_RELEASE_CONFIG_DIGEST PREPROD_RELEASE_CONFIG_SIZE
}

# --- 本地镜像身份 ----------------------------------------------------------
#
# 🔴 "manifest 指定的 digest 在本地存在"**不等于**"tag 指向它"。load 之后有人
# `docker tag` 把同名 tag 指到别的镜像，或本机早就缓存着一个同名旧 tag —— 两种
# 情况下按 digest inspect 都能成功，但 Compose 用的是 tag。所以**从 tag 出发**。
#
# 🔴 判据锚点按字段能力选，不按 Docker 版本号或 storage-driver 字符串猜：
#     有 .Descriptor（containerd image store）→ 以 Descriptor 为准，冲突即拒绝；
#     无 .Descriptor（经典 graphdriver）      → .Id 即 config digest。
# 判定逻辑在 image-identity.mjs assert-image，与构建器、preflight、deploy 同一份。
preprod_assert_local_image() {
  local ref="$1"
  local inspected
  inspected="$(docker image inspect "$ref" --format '{{json .}}' 2>/dev/null)" || {
    echo "IMAGE=REFUSED reason=image_missing ref=$ref"; return 65;
  }
  printf '%s' "$inspected" | node "$PREPROD_REPO_ROOT/scripts/preproduction/image-identity.mjs" \
    assert-image \
    --target-digest "$PREPROD_RELEASE_TARGET_DIGEST" \
    --target-mediatype "$PREPROD_RELEASE_TARGET_MEDIATYPE" \
    --target-size "$PREPROD_RELEASE_TARGET_SIZE" \
    --config-digest "$PREPROD_RELEASE_CONFIG_DIGEST" \
    --platform "$PREPROD_RELEASE_PLATFORM" \
    --revision "$PREPROD_RELEASE_REVISION"
}

# --- 运行中容器的镜像身份 --------------------------------------------------
#
# 🔴 预检通过 ≠ 容器真的用了那个镜像。容器可能是上一轮遗留的、可能因为
# pull_policy/缓存起到了别的镜像。启动之后必须再核一次**实际容器**。
#
# 🔴 有 .ImageManifestDescriptor 时与**选中的平台 manifest** 比，而不是拿外层
# index digest 比：多平台 index 下容器跑的是某一个平台的清单，外层 digest 永远不等。
preprod_assert_container_image() {
  local service cid inspected
  for service in "$@"; do
    cid="$(preprod_compose ps -q "$service" 2>/dev/null | head -1)"
    [[ -n "$cid" ]] || { echo "RUNTIME_IMAGE=REFUSED reason=container_missing service=$service"; return 65; }
    inspected="$(docker inspect "$cid" --format '{{json .}}' 2>/dev/null)" || {
      echo "RUNTIME_IMAGE=REFUSED reason=container_uninspectable service=$service"; return 65;
    }
    printf '%s' "$inspected" | node "$PREPROD_REPO_ROOT/scripts/preproduction/image-identity.mjs" \
      assert-container \
      --platform-manifest-digest "$PREPROD_RELEASE_MANIFEST_DIGEST" \
      --config-digest "$PREPROD_RELEASE_CONFIG_DIGEST" \
      --platform "$PREPROD_RELEASE_PLATFORM" \
      --service "$service" || return 65

    # 容器指向的镜像实体本身也要核 revision 与平台——
    # 只比对 digest 不足以说明"这个镜像是被批准那一个"。
    local image_ref
    image_ref="$(docker inspect "$cid" --format '{{.Image}}' 2>/dev/null)"
    preprod_assert_local_image "$image_ref" >/dev/null || {
      echo "RUNTIME_IMAGE=REFUSED reason=container_image_identity service=$service"; return 65;
    }
  done
  echo "RUNTIME_IMAGE=PASS services=$*"
}
