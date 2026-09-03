# 管理员认证恢复（RC-11，2026-09-04）

## 事故

X8 复用旧 PostgreSQL volume 后，遗留管理员 `x8-owner` 已在 2026-08-26 完成 2FA
绑定。Owner 既无验证器条目也无恢复码：密码通过验证后被 `/two-factor/challenge`
卡死，无法进入后台。

## 根因

`scripts/bootstrap-admin-identity.ts` 只支持"身份表为空时冷启动首个
`super_admin`"，无法用于既有身份的认证状态重置；此前没有任何"只重置认证状态、
不删账户、不绕审计"的入口，唯一可行路径是手工 `DELETE admin_identity`（被
CLAUDE.md 禁止，绕过审计）。

## 修法

- `scripts/reset-admin-auth-state.ts`：受审计、默认 dry-run 的 CLI，形态镜像
  `bootstrap-admin-identity.ts`。`--apply` 在一个事务里撤销该身份全部会话、清
  2FA 绑定字段、删挑战与恢复码、删该用户名（可选 `--ip`）的登录限流记录；
  `--deactivate` 只置 `status=disabled`，从不删行；生产（`NODE_ENV=production`
  且 2FA 强制）额外要求 `--break-glass`，写进审计；`--request-id` 重放去重。
- `scripts/ensure-local-admin-identities.ts`：仅 `ADMIN_LOCAL_IDENTITY_SEED=allow`
  （唯一放行值，只有 Level UAT 导出）时可执行，固定创建 `admin`/`admin2` 两个
  本地 `super_admin`，密码从 env 读取（从不进 argv/日志/仓库），幂等。
- 二者由 `scripts/x8-production-like.sh` 的 `admin-secret set` /
  `admin-seed` / `admin-reset` 驱动，跑在已构建镜像内、经 `--env-from-file`
  传密钥（避免 `ps` 暴露）。命令序列见 `OWNER_LOCAL_UAT_RUNBOOK_2026-09-03.md`
  §2.5。

## 生产首次 2FA 绑定流程（不受本轮改动）

生产**不得预绑 2FA**。首个 `super_admin` 走 `bootstrap-admin-identity.ts`
（密码只经 env，≥12 位）。登录→未绑定 2FA→转到 `/two-factor/setup`→页面展示 QR
（RC-11 新增 `createTotpQrCodeDataUrl`，otpauth URI 与手动密钥同时展示）→
Google Authenticator 扫码→输入验证码确认→展示一次性恢复码→此后每次登录才进
`/two-factor/challenge`。与 CPS 逐参数一致（`errorCorrectionLevel:"M",
margin:1, width:256`），未改 TOTP 算法/issuer/label。

## 风险

- **生产 `--break-glass` 重置的滥用面**：拥有生产 shell/CI 权限者可对任意已绑
  定 2FA 的身份强制重置认证状态，审计只记录"谁在何时做的"、不能阻止操作本
  身——权限收敛依赖生产访问控制本身，本轮未加操作审批层。
- **`ADMIN_LOCAL_IDENTITY_SEED` 若被误设到生产**：会打开 `hashAdminPassword`
  的 12 位下限豁免；`docker-compose.yml`/`.env.example` 均不声明该变量、
  Level 0/R 显式导出空字符串防守，但纵深防御只有一层精确匹配的 env 检查。
- **本地 secret 文件仍明文落盘**（`.tmp/x8-production-like/secrets/`，0600、
  未跟踪）：与仓库其余本地密钥同等风险等级，不做加密静态存储。
