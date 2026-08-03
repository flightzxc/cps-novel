# src/lib/credentials/

**Owner: Codex（独占写入）**

## 用途

渠道凭证的加密存储、指纹计算、单轨凭证管理（写入、轮换、失效）辅助逻辑。

## 当前实现状态

P1-08A 仅冻结 `contracts.ts` 的元数据、Worker 入队和脱敏结果契约。
Credential 数据库写入、解密、渠道校验、Worker Handler 和真实任务入队均未实现，留待 P1-08B。

## 特别纪律

🔴 **Web 进程不解密凭证，只有 Worker 能解密，Scheduler 无密钥。**

- 本目录提供的函数如涉及解密，只能在 Worker 运行时上下文中被调用；Web/Server Action 侧只能读取凭证**元数据**（指纹前缀、过期时间、状态），永不回显密文；
- Scheduler 容器不得注入 `CHANNEL_CREDENTIAL_ENCRYPTION_KEY` 类环境变量；
- 凭证写操作（六个凭证操作对齐 CPS `channel-accounts/actions.ts` 形态）全部需 `credential:manage` 能力位门控；
- 指纹冲突最终由数据库唯一约束兜底，不得仅靠应用层判断。
