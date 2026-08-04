# P1-08B Backend Implementation Report

## Result

`P1_08B_SECRET_INGRESS_GATE_REQUIRED`。Auth 生产持久化、账户后端、Credential validate/
supersede Worker 和查询链已实现；生产 create/replace secret intake 因未冻结协议保持默认拒绝。

## Implemented

- 增量 Migration `20260804140000_p1_08b_admin_auth_persistence`：六张 Auth 表、约束/索引、
  challenge→Session 复合 FK 和 Admin mutation audit 幂等索引。
- 六个生产 adapter：Identity、Session、TwoFactor、RecoveryCode、LoginAttempt、AuthUnitOfWork；
  password/session create/revoke 已接入内部服务。
- Auth 原子性：setup 三阶段、TOTP 两阶段、recovery 五阶段；故障注入逐阶段证明回滚。
- 登录失败 PostgreSQL atomic UPSERT；并发计数不丢失，成功仅清 username bucket。
- `scheduler_app` 与最小 GRANT：Web 可完成 Auth 但禁读 Credential 密文；Worker 可读 Credential
  执行列但禁读 Admin hash；Scheduler/Analyst 禁读 secret；所有 runtime role 禁止 DDL。
- Account create/disable/enable；Credential metadata、validate/supersede enqueue 和 task query；
  request-id 幂等、active task 去重、operation audit 与 fresh service re-authorization。
- Worker-only AES-256-GCM versioned envelope（UUID AAD）、独立 fingerprint HMAC key、本地 JWT
  exp validation、fenced validate/supersede protected writes、redacted persisted result。
- Production handler registry 只登记 `credential.validate.v1` 和 `credential.supersede.v1`；
  Scheduler 不导入 registry/crypto，production schedules 仍为空。

## Explicitly not implemented

- Secret ingress、生产 add/replace Route/Action/handler/adapter。
- 真实上游网络校验；P1 只做本地 JWT 结构/exp 检查，不声明验签。
- `src/app/**` wiring、Admin UI、`src/contracts/**` DTO。
- Admin mutation 持久限流表或内存限流器；rate-limit port 为可选扩展，login-attempt 表不复用。

## Verification evidence

- PostgreSQL `16.14 (Debian 16.14-1.pgdg13+1)` disposable instance。
- 空库部署三条 Migration、重复 deploy、migration→schema 与 live DB→schema 双向 diff：PASS。
- live/static dictionary：43 models、920/920 active records、0 drift；catalog 43 tables、187
  constraints、183 indexes、2 triggers。
- P1-06 role regression：6/6；P1-07 runtime regression：16/16。
- P1-08B Auth PostgreSQL：8/8；Credential Worker PostgreSQL：6/6。
- 后端静态/单元：96/96（最终全套命令结果见交付终报）。
- disposable container、volume 和临时 credential/key directory：清理确认 `yes`。

## Security notes

GenericTask payload 仅含 account/credential/actor/request/operation 非敏感标识。Web/Scheduler
源码扫描无 Credential decrypt/key import。完整 fingerprint 和密文只存在 Worker/数据库内部，
UI/结果只使用 prefix。CPS 保持只读。

## Frontend contract review required fix

Claude review 的唯一 REQUIRED_FIX 已收口：`getCredentialTaskResult` 现在显式读取持久化的
`GenericTaskItem.error`，但服务读模型只对白名单稳定 code 返回 `{ code }`；message、stack、
cause、数据库异常、payload 和任意未知 code 均不会进入 `CredentialTaskStatusView` 输入。
`account_inactive`、`credential_missing`、`credential_ambiguous`、
`credential_validation_failed` 可由 contracts projection 映射为 `failureCode`；成功 result 路径不变。
