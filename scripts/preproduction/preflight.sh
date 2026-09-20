#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"

fail() { echo "PREPROD_PREFLIGHT=FAIL reason=$1"; exit "${2:-65}"; }

# 🔴 经 lib.sh 加载 env，而不是自己 source：那里有"shared env 不得覆盖 manifest
# 指定的 CPS_NOVEL_APP_IMAGE"这道闸。自己 source 会把调用方（release.sh）导出的
# 镜像引用悄悄换回 env 文件里的旧值，而后续检查全都对着旧值做，一路绿灯。
preprod_load_env || fail env_file 66
[[ "${P1_12_COMPOSE_PROJECT:-}" == "cps-novel" ]] || fail compose_project
[[ "${SITE_URL:-}" == "https://www.bangbangji.cloud" ]] || fail site_url
[[ "${ADMIN_CANONICAL_ORIGIN:-}" == "https://zbcwf.bangbangji.cloud" ]] || fail admin_origin
[[ "${PUBLIC_TRACKING_WRITE_DISABLED:-}" == "1" ]] || fail tracking_write_gate
[[ "${ADMIN_TWO_FACTOR_ENFORCEMENT:-}" == "true" ]] || fail two_factor_enforcement
[[ "${FEATURE_INDEXNOW_OUTBOX:-}" == "false" && "${INDEXNOW_OUTBOX_ALLOW_WRITE:-}" == "false" ]] || fail indexnow_outbox
[[ "${FEATURE_INDEXNOW_DELIVERY:-}" == "false" && "${INDEXNOW_DELIVERY_ALLOW_WRITE:-}" == "false" ]] || fail indexnow_delivery
[[ "${FEATURE_NOVEL_CATALOG_SYNC:-}" == "false" && "${NOVEL_CATALOG_SYNC_ALLOW_WRITE:-}" == "false" ]] || fail catalog_write
[[ "${FEATURE_PROMO_LINK_CLAIM:-}" == "false" && "${PROMO_LINK_CLAIM_ALLOW_WRITE:-}" == "false" ]] || fail promo_write
[[ "${FEATURE_NOVEL_TAG_AUTO:-}" == "false" && "${AUTO_WRITE_AUTHORIZED:-}" == "NO" ]] || fail auto_tagging
[[ "${ARTICLE_BLOG_ALLOW_WRITE:-}" == "false" && "${ARTICLE_NOVEL_REBIND_ALLOW_WRITE:-}" == "false" ]] || fail article_writes
[[ "${GIT_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || fail git_commit
[[ -n "${CPS_NOVEL_APP_IMAGE:-}" ]] || fail app_image_unset
[[ -z "${EXPECTED_RELEASE_COMMIT:-}" || "$GIT_COMMIT" == "$EXPECTED_RELEASE_COMMIT" ]] || fail release_commit_mismatch
[[ -z "${EXPECTED_RELEASE_IMAGE:-}" || "$CPS_NOVEL_APP_IMAGE" == "$EXPECTED_RELEASE_IMAGE" ]] || fail release_image_mismatch

# 🔴 这里原本只检查 `CPS_NOVEL_APP_IMAGE =~ @sha256:`，那是 **registry manifest
# digest** 的形状。归档运输下 `docker load` 进来的镜像没有 RepoDigest，Compose
# 也无法用 `name@sha256:` 解析本地镜像——沿用那条正则等于把归档工件全部判死；
# 而把 config digest 拼成 `repo@sha256:` 去糊弄它，是在伪造一个任何 registry 上
# 都不存在的引用，只会让校验"看起来通过"。
#
# 改为对**本地镜像实体**做三项核对：tag 解析出的 ID == manifest 的 config digest、
# revision 标签 == approved commit、平台 == 期望平台。缺镜像直接失败，
# 绝不让后面的 compose 去 pull 或就地 build。
if [[ -n "${EXPECTED_RELEASE_IMAGE_DIGEST:-}" ]]; then
  preprod_assert_local_image \
    "$CPS_NOVEL_APP_IMAGE" \
    "$EXPECTED_RELEASE_IMAGE_DIGEST" \
    "$GIT_COMMIT" \
    "${EXPECTED_RELEASE_PLATFORM:-}" || fail app_image_identity
fi

drain="${WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS:-30000}"
grace="${WORKER_STOP_GRACE_PERIOD:-45s}"
[[ "$drain" =~ ^[1-9][0-9]*$ && "$grace" =~ ^[1-9][0-9]*s$ ]] || fail worker_shutdown_format
grace_ms=$((10#${grace%s} * 1000))
(( grace_ms >= drain + 10000 )) || fail worker_shutdown_margin

"$root/scripts/preproduction/secrets-preflight.sh"
preprod_compose config --quiet || fail compose_config

# 🔴 渲染后的 Compose 配置里，三个应用服务实际拿到的 image 必须就是 manifest 那个。
# 前面校验的是 shell 变量，这里校验的是**插值之后真正交给 Compose 的值**——
# 中间任何一层（env-file、override 文件、默认值）把它换掉，都在这一步暴露。
if [[ -n "${EXPECTED_RELEASE_IMAGE:-}" ]]; then
  rendered="$(preprod_compose config --format json)" || fail compose_config_render
  node -e '
    const cfg = JSON.parse(process.argv[1]);
    const want = process.argv[2];
    for (const name of ["web", "worker", "scheduler"]) {
      const svc = cfg.services?.[name];
      if (!svc) { console.log("missing:" + name); process.exit(1); }
      if (svc.image !== want) { console.log(name + ":" + svc.image); process.exit(1); }
    }
  ' "$rendered" "$EXPECTED_RELEASE_IMAGE" || fail compose_image_mismatch
fi
echo "PREPROD_PREFLIGHT=PASS"
