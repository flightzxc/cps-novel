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
# 🔴 目录同步（2026-09-22 Owner 批准）与推广领取（2026-09-23 Owner 批准）写闸
# 不再要求恒为 "false"：判定收敛进 lib.sh 的 preprod_assert_write_gates()
# （封闭枚举 + PREPROD_APPROVED_OPEN_WRITE_GATES 显式登记制，见该函数上方的
# 详细说明与 docs/adr/ADR-PREPROD-APPROVED-OPEN-WRITE-GATES.md）。这里只把它
# 判出的 reason 转交给 fail()；取证行留到最终 PASS 之前打印。
write_gates_evidence="$(preprod_assert_write_gates)" || fail "$write_gates_evidence"
# 阶段2 第5步（`docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`）：领推广链接
# 生命周期的七项配置必须与 `resolvePromoClaimLifecycleConfig`
# （`src/lib/tasks/promo-claim-lifecycle.ts`）逐条一致地校验通过，否则
# fail closed 在这里——不要等到部署完之后才在 scheduler 的报错日志里发现
# 一处配置笔误。见 lib.sh 里 `preprod_assert_promo_claim_lifecycle_config()`
# 上方的详细说明。
lifecycle_config_evidence="$(preprod_assert_promo_claim_lifecycle_config)" || fail "$lifecycle_config_evidence"
# 阶段 4-A（设计《领推广按接口限速与预读集合化 · 阶段4-5》§5.6）：MoboReader
# 上游按接口限速的六项配置必须与 `resolveMoboreaderPerEndpointRateGateConfig`
# （`src/lib/adapters/moboreader-rate-limit.ts`）逐条一致地校验通过——同一个
# "别等部署完才在日志里发现笔误"的理由，见 lib.sh 里
# `preprod_assert_moboreader_rate_gate_config()` 上方的详细说明。
rate_gate_config_evidence="$(preprod_assert_moboreader_rate_gate_config)" || fail "$rate_gate_config_evidence"
[[ "${FEATURE_NOVEL_TAG_AUTO:-}" == "false" && "${AUTO_WRITE_AUTHORIZED:-}" == "NO" ]] || fail auto_tagging
[[ "${ARTICLE_BLOG_ALLOW_WRITE:-}" == "false" && "${ARTICLE_NOVEL_REBIND_ALLOW_WRITE:-}" == "false" ]] || fail article_writes
[[ "${GIT_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || fail git_commit
[[ -n "${CPS_NOVEL_APP_IMAGE:-}" ]] || fail app_image_unset
# 🔴 preflight **自己重读 manifest**，不接受上游用环境变量传进来的 digest。
# 上游传值意味着 preflight 校验的是"上游说的身份"，而不是"批准记录里的身份"——
# 一旦上游哪天算错了（上一轮就是），preflight 会拿着同一个错值一路绿灯。
# 同时这让 preflight 可以独立运行，测试不必先跑 release.sh。
if [[ -n "${PREPROD_RELEASE_MANIFEST:-}" ]]; then
  preprod_read_release_manifest "$PREPROD_RELEASE_MANIFEST" || fail release_manifest
  [[ "$GIT_COMMIT" == "$PREPROD_RELEASE_COMMIT" ]] || fail release_commit_mismatch
  [[ "$CPS_NOVEL_APP_IMAGE" == "$PREPROD_RELEASE_IMAGE_REF" ]] || fail release_image_mismatch
fi

# 🔴 对**本地镜像实体**核身份。锚点由字段能力决定，不由 Docker 版本号决定：
#   containerd image store → .Descriptor 与 manifest 的 target descriptor 比
#   经典 graphdriver       → .Id 与 config digest 比
# 外加平台与 revision 一致性。判定逻辑在 image-identity.mjs，与构建器、
# 归档校验器、deploy/rollback 同一份实现。
#
# 历史注记：这里曾经检查 `CPS_NOVEL_APP_IMAGE =~ @sha256:`（registry manifest
# digest 的形状）。归档运输下 `docker load` 进来的镜像在经典后端没有 RepoDigest，
# Compose 也无法用 `name@sha256:` 解析本地镜像——那条正则会把归档工件全部判死。
# 缺镜像直接失败，绝不让后面的 compose 去 pull 或就地 build。
if [[ -n "${PREPROD_RELEASE_TARGET_DIGEST:-}" ]]; then
  preprod_assert_local_image "$CPS_NOVEL_APP_IMAGE" || fail app_image_identity
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
if [[ -n "${PREPROD_RELEASE_IMAGE_REF:-}" ]]; then
  rendered="$(preprod_compose config --format json)" || fail compose_config_render
  node -e '
    const cfg = JSON.parse(process.argv[1]);
    const want = process.argv[2];
    for (const name of ["web", "worker", "scheduler"]) {
      const svc = cfg.services?.[name];
      if (!svc) { console.log("missing:" + name); process.exit(1); }
      if (svc.image !== want) { console.log(name + ":" + svc.image); process.exit(1); }
    }
  ' "$rendered" "$PREPROD_RELEASE_IMAGE_REF" || fail compose_image_mismatch
fi
echo "$write_gates_evidence"
echo "$lifecycle_config_evidence"
echo "$rate_gate_config_evidence"
echo "PREPROD_PREFLIGHT=PASS"
