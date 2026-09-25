# 追加预生产管理员 admin2

本手册是下一正式版本发布后的运维交接。编码与自测阶段不连接预生产、不创建账号、不改目标机 env。只走路径 A：先等当前正式推广码领取长任务全部结束，再按正式发版流程发布新版本。不得把新脚本挂载到现役镜像，也不得在该任务运行期间更改版本、镜像或预生产运行路径。

## 预检

1. 在目标机核实 `PREPROD_ADMIN_USERNAME=admin`、`PREPROD_ADMIN_PASSWORD_FILE=/opt/cps-novel/shared/secrets/admin-smoke-password`、2FA 强制开启，以及 `PROMO_CLAIM_ROLES=`。`PROMO_CLAIM_USER_IDS` **应有一个 UUID 且仅对应 admin**；原方案第 8.1 节“没有任何 `*_USER_IDS`”不适用于当前预生产。若其他账号白名单能力位已变化，先核清 admin/admin2 权限差异。
2. 用现有 `scripts/preproduction/verify-admin-auth.ts` 和同一只读密码文件确认 admin 密码有效。新命令也会在预演和正式执行时验证该密码与 admin 的现有散列一致；验证失败时停止，不复制散列、不改用其他密码来源。
3. 只查非敏感数据，记录 admin 的 identity ID、`session_version`、2FA 状态和密文摘要、未用恢复码数、活跃会话数；记录当前领取任务已全部结束，以及 web/worker/scheduler 容器 ID、创建时间和镜像。

```sql
SELECT username, id, role, status, session_version
FROM admin_identity WHERE username IN ('admin', 'admin2') ORDER BY username;

SELECT i.username, i.status, i.session_version,
       f.enabled, f.confirmed_at, f.key_version, f.recovery_codes_rotated_at,
       encode(sha256(convert_to(f.encrypted_secret,'UTF8')),'hex') AS secret_digest,
       (SELECT count(*) FROM admin_recovery_code r WHERE r.identity_id=i.id AND r.used_at IS NULL) AS unused_recovery_codes,
       (SELECT count(*) FROM admin_session s WHERE s.identity_id=i.id AND s.revoked_at IS NULL) AS live_sessions
FROM admin_identity i LEFT JOIN admin_two_factor f ON f.identity_id=i.id
ORDER BY i.username;
```

保存第二条查询的 admin 行作为建号前快照；建号及 2FA 绑定后重跑，逐字段对比 admin 行，确认其 2FA 密文摘要、恢复码、会话及版本未变。仅记录摘要，不输出密文。

## 建号：预演、执行、回放

在**新版本发布目录**执行，使用对应发布清单。`admin-smoke-password` 只以只读文件挂进一次性容器，密码不进入 argv、审计、日志或输出。

```bash
cd /opt/cps-novel/releases/<new-release-directory>
source scripts/preproduction/lib.sh
preprod_read_release_manifest /absolute/path/release-manifest.json
export CPS_NOVEL_APP_IMAGE="$PREPROD_RELEASE_IMAGE_REF" GIT_COMMIT="$PREPROD_RELEASE_COMMIT"
preprod_load_env

# 默认预演，必须得到 outcome=eligible、wrote=false
preprod_compose_app_run \
  -e DATABASE_URL="$P1_12_WEB_DATABASE_URL" \
  -e ADD_ADMIN_OPERATOR=owner \
  -e ADD_ADMIN_PASSWORD_FILE=/run/preprod-admin/password \
  -v /opt/cps-novel/shared/secrets/admin-smoke-password:/run/preprod-admin/password:ro \
  web tsx scripts/add-admin-identity.ts \
    --username admin2 --same-password-as admin \
    --reason 'Owner approved secondary preproduction admin account with independent 2FA and equivalent admin permissions' \
    --request-id preprod-2026-09-25-add-admin2

# 正式执行：上条命令仅在末尾加 --apply。
# 期望 outcome=created、wrote=true，并记录输出的 identityId 和 auditId。
# 随后原样重复 --apply，期望 outcome=replayed、wrote=false。
```

建号输出的 `identityId` 是 admin2 的 ID。用上面的 SQL 再查一次，确认 `username='admin2'` 对应 ID 与输出一致，且两行均为 `super_admin`、`active`。审计核对 `action='admin_identity.add'`、`actor_id='owner'`、固定 reason/request-id、`entity_id=<admin2 ID>`；不得查询或打印密码散列。建号后 admin2 应无 2FA、恢复码、会话记录；admin 原有安全状态与会话不变。Owner 首次登录 admin2 后按现有流程绑定独立 TOTP，并离线保存新生成的 10 个恢复码。

`scripts/bootstrap-admin-identity.ts` 只接受空身份表。建好 admin2 后再次运行该冷启动命令会永久被拒，这是预期行为；不能为使其回放成功而放宽空表校验。

完成 admin2 的独立 2FA 绑定后，分别验证两个账号的密码与 2FA 状态。每次应输出 `ADMIN_AUTH_VERIFY=PASS`：

```bash
for admin_username in admin2 admin; do
  preprod_compose_app_run \
    -e DATABASE_URL="$P1_12_WEB_DATABASE_URL" \
    -e PREPROD_ADMIN_USERNAME="$admin_username" \
    -e PREPROD_ADMIN_PASSWORD_FILE=/run/preprod-admin/password \
    -e TOTP_ENCRYPTION_KEY_FILE=/run/secrets/totp_encryption_key \
    -v /opt/cps-novel/shared/secrets/admin-smoke-password:/run/preprod-admin/password:ro \
    web tsx scripts/preproduction/verify-admin-auth.ts
done
```

## 完成 `promo:claim` 权限

建号后才有 admin2 的 identity ID。目标机 `preprod.env` 白名单的预期格式如下，实际 UUID 只能取自该环境的数据库：

```text
修改前：PROMO_CLAIM_USER_IDS=<admin-uuid>
修改后：PROMO_CLAIM_USER_IDS=<admin-uuid>,<admin2-uuid>
保持：PROMO_CLAIM_ROLES=
```

仅将 admin2 UUID 追加到原值，不能替换 admin UUID；不得改为 `PROMO_CLAIM_ROLES=super_admin`。在下一正式版已发布、当前长任务已结束、白名单改动获准并完成后，用新 shell 加载同一发布目录及 manifest，仅重建 web：

```bash
cd /opt/cps-novel/releases/<new-release-directory>
source scripts/preproduction/lib.sh
preprod_read_release_manifest /absolute/path/release-manifest.json
export CPS_NOVEL_APP_IMAGE="$PREPROD_RELEASE_IMAGE_REF" GIT_COMMIT="$PREPROD_RELEASE_COMMIT"
preprod_load_env
export PREPROD_RELEASE_MANIFEST=/absolute/path/release-manifest.json
scripts/preproduction/preflight.sh

for service in worker scheduler; do
  cid="$(preprod_compose ps -q "$service")"
  docker inspect "$cid" --format '{{.Name}} {{.Id}} {{.Created}} {{.Image}}'
done
preprod_compose_app_up web
preprod_assert_container_image web
preprod_wait_for_service_health web
for service in worker scheduler; do
  cid="$(preprod_compose ps -q "$service")"
  docker inspect "$cid" --format '{{.Name}} {{.Id}} {{.Created}} {{.Image}}'
done
```

保存并逐字比较前后 worker/scheduler 两行的 ID、Created、Image；均相同才可证明没有重建。`PROMO_CLAIM_USER_IDS` 只在 `docker-compose.yml` 的 web 环境透传；`preprod_compose_app_up web` 内部使用 `up -d --no-deps`，不会请求重建 worker/scheduler。另核对 web 为新白名单配置、镜像身份通过、健康检查通过。

最后分别使用 admin 与 admin2 的独立浏览器会话完成 2FA，在 `/catalog-sync` 选择事先批准的窄范围、有效渠道账号，**顺序**提交两次互不冲突的 promo claim。**每一次实际提交都会调用上游 getcode，且不幂等；admin 和 admin2 的每一次提交均须 Owner 单独授权。**两次都要返回成功和各自 task ID；用各自 request-id 核对 `operation_audit` 中 `action='catalog_batch.queued'`、`after_snapshot.operation='promo_claim'`、`actor_id` 分别等于 admin/admin2 UUID，`entity_id` 对应各自 task ID。不要用界面按钮可见性代替实际提交验证。

```sql
SELECT a.request_id, a.actor_id, i.username, a.entity_id AS task_id, a.created_at
FROM operation_audit a
JOIN admin_identity i ON i.id::text = a.actor_id
WHERE a.action='catalog_batch.queued'
  AND a.after_snapshot->>'operation'='promo_claim'
  AND a.request_id IN ('<admin-request-id>', '<admin2-request-id>')
ORDER BY a.created_at;
```

## 回滚

需要停用 admin2 时，沿用 `scripts/reset-admin-auth-state.ts --username admin2 --deactivate` 的预演、`--apply --break-glass` 路径，使用迁移角色连接串并另取稳定 request-id。此操作撤销 admin2 会话、清除其 2FA/恢复码并留审计，不删除身份行，不碰 admin。回滚白名单时从 `PROMO_CLAIM_USER_IDS` 移除 admin2 UUID，并仍仅重建 web。
