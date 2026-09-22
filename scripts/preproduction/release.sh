#!/usr/bin/env bash
set -euo pipefail
set +x

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/preproduction/lib.sh
source "$root/scripts/preproduction/lib.sh"
preprod_load_env
shared="${PREPROD_SHARED_ROOT:-/opt/cps-novel/shared}"
state_file="$shared/release-state.json"
maintenance_dir="$shared/maintenance"

usage() {
  echo "usage: release.sh deploy --manifest FILE | rollback --manifest FILE | maintenance on|off" >&2
  exit 64
}

write_state() {
  local state="$1" commit="${2:-}" image="${3:-}"
  mkdir -p "$shared"
  local temporary="${state_file}.tmp.$$"
  node -e 'const fs=require("fs"); const [p,state,commit,image]=process.argv.slice(1); fs.writeFileSync(p,JSON.stringify({schemaVersion:1,state,commit,image,updatedAt:new Date().toISOString()},null,2)+"\n",{mode:0o600});' \
    "$temporary" "$state" "$commit" "$image"
  mv "$temporary" "$state_file"
}

maintenance_on() {
  mkdir -p "$maintenance_dir"
  install -m 0644 "$root/infra/preproduction/maintenance/__preprod_maintenance.html" \
    "$maintenance_dir/__preprod_maintenance.html"
  : >"$maintenance_dir/enabled"
  echo "MAINTENANCE=ON"
}

maintenance_off() {
  [[ "${PREPROD_RELEASE_VERIFIED:-}" == "YES" ]] || {
    echo "MAINTENANCE_OFF=REFUSED reason=release_not_verified"; return 65;
  }
  rm -f "$maintenance_dir/enabled"
  echo "MAINTENANCE=OFF"
}

# 🔴 deploy 与 rollback 共用这一个读取器。两条路径各自解析 manifest 是身份校验
# 漂移的经典来源：回滚那条往往被简化，于是"回滚到哪一版"没人真正校验过。
read_manifest() {
  local manifest="$1"
  preprod_read_release_manifest "$manifest" || exit $?
  manifest_path="$manifest"
  manifest_commit="$PREPROD_RELEASE_COMMIT"
  manifest_image="$PREPROD_RELEASE_IMAGE_REF"
  [[ "${APPROVED_GIT_COMMIT:-}" == "$manifest_commit" ]] || {
    echo "RELEASE=REFUSED reason=owner_approved_commit"; exit 65;
  }
  # 🔴 收到一份自洽的 archive+manifest，**不等于**它被批准发布。
  # APPROVED_GIT_COMMIT 是 Owner 的批准记录，必须由操作者在环境里显式给出，
  # 且与 manifest 内的 commit 一致；manifest 自己说自己被批准了不算数。
  export GIT_COMMIT="$manifest_commit" CPS_NOVEL_APP_IMAGE="$manifest_image"
  # 本地镜像实体核对：按字段能力选锚点（containerd 用 .Descriptor，经典用 .Id），
  # 外加平台与 revision。在停服务/迁移之前做，尽早失败。
  preprod_assert_local_image "$manifest_image" || {
    echo "RELEASE=REFUSED reason=app_image_identity"; exit 65;
  }
}

deploy() {
  local manifest="$1" failed=1
  read_manifest "$manifest"
  [[ "$(git -C "$root" rev-parse HEAD)" == "$manifest_commit" ]] || {
    echo "RELEASE=REFUSED reason=checkout_commit"; exit 65;
  }
  PREPROD_RELEASE_MANIFEST="$manifest_path" \
    "$root/scripts/preproduction/preflight.sh"
  write_state preflight_passed "$manifest_commit" "$manifest_image"
  maintenance_on
  write_state maintenance "$manifest_commit" "$manifest_image"
  # 🔴 目标机实测：`local failed=1` 的 EXIT trap 在 verify-release.sh 以非零
  # 退出触发 `set -euo pipefail` 隐式 exit 时，於 bash 5 下会在 `$failed` 已经
  # 脱离函数作用域之后才求值——"release.sh: line 1: failed: unbound variable"，
  # trap 本身在打印 FAILED 之前就先炸了。后果在同一次真实运行里两条都应验了：
  # "RELEASE=FAILED maintenance=ON" 没打印，write_state failed 也没跑，
  # release-state.json 只停在上一个成功状态，运维现场没有任何"部署失败"的
  # 记录。`bash -c 3.2` 巧合地不触发（本仓库开发机默认就是它），但目标机与
  # CI 跑的是更新的 bash，这条差异已经现场实测复现（见本 commit 的测试）。
  # 修法：用 `${failed:-1}` 代替裸 `$failed`——fail-closed，读不到就当失败，
  # 一个坏掉的 trap 永远不能悄悄冒充成功。
  trap 'if [[ "${failed:-1}" == "1" ]]; then write_state failed "$manifest_commit" "$manifest_image"; echo "RELEASE=FAILED maintenance=ON"; fi' EXIT

  preprod_compose stop scheduler
  write_state scheduler_stopped "$manifest_commit" "$manifest_image"
  preprod_compose stop worker
  write_state worker_stopped "$manifest_commit" "$manifest_image"
  preprod_compose stop web
  write_state web_stopped "$manifest_commit" "$manifest_image"

  [[ "${PREPROD_APPROVED_MIGRATION:-}" == "YES" ]] || {
    echo "RELEASE=REFUSED reason=migration_approval"; exit 65;
  }
  PREPROD_APPROVED_MIGRATION=YES "$root/scripts/preproduction/database.sh" migrate-approved
  write_state migrated "$manifest_commit" "$manifest_image"

  preprod_compose_app_up web
  # 🔴 启动之后再核一次**实际容器**用的镜像。预检核的是配置与本地镜像，
  # 容器可能是上一轮遗留的、也可能因为别的原因起到了另一个镜像上。
  preprod_assert_container_image web || {
    echo "RELEASE=REFUSED reason=runtime_image_mismatch"; exit 65;
  }
  # 🔴 目标机首次真实部署实测：`up -d` 只等依赖项健康，不等 web 自己的
  # healthcheck——容器 Started 不到一秒后面这行 verify-release.sh 就跑了，
  # 那时 /api/health 还是 502。显式等 web 变 healthy 再往下走。
  preprod_wait_for_service_health web || {
    echo "RELEASE=FAILED reason=health_wait_failed service=web"; exit 65;
  }
  write_state web_started "$manifest_commit" "$manifest_image"
  "$root/scripts/preproduction/verify-release.sh"
  write_state verified "$manifest_commit" "$manifest_image"

  preprod_compose_app_up worker
  preprod_compose_app_up scheduler
  preprod_assert_container_image worker scheduler || {
    echo "RELEASE=REFUSED reason=runtime_image_mismatch"; exit 65;
  }
  # 同上：worker/scheduler 同样必须等自己 healthy，不能只核完镜像身份就
  # 直接放行到 maintenance_off。
  preprod_wait_for_service_health worker scheduler || {
    echo "RELEASE=FAILED reason=health_wait_failed service=worker,scheduler"; exit 65;
  }
  PREPROD_RELEASE_VERIFIED=YES maintenance_off
  # 🔴 MAJOR-1 fix: the full verify-release.sh call above (line ~98) always
  # runs while maintenance is still on, so its state-aware anonymous matrix
  # always takes the maintenance branch there -- the 401 expectations for
  # anonymous /, /robots.txt, /sitemap.xml, and admin /login never actually
  # exercise the real, live-traffic state in that call (see
  # verify-release.sh's own comment on --anonymous-only). This second, cheap
  # call is what proves anonymous callers really get 401, not leaked
  # business content, now that maintenance is genuinely off. A failure here
  # means the business surface is NOT correctly gated at this exact moment
  # -- re-close the gate immediately rather than leaving it off while the
  # generic EXIT trap below reports the failure.
  #
  # N3 fix: --expect-live makes this call self-checking -- it fails outright
  # if the maintenance marker is somehow still present (maintenance_off's
  # `rm -f` above failing silently, a stale mount, ...), instead of silently
  # taking the matrix's 503 branch and passing without ever exercising 401.
  "$root/scripts/preproduction/verify-release.sh" --anonymous-only --expect-live || {
    maintenance_on
    echo "RELEASE=FAILED reason=anonymous_reverify_failed"; exit 65;
  }
  ln -sfn "/opt/cps-novel/releases/$manifest_commit" /opt/cps-novel/current
  write_state ready "$manifest_commit" "$manifest_image"
  failed=0
  trap - EXIT
  echo "RELEASE=PASS"
}

rollback() {
  local manifest="$1" failed=1
  [[ "${SCHEMA_COMPATIBLE_WITH_PREVIOUS:-}" == "YES" ]] || {
    echo "ROLLBACK=REFUSED reason=schema_compatibility_not_approved"; exit 65;
  }
  read_manifest "$manifest"
  [[ "$(git -C "$root" rev-parse HEAD)" == "$manifest_commit" ]] || {
    echo "ROLLBACK=REFUSED reason=invoke_from_previous_release"; exit 65;
  }
  # 🔴 与 deploy 同一套预检。回滚常被当成"退回到已知可用的东西"而省掉校验，
  # 但回滚同样是一次把某个镜像放上线的动作，身份校验不能比 deploy 弱。
  PREPROD_RELEASE_MANIFEST="$manifest_path" \
    "$root/scripts/preproduction/preflight.sh"
  maintenance_on
  # 🔴 与 deploy() 同一个 bug、同一个修法——见上面那条注释。fail-closed：
  # `${failed:-1}` 读不到就当失败。
  trap 'if [[ "${failed:-1}" == "1" ]]; then write_state rollback_failed "$manifest_commit" "$manifest_image"; echo "ROLLBACK=FAILED maintenance=ON"; fi' EXIT
  preprod_compose stop scheduler
  preprod_compose stop worker
  preprod_compose stop web
  # Application rollback only: no down migration and no data/volume restore.
  # 🔴 数据与密钥身份不变：这里不碰 postgres 服务、不动 cps_novel_postgres_data
  # 卷、不恢复任何备份。回滚的是应用镜像，不是数据库 -- but its GRANTS (role
  # privileges, not data) ARE replayed below: see MAJOR-2 fix.
  #
  # 🔴 MAJOR-2 fix: rollback() previously never touched grants at all, so it
  # left the (old, restored) app running against whatever privileges the
  # release being rolled back FROM last committed via `database.sh
  # migrate-approved` -- which may have tightened a grant the old code still
  # depends on (precedent: 7141177 removed legacy catalog scan grants;
  # a943fda scoped carousel grants). $root here is THIS invocation's own
  # checkout, and the runbook requires rollback to be invoked from the
  # previous release's immutable directory (so its Compose/scripts match the
  # app being restored) -- so $root/infra/postgres/grants.sql is naturally
  # that previous release's own, already-approved grants file. Replaying it
  # is "restore the running release's own grants", not a new decision made
  # here. Runs BEFORE the app comes back up, using the identical shape
  # database.sh's migrate-approved case uses: -U postgres (not
  # migration_owner -- grants.sql's blanket `REVOKE ALL ... FROM PUBLIC`
  # also touches postgres-owned extension functions, which migration_owner
  # does not own), --single-transaction (the REVOKE-then-GRANT body is
  # all-or-nothing; a mid-file failure must not strip every runtime role to
  # zero privileges), -v ON_ERROR_STOP=1. On failure, --single-transaction
  # means Postgres has already rolled the attempt back atomically -- do not
  # replay a second time, just refuse.
  if ! preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
    -U postgres -d cps_novel <"$root/infra/postgres/grants.sql" >/dev/null; then
    echo "ROLLBACK=REFUSED reason=grants_replay_failed"; exit 65;
  fi
  preprod_compose_app_up web
  preprod_assert_container_image web || {
    echo "ROLLBACK=REFUSED reason=runtime_image_mismatch"; exit 65;
  }
  # 🔴 与 deploy() 同一个坑、同一个修法：up -d 不等 web 自己的 healthcheck，
  # 回滚同样必须等它真的 healthy 再调用 verify-release.sh。
  preprod_wait_for_service_health web || {
    echo "ROLLBACK=FAILED reason=health_wait_failed service=web"; exit 65;
  }
  "$root/scripts/preproduction/verify-release.sh"
  preprod_compose_app_up worker
  preprod_compose_app_up scheduler
  preprod_assert_container_image worker scheduler || {
    echo "ROLLBACK=REFUSED reason=runtime_image_mismatch"; exit 65;
  }
  preprod_wait_for_service_health worker scheduler || {
    echo "ROLLBACK=FAILED reason=health_wait_failed service=worker,scheduler"; exit 65;
  }
  PREPROD_RELEASE_VERIFIED=YES maintenance_off
  # 🔴 MAJOR-1 fix: same reasoning as deploy() above -- the full
  # verify-release.sh call three lines up always runs while maintenance is
  # still on, so this cheap, anonymous-only re-check after maintenance_off
  # is what actually proves anonymous callers get 401 now that the rolled-
  # back release is really live. Re-close the gate on failure rather than
  # leaving it off.
  #
  # N3 fix: --expect-live, same reasoning as deploy() above -- fails outright
  # if the marker is still present instead of passing vacuously.
  "$root/scripts/preproduction/verify-release.sh" --anonymous-only --expect-live || {
    maintenance_on
    echo "ROLLBACK=FAILED reason=anonymous_reverify_failed"; exit 65;
  }
  write_state rolled_back "$manifest_commit" "$manifest_image"
  failed=0
  trap - EXIT
  echo "ROLLBACK=PASS"
}

case "${1:-}" in
  deploy) [[ "${2:-}" == "--manifest" && -n "${3:-}" ]] || usage; deploy "$3" ;;
  rollback) [[ "${2:-}" == "--manifest" && -n "${3:-}" ]] || usage; rollback "$3" ;;
  maintenance)
    case "${2:-}" in
      on) maintenance_on ;;
      off) maintenance_off ;;
      *) usage ;;
    esac ;;
  *) usage ;;
esac
