# src/lib/credentials/

**Owner: Codex（独占写入）**

## 用途

渠道凭证的加密存储、指纹计算、单轨凭证管理（写入、轮换、失效）辅助逻辑。

## 当前实现状态

P1-08B 支持同步 Web add/replace：明文仅在请求内存中短暂存在，Web 使用
`CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION` 选择版本化 Credential key，加密后写入正式密文列。
异步 validate/supersede 仍由 Worker 执行。

## 特别纪律

🔴 **Web 只加密新提交的凭证；只有 Worker 能读取并解密已持久化凭证，Scheduler 无密钥。**

- `web-ingress-crypto.ts` 只导出新 secret 的加密/指纹入口，不导出解密；Web/Server Action 只能读取凭证**元数据**（指纹前缀、过期时间、状态），永不读取或回显已保存密文；
- Web/Worker 的加密 key 与独立 fingerprint key 只从 `*_FILE` 指向的只读 Docker secret
  文件加载；密钥材料没有 env 回退。启动时对所有已声明版本和 fingerprint 文件做 canonical
  32-byte base64 预检，active 版本必须已声明；
- fingerprint key 迁文件时必须逐字节保留原材料，轮换加密 key 不得联动轮换 fingerprint key；
- Scheduler 容器不得注入任何 `CHANNEL_CREDENTIAL_` 配置或挂载 Credential secret；
- add/replace 同步完成且不创建 GenericTask；任何 GenericTask JSON 仍禁止 secret/ciphertext/fingerprint；
- 凭证写操作（六个凭证操作对齐 CPS `channel-accounts/actions.ts` 形态）全部需 `credential:manage` 能力位门控；
- 指纹冲突最终由数据库唯一约束兜底，不得仅靠应用层判断。
