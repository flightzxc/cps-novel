# P1-08A · Auth Foundation Report

## Result

`AUTH_CORE=IMPLEMENTED`

`PRODUCTION_PERSISTENCE=DEFERRED_PENDING_APPROVAL`

`CREDENTIAL_EXECUTION=NOT_IMPLEMENTED`

`APP_WIRING=NOT_IMPLEMENTED_OUT_OF_SCOPE`

## Delivered

- 五个存储端口与显式 `TEST_ONLY / NOT_PRODUCTION_PERSISTENCE` 内存适配器。
- Session token hash、2h idle、24h absolute、15min touch、revoke/status/sessionVersion fail-closed。
- TOTP、AES-256-GCM TOTP secret、scrypt 恢复码、5min/5-attempt challenge、5次/15min 登录失败锁定。
- 四项 capability；promo/revenue 默认 disabled；四项均要求 Session 已完成 2FA。
- 14 个 Admin page roots、空 API/Action registry、未登记 404、Route/Action guards、service mutation 二次授权。
- Same-origin、UUID mutation request id、安全 cookie 和 rate-limit port。
- Credential metadata/enqueue/redacted-result 纯契约；Web/Scheduler 无 Credential 执行或解密入口。

## Access Semantics

| 状态 | HTTP | code |
| --- | ---: | --- |
| token 缺失 | 401 | `jwt_missing` |
| token/session/identity 无效 | 401 | `jwt_invalid` |
| idle/absolute 过期 | 401 | `jwt_expired` + reason |
| capability / 2FA / Origin / request id | 403 | 对应统一安全 code |
| 未登记 page/API/action | 404 | `admin_route_not_registered` / `admin_action_not_registered` |
| rate limit | 429 | `admin_rate_limited` |

## Validation Snapshot

- branch initially created from `d7287729bd02b4f9957485aec6be96118efae864`, then rebased to P1-07R main `36c9ca6e8b39ec3041a845bb55d246412ac0ea79`: PASS
- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: PASS — 87 passed / 30 PostgreSQL integration tests skipped by existing environment gates
- `npm run test:backend`: PASS — 77 passed，含 24 个 P1-08A Auth tests
- `npm run test:integration`: PASS — 9 Auth tests passed / 30 PostgreSQL tests skipped
- forbidden-directory diff：PASS；package/lock、Prisma、App、Components、Contracts、Worker、Scheduler、Infra 零改动
- CPS before/after：clean，HEAD 均为 `d77c3b968285698529cf97c7f0f97b286d7a2a9c`

## Deferred Production Work

当前 schema 没有 Admin/Session/2FA 表，且本轮禁止修改 Prisma/package/contracts/App。生产 Store、跨表事务、cookie Handler 和全站 wiring 依赖变更申请审批。内存适配器不得用于部署。

## CPS parity Owner decision addendum（2026-08-04）

- Recovery Code 成功路径的 `AuthUnitOfWork` 已冻结为同一原子提交：消费 recovery code、
  消费 challenge、identity `sessionVersion + 1`、绑定 Session 更新到新版本并写入
  `twoFactorCompletedAt`。因此其他旧 Session 失效，当前绑定 Session 保持有效。
- F-2 错误码维持 `two_factor_failed | two_factor_expired | two_factor_locked`，未新增
  `two_factor_consumed`。
- `TEST_ONLY / NOT_PRODUCTION_PERSISTENCE` 内存 adapter 实现相同原子语义与逐阶段回滚注入；
  生产 PostgreSQL Auth Store 仍未实现。
- Credential 四态、queued result 与 CPS parity 治理属于纯契约/增量数据库约束；Credential
  Worker Handler、解密和真实 validation 仍为 `NOT_IMPLEMENTED`。

### Parity decision validation snapshot

- `npm run build` / `npm run typecheck` / `npm run lint`：PASS。
- backend：15 files / 92 tests PASS；Auth + Credential 专项：45/45 PASS。
- disposable PostgreSQL：`16.14 (Debian 16.14-1.pgdg13+1)`；空库应用 2 条 migration、
  重复部署、双向 schema diff、Credential 四态 CHECK、revoked 升级阻断与 10/10 数据库
  constraint tests 全部 PASS；容器与 volume 已清理。
- dictionary drift：37 models / 825 active records；数据库 catalog 37 tables / 159 constraints /
  163 indexes / 2 triggers，PASS。
