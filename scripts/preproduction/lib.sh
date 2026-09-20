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
# 🔴 按 JSON **数据**解析（JSON.parse + readFileSync），不用 require()——
#    require 会按扩展名决定行为，指到一个 .js 就变成执行代码。
#
# 成功后导出（调用方只认这几个变量，不再自己解析 manifest）：
#   PREPROD_RELEASE_COMMIT          approved 40-hex commit
#   PREPROD_RELEASE_IMAGE_REF       交给 Compose 的镜像引用（= image_tag）
#   PREPROD_RELEASE_IMAGE_DIGEST    config digest，跨主机稳定的身份
#   PREPROD_RELEASE_PLATFORM        目标平台
#   PREPROD_RELEASE_ARCHIVE         归档文件名（纯文件名，不含路径）
#   PREPROD_RELEASE_ARCHIVE_SHA256  归档 SHA256
preprod_read_release_manifest() {
  local manifest="$1"
  [[ "$manifest" = /* && -r "$manifest" ]] || {
    echo "MANIFEST=REFUSED reason=manifest_unreadable"; return 66;
  }
  command -v node >/dev/null 2>&1 || { echo "MANIFEST=REFUSED reason=node_missing"; return 69; }

  local parsed
  parsed="$(node -e '
    const fs = require("node:fs");
    let m;
    try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch { console.log("reason=manifest_not_json"); process.exit(1); }
    const bad = (r) => { console.log("reason=" + r); process.exit(1); };
    if (m === null || typeof m !== "object" || Array.isArray(m)) bad("manifest_not_object");
    if (m.schemaVersion !== 1) bad("manifest_schema_version");
    // 🔴 只接受归档运输。registry 形态的 manifest（GHCR PoC 遗留）一律拒绝：
    // 生产运输方式只有一种，留后门就会有人从后门进来。
    if (m.transport !== "archive") bad("manifest_transport");
    const str = (k, re) => {
      const v = m[k];
      if (typeof v !== "string" || !re.test(v)) bad("manifest_" + k);
      return v;
    };
    const commit = str("approved_git_commit", /^[0-9a-f]{40}$/);
    const tag = str("image_tag", /^[A-Za-z0-9][A-Za-z0-9._\/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/);
    // 🔴 image_tag 不得带 @sha256:。把 config digest 拼成 repo@sha256 是伪造的
    // registry 引用——config digest 与 registry manifest digest 是两个不同的东西，
    // 拼出来的引用在任何 registry 上都不存在，只会让身份校验看起来通过。
    if (tag.includes("@")) bad("manifest_image_tag_digest_forgery");
    const digest = str("image_config_digest", /^sha256:[0-9a-f]{64}$/);
    const platform = str("image_platform", /^[a-z0-9]+\/[a-z0-9_]+$/);
    const archive = str("archive_filename", /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    // 🔴 归档文件名必须是纯文件名：带 / 或 .. 就能让校验目标越出允许目录。
    if (archive.includes("/") || archive.includes("..")) bad("manifest_archive_path");
    const sha = str("archive_sha256", /^[0-9a-f]{64}$/);
    process.stdout.write([commit, tag, digest, platform, archive, sha].join("\n"));
  ' "$manifest")" || {
    echo "MANIFEST=REFUSED $parsed"; return 65;
  }

  {
    read -r PREPROD_RELEASE_COMMIT
    read -r PREPROD_RELEASE_IMAGE_REF
    read -r PREPROD_RELEASE_IMAGE_DIGEST
    read -r PREPROD_RELEASE_PLATFORM
    read -r PREPROD_RELEASE_ARCHIVE
    read -r PREPROD_RELEASE_ARCHIVE_SHA256
  } <<<"$parsed"
  export PREPROD_RELEASE_COMMIT PREPROD_RELEASE_IMAGE_REF PREPROD_RELEASE_IMAGE_DIGEST \
    PREPROD_RELEASE_PLATFORM PREPROD_RELEASE_ARCHIVE PREPROD_RELEASE_ARCHIVE_SHA256
}

# --- 本地镜像身份 ----------------------------------------------------------
#
# 🔴 "manifest 指定的 ID 在本地存在"**不等于**"tag 指向它"。
# load 之后有人 `docker tag` 把同名 tag 指到别的镜像，或者本机早就缓存着一个
# 同名旧 tag —— 两种情况下按 digest inspect 都能成功，但 Compose 用的是 tag。
# 所以必须**从 tag 出发**解析出 ID，再与 manifest 的 config digest 比对。
preprod_assert_local_image() {
  local ref="$1" want_digest="$2" want_commit="$3" want_platform="${4:-}"
  local actual_id
  actual_id="$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null)" || {
    echo "IMAGE=REFUSED reason=image_missing ref=$ref"; return 65;
  }
  [[ "$actual_id" == "$want_digest" ]] || {
    echo "IMAGE=REFUSED reason=tag_digest_mismatch ref=$ref expected=$want_digest actual=$actual_id"
    return 65
  }
  local revision
  revision="$(docker image inspect "$ref" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)"
  [[ "$revision" == "$want_commit" ]] || {
    echo "IMAGE=REFUSED reason=revision_mismatch expected=$want_commit actual=$revision"; return 65;
  }
  if [[ -n "$want_platform" ]]; then
    local platform
    platform="$(docker image inspect "$ref" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null)"
    [[ "$platform" == "$want_platform" ]] || {
      echo "IMAGE=REFUSED reason=platform_mismatch expected=$want_platform actual=$platform"; return 65;
    }
  fi
}

# --- 运行中容器的镜像身份 --------------------------------------------------
#
# 🔴 预检通过 ≠ 容器真的用了那个镜像。容器可能是上一轮遗留的、可能因为
# pull_policy/缓存起到了别的镜像。启动之后必须再核一次**实际容器**的 Image ID。
preprod_assert_container_image() {
  local want_digest="$1"; shift
  local service cid actual
  for service in "$@"; do
    cid="$(preprod_compose ps -q "$service" 2>/dev/null | head -1)"
    [[ -n "$cid" ]] || { echo "RUNTIME_IMAGE=REFUSED reason=container_missing service=$service"; return 65; }
    actual="$(docker inspect "$cid" --format '{{.Image}}' 2>/dev/null)"
    [[ "$actual" == "$want_digest" ]] || {
      echo "RUNTIME_IMAGE=REFUSED reason=container_image_mismatch service=$service expected=$want_digest actual=$actual"
      return 65
    }
  done
  echo "RUNTIME_IMAGE=PASS services=$*"
}
