# P1-08B Backend Implementation Report

## Result

`P1_08B_WEB_SECRET_INGRESS_READY_FOR_REVIEW`。Auth 生产持久化、账户后端、同步 Web
add/replace、Credential validate/supersede Worker 和查询链均已实现。

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
- Web encrypt-only / Worker decrypt-capable AES-256-GCM versioned envelope（UUID AAD）、独立
  fingerprint HMAC key、本地 JWT exp validation、fenced validate/supersede protected writes、
  redacted persisted result。Web 可 INSERT 新密文但不能 SELECT 已持久化密文。
- Production handler registry 只登记 `credential.validate.v1` 和 `credential.supersede.v1`；
  Scheduler 不导入 registry/crypto，production schedules 仍为空。
- Owner 批准同步 add/replace：malformed 零写入，expired 可保存，active 使用 insert-before-delete
  fingerprint reservation；mutationRequestId 重放不重复 Credential/change log/audit，且不创建任务。

## Explicitly not implemented

- 真实上游网络校验；P1 只做本地 JWT 结构/exp 检查，不声明验签。
- `src/app/**` wiring、Admin UI、`src/contracts/**` DTO。
- Admin mutation 持久限流表或内存限流器；rate-limit port 为可选扩展，login-attempt 表不复用。

## Verification evidence

- PostgreSQL `16.14 (Debian 16.14-1.pgdg13+1)` disposable instance。
- 空库部署三条 Migration、重复 deploy、migration→schema 与 live DB→schema 双向 diff：PASS。
- live/static dictionary：43 models、920/920 active records、0 drift；catalog 43 tables、187
  constraints、183 indexes、2 triggers。
- P1-06 role regression：6/6；P1-07 runtime regression：16/16。
- P1-08B Auth PostgreSQL：8/8；Credential Web ingress + Worker PostgreSQL：15/15。
- 后端静态/单元：139/139；全量无数据库环境测试：150 passed / 50 PostgreSQL cases
  skipped（后者已由 disposable PostgreSQL 脚本独立执行）。
- disposable container、volume 和临时 credential/key directory：清理确认 `yes`。

最终门禁：build、typecheck、lint、`npm test`、backend、integration、live/static dictionary
drift 均 PASS；P1-06 6/6 与 P1-07 16/16 回归 PASS。add/replace availability 已从 Owner
gate 切换为 `supported`，成功响应为脱敏 metadata；validate/supersede queued result 不变。

## Security notes

GenericTask payload 仅含 account/credential/actor/request/operation 非敏感标识，同步 add/replace
不创建 GenericTask。Web 只在请求内持有新 JWT 并导入 encrypt-only 模块；无 persisted-secret
SELECT/decrypt 入口。完整 fingerprint 和密文只存在受限数据库列，UI/结果只使用 prefix。
Scheduler 无 Credential key。CPS 保持只读。

## Frontend contract review required fix

Claude review 的唯一 REQUIRED_FIX 已收口：`getCredentialTaskResult` 现在显式读取持久化的
`GenericTaskItem.error`，但服务读模型只对白名单稳定 code 返回 `{ code }`；message、stack、
cause、数据库异常、payload 和任意未知 code 均不会进入 `CredentialTaskStatusView` 输入。
`account_inactive`、`credential_missing`、`credential_ambiguous`、
`credential_validation_failed` 可由 contracts projection 映射为 `failureCode`；成功 result 路径不变。

## Secret Ingress idempotency binding review fix

Claude 复核的唯一 REQUIRED_FIX 已收口。同步 add/replace 现在以
`requestId + action + actorId + channelAccountId + fingerprintPrefix` 绑定一次已提交请求；事务前
预检、事务内重查，以及 PostgreSQL unique/serialization 冲突恢复均调用同一个比较函数。

五项全部一致时返回首次脱敏 metadata，且不重复 Credential、supersede、change log 或 audit。
任一项错配则 fail closed：`status=409`、`code=admin_mutation_request_id_invalid`、
`details.reason=idempotency_conflict`，零新增写入且不返回首次 metadata。审计仅保存 prefix，未新增
JWT、密文、完整 fingerprint 或原始 payload。双独立 Web 数据库连接已验证相同并发重试合并、
并发 payload mismatch 一成功一明确冲突；本修复未修改 Schema、Migration 或角色权限。
