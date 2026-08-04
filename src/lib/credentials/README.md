# src/lib/credentials/

**Owner: Codex（独占写入）**

## 用途

渠道凭证的加密存储、指纹计算、单轨凭证管理（写入、轮换、失效）辅助逻辑。

## 当前实现状态

P1-08B 支持同步 Web add/replace：明文仅在请求内存中短暂存在，Web 使用版本化
Credential key 加密后写入正式密文列。异步 validate/supersede 仍由 Worker 执行。

## 特别纪律

🔴 **Web 只加密新提交的凭证；只有 Worker 能读取并解密已持久化凭证，Scheduler 无密钥。**

- `web-ingress-crypto.ts` 只导出新 secret 的加密/指纹入口，不导出解密；Web/Server Action 只能读取凭证**元数据**（指纹前缀、过期时间、状态），永不读取或回显已保存密文；
- Scheduler 容器不得注入 `CHANNEL_CREDENTIAL_ENCRYPTION_KEY` 类环境变量；
- add/replace 同步完成且不创建 GenericTask；任何 GenericTask JSON 仍禁止 secret/ciphertext/fingerprint；
- 凭证写操作（六个凭证操作对齐 CPS `channel-accounts/actions.ts` 形态）全部需 `credential:manage` 能力位门控；
- 指纹冲突最终由数据库唯一约束兜底，不得仅靠应用层判断。
