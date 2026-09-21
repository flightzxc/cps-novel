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

# --- Compose CLI 能力探测 ---------------------------------------------------
#
# 🔴 按 `--help` 里**真实存在的 flag** 判定，不按 `docker compose version` 的
# 版本号猜行为。
#
# 本轮 B2 事故的准确根因不是"Compose 改了 flag"——`run --no-build` 从来就不存在
# （实测 v2.24.0 / v2.29.7 / v2.32.0 / v2.36.0 / v5.0.1 / v5.5.1 全都没有，`up`
# 全都有）。它在 e274902 被写进来，而当时仓库里**没有任何测试引用过这两个入口**，
# 于是这条命令行直到在目标机上第一次真跑才第一次被执行。
# 同一个坑还有第二处：`run --pull` 在 v2.32.0 及更早也不存在（v2.36 才有），
# 所以 `--pull never` 同样按能力追加，真正承重的是 overlay 的 pull_policy: never。
# 🔴 只认 `--help` 的 flag 表那一列。裸 `grep -- "$2"` 会被描述文字里顺口提到的
# 同名 flag 骗过去——而"以为 run 支持 --no-build"正是本轮事故本身。
preprod_compose_subcommand_has_flag() {
  docker compose "$1" --help 2>/dev/null \
    | grep -qE "^[[:space:]]+(-[a-zA-Z], )?$2([[:space:]]|$)"
}

# --- 应用镜像入口的不可变工件闸门 -------------------------------------------
#
# 🔴 目标机三条硬约束，缺一不可：**不 build、不 pull、批准镜像缺失即 FAIL CLOSED**。
#
# 这三条过去全押在 CLI flag 上（`--no-build --pull never`）。那是错的，且已被实测
# 证伪：Compose v5 的 `run` 没有 `--no-build`，而只要 merged config 里还留着
# build: 段、批准镜像本地又缺失，`run --pull never` 就会**就地构建并以 0 退出**
# ——契约在没人察觉的地方失效，目标机上跑的不再是被批准的那个工件。
# （实测矩阵见 tests/backend/runtime/preproduction-compose-oneoff-runner.test.ts，
#  v5.0.1 与 v5.5.1 行为一致。）
#
# 因此闸门下沉到三处**不依赖 flag** 的地方：
#   1) preproduction 的 merged config 里根本没有 build: 段
#      —— overlay 用 `build: !reset null` 抹掉；注意普通 `build: null` 覆盖不掉
#         基文件（实测 build 仍在），只有 `!reset` 有效；
#   2) 渲染后每个跑批准镜像的服务都必须 pull_policy: never；
#   3) 批准镜像必须已经在本地，否则拒绝 —— 绝不把"镜像缺失"这件事交给 Compose
#      去"解决"。这与 CPS 短剧的 `frozen_image_missing` 预检是同一条不变量
#      （PRODUCTION_UPDATE_SOP §15：compose 文件里有 build: 段不等于允许构建）。
preprod_assert_app_runtime_immutable() {
  # 拒绝走 stderr、PASS 走 stdout：verify-release.sh 会把 one-off 的 stdout
  # 整条 >/dev/null，拒绝理由如果走 stdout 就只剩一个裸的非零退出码。
  [[ -n "${CPS_NOVEL_APP_IMAGE:-}" ]] || {
    echo "APP_RUNTIME=REFUSED reason=app_image_unset" >&2; return 65;
  }
  local rendered
  rendered="$(preprod_compose config)" || {
    echo "APP_RUNTIME=REFUSED reason=compose_config" >&2; return 65;
  }
  # 查的是**合并结果**，不是某个文件的文本：overlay 被漏掉 -f、被替换、
  # 或被降级成不带 `!reset` 的写法，都只会在这一步暴露。
  # 服务的 build: 在渲染结果里固定是 4 空格缩进；根部 `x-app-runtime:` 扩展字段
  # 那一份是 2 空格，Compose 不会执行它，所以刻意不匹配。
  if grep -qxE ' {4}build:' <<<"$rendered"; then
    echo "APP_RUNTIME=REFUSED reason=build_capability_present" >&2; return 65
  fi
  # 🔴 "不 pull"这一条同样不能只押在 flag 上：`run --pull` 在 Compose v2.32.0
  # 及更早根本不存在。真正承重的是 overlay 的 pull_policy: never，所以这里核的是
  # **渲染后每一个跑批准镜像的服务**都带着它——overlay 掉了这一行就在这里暴露。
  local unpinned
  unpinned="$(awk -v want="$CPS_NOVEL_APP_IMAGE" '
    /^[A-Za-z0-9._-]+:[[:space:]]*$/ { section=$0; svc=""; next }
    section == "services:" && /^  [A-Za-z0-9._-]+:[[:space:]]*$/ {
      svc=$1; sub(/:$/, "", svc); order[++n]=svc; next
    }
    svc != "" && $1 == "image:" && image[svc] == "" { v=$2; gsub(/"/, "", v); image[svc]=v }
    svc != "" && $1 == "pull_policy:" { v=$2; gsub(/"/, "", v); policy[svc]=v }
    END { for (i = 1; i <= n; i++) if (image[order[i]] == want && policy[order[i]] != "never") printf "%s ", order[i] }
  ' <<<"$rendered")"
  if [[ -n "${unpinned// /}" ]]; then
    echo "APP_RUNTIME=REFUSED reason=pull_policy_not_never services=${unpinned% }" >&2; return 65
  fi
  docker image inspect "$CPS_NOVEL_APP_IMAGE" >/dev/null 2>&1 || {
    echo "APP_RUNTIME=REFUSED reason=approved_image_missing ref=$CPS_NOVEL_APP_IMAGE" >&2; return 65;
  }
  # manifest 已加载时（deploy / rollback 路径）判据升级为完整身份比对，
  # 而不只是"这个 tag 在本地存在"：retag / 同名旧缓存都要在这里被拒绝。
  if [[ -n "${PREPROD_RELEASE_TARGET_DIGEST:-}" ]]; then
    # 成功时不重复刷屏（preflight / read_manifest 已经打过 PASS），
    # 失败时把判定器的**具体 reason** 原样带出来，否则现场只剩一句笼统的拒绝。
    local identity
    if ! identity="$(preprod_assert_local_image "$CPS_NOVEL_APP_IMAGE" 2>&1)"; then
      echo "$identity" >&2
      echo "APP_RUNTIME=REFUSED reason=app_image_identity ref=$CPS_NOVEL_APP_IMAGE" >&2
      return 65
    fi
    echo "APP_RUNTIME=PASS image=$CPS_NOVEL_APP_IMAGE identity=verified"
    return 0
  fi
  # 🔴 没有 manifest 时只证明了"这个 tag 在本地存在"，没证明它就是被批准的那个
  # 工件。明说出来，别让调用方以为这条路径的身份也核过了。
  echo "APP_RUNTIME=PASS image=$CPS_NOVEL_APP_IMAGE identity=unverified_no_manifest"
  return 0
}

# 🔴 应用镜像入口一律经这两个函数。承重的是 preprod_assert_app_runtime_immutable
# 断言的那三条 merged-config / 本地镜像事实；`--pull never` 与 `--no-build` 退化为
# 锦上添花的第二道，且**只在该子命令确实支持该 flag 时**才追加——不支持就不加，
# 契约不因此变松，因为它本来就不靠 flag 站住。
preprod_compose_app_up() {
  preprod_assert_app_runtime_immutable || return 65
  local flags=()
  if preprod_compose_subcommand_has_flag up "--pull"; then flags+=(--pull never); fi
  if preprod_compose_subcommand_has_flag up "--no-build"; then flags+=(--no-build); fi
  preprod_compose up -d --no-deps ${flags[@]+"${flags[@]}"} "$@"
}

# one-off（migration / verify-admin-auth）与 up 共用同一套闸门和同一份 Compose
# 运行时定义——network / user / workdir / env / secrets / 挂载都来自同一个 merged
# config，不另起一套 `docker run`，避免第二套会各自漂移的运行时。
preprod_compose_app_run() {
  preprod_assert_app_runtime_immutable || return 65
  local flags=()
  if preprod_compose_subcommand_has_flag run "--pull"; then flags+=(--pull never); fi
  if preprod_compose_subcommand_has_flag run "--no-build"; then flags+=(--no-build); fi
  preprod_compose run --rm --no-deps ${flags[@]+"${flags[@]}"} "$@"
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
