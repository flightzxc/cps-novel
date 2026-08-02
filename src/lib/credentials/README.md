# src/lib/credentials/

**Owner: Codex（独占写入）**

## 用途

渠道凭证的加密存储、指纹计算、单轨凭证管理（写入、轮换、失效）辅助逻辑。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-08（Auth、Credential、后台 API 和能力位）** 填充。

## 特别纪律

🔴 **Web 进程不解密凭证，只有 Worker 能解密，Scheduler 无密钥。**

- 本目录提供的函数如涉及解密，只能在 Worker 运行时上下文中被调用；Web/Server Action 侧只能读取凭证**元数据**（指纹前缀、过期时间、状态），永不回显密文；
- Scheduler 容器不得注入 `CHANNEL_CREDENTIAL_ENCRYPTION_KEY` 类环境变量；
- 凭证写操作（六个凭证操作对齐 CPS `channel-accounts/actions.ts` 形态）全部需 `credential:manage` 能力位门控；
- 指纹冲突最终由数据库唯一约束兜底，不得仅靠应用层判断。
