# P1-08B Credential Secret Ingress Gate

```text
RESULT=P1_08B_SECRET_INGRESS_GATE_REQUIRED
PRODUCTION_CREATE_REPLACE=NOT_REGISTERED
```

## Gate finding

现有权威文档冻结了“浏览器提交新 secret、Web 无 Credential 对称主密钥、GenericTask 不含
明文/密文、Worker 唯一最终加密解密执行体”，但没有定义可执行的 Web→Worker secret ingress。
因此 P1-08B 不自行发明协议：账户操作、validate、supersede、metadata/task query 和 Auth
持久化继续实施；生产 add/replace intake、Route/Action 和 Worker handler 保持默认拒绝。

禁止中转：GenericTask JSON、operation audit、日志、普通数据库列、临时共享文件、环境变量、
URL/query/header 长期携带、Scheduler 转发，以及让 Web 持有 Credential 对称主密钥。

## Option 1 — Worker public-key sealed intake（推荐）

- Worker 管理私钥；Web 只获得带版本和用途约束的公钥。
- 浏览器明文仅在 Web 请求内存短暂存在；Web 用随机 AES-256-GCM 数据密钥封装 secret，再以
  RSA-OAEP-256（或 Owner 后续批准的等价 KEM）封装数据密钥。
- 专用 one-time intake 表只保存 sealed envelope、public-key version、AAD、`expires_at`、
  `attempt_count`、`consumed_at` 和不可逆审计标识；GenericTask 只携带 `intakeId`。
- Worker 在 fenced 领取后原子锁定/消费 intake，以私钥解封，再用正式 Credential key 与
  account/credential UUID AAD 加密入库。默认 TTL、最大尝试、清理周期和失败审计必须由 Owner
  冻结；消费后不可重放，私钥不进入 Web/Scheduler。

推荐理由：保留异步队列、at-least-once、崩溃恢复和数据库一次性消费语义，同时不要求 Web
持有 Credential 对称主密钥。批准前不新增 intake 表、公私钥配置或 replace handler。

## Option 2 — Internal Worker intake endpoint / IPC

- Web 将明文通过隔离网络上的 Worker intake endpoint/IPC 传输，Worker 内存接收并立即加密；
  不持久化明文。
- 必须有强服务身份（mTLS 或等价机制）、短 TTL nonce、request-id/replay 存储、请求体上限、
  网络 allowlist、审计脱敏和 Worker 同步可用性策略。
- GenericTask 仍只持有生成后的 credential/intake 标识；Scheduler 不参与。

该方案增加同步可用性和网络认证面，崩溃恢复语义弱于 sealed intake，故不是当前推荐。

## Owner decision required

Owner 必须选择协议、密钥托管/轮换、TTL、attempt 上限、清理和灾备语义。此前
`credential.replace.v1` 仅为 gated contract/test fixture，不得加入 production registry。
