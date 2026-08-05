# 搬运符号登记表（Port Registry）

本表登记所有从 CPS 只读参考仓库搬运到本项目的符号（函数、类型、常量、表结构片段、组件等）。

🔴 **纪律：每个从 CPS 搬入的符号都必须在此登记，未登记即视为违规。** P1-14（最终代码和架构审计）将逐条核对本表与实际代码，任何搬运但未登记的符号视为不符合项。

## 基线

- `baseline_commit` 统一为 CPS 只读参考仓库的固定基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`
- CPS 只读参考路径：`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`（详见仓库根 `CLAUDE.md`）

## `port_kind` 取值说明

| 取值 | 含义 |
| --- | --- |
| `COPY` | 原样复制，未做实质性改动 |
| `ADAPT` | 复制后做了改造（如泛化、参数化、重命名） |
| `PG_REIMPLEMENT` | 语义/思路保留，但因 SQLite → PostgreSQL 差异而重新实现 |
| `PATTERN_ONLY` | 只借鉴设计模式/组织形态，不搬运具体代码 |

## 登记表

P1-05A 只登记从 CPS 提取的数据库**模式证据**；没有字节复制。所有条目均经过 PostgreSQL、多账户、Novel 领域和 Owner 契约改造。

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |
| `Channel` schema pattern | `prisma/schema.prisma` | `100-113` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留渠道注册身份；改 UUID、PostgreSQL 类型、具名状态 CHECK 计划和 RESTRICT 删除策略 | Codex |
| `ChannelApp` schema pattern | `prisma/schema.prisma` | `222-246` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 Channel×SourceApp 绑定；`project_type` 参数化并移除模块硬编码 | Codex |
| `ChannelAccount` schema pattern | `prisma/schema.prisma` | `118-148` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留账户实体；冻结 Day 0 多账户，删除任何 Channel 1:1 假设 | Codex |
| Credential encrypted metadata pattern | `prisma/schema.prisma` | `150-168` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 密文改 `bytea`，Web/Scheduler 禁读密文，只保留后台可见 S1 指纹前缀元数据 | Codex |
| Credential fingerprint mutex latch | `prisma/schema.prisma` | `1236-1258` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PG_REIMPLEMENT` | 保留 fingerprint/credential 双唯一互斥模式；以 PostgreSQL 唯一约束消除 TOCTOU，不复制 SQLite 锁语法 | Codex |
| SourceItem/canonical separation | `prisma/schema.prisma` | `251-287` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | DramaSourceItem 改 NovelSourceItem；上游镜像与 canonical Novel 分离，普通同步只补 canonical 空值 | Codex |
| PromoLink independent asset | `prisma/schema.prisma` | `292-326` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | DramaPromoLink 改 Novel 推广资产；拆 upstream/public 两码，增加永久公开码与 Article 同 Novel 复合 FK | Codex |
| IndexNow outbox | `prisma/schema.prisma` | `1460-1497` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PG_REIMPLEMENT` | 保留 durable outbox 状态形态；幂等身份冻结为 `(url, revision)` 并规划 PostgreSQL claim 索引 | Codex |
| IndexNow outbox attempt | `prisma/schema.prisma` | `1499-1519` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留独立 attempt；真实状态列冻结为 `attempt_state`，删除幽灵 `status` 约束 | Codex |
| `home_carousel_manual_slot` pattern | `prisma/schema.prisma` | `740-757` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PG_REIMPLEMENT` | Drama→Novel/Article；enabled 部分唯一谓词改 PostgreSQL boolean 并排除软删 | Codex |
| `home_carousel_auto_batch` pattern | `prisma/schema.prisma` | `762-780` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留批次身份与状态；JSON 文本改版本化 jsonb、时间改 timestamptz | Codex |
| `home_carousel_auto_candidate` pattern | `prisma/schema.prisma` | `786-803` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | Drama→Novel/Article；分数改 numeric，保留 batch/locale/rank 唯一模式 | Codex |
| `home_carousel_serving` pattern | `prisma/schema.prisma` | `808-826` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 冻结为仅当前快照，`(locale, position)` 绝对唯一；删除时间有效期历史职责 | Codex |
| `home_carousel_change_log` pattern | `prisma/schema.prisma` | `831-843` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 保留 append-only 历史模式；移除 Drama 引用并承担 serving 历史变更 | Codex |
| `ADMIN_IDLE_TIMEOUT_MS` / `ADMIN_SESSION_TOUCH_INTERVAL_MS` / `ADMIN_ABSOLUTE_TIMEOUT_MS` | `src/lib/session-timeout.ts` | `3-5` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 2h idle、15min touch、24h absolute 参数；由 JWT token 改为显式 Session record | Codex |
| `validateAdminSession` | `src/lib/session-timeout.ts` | `17-69` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留绝对超时 fail-closed；增加 idle、撤销、identity 状态、session version 与时间序验证 | Codex |
| `requireAdminSession` | `src/lib/admin-session.ts` | `40-88` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 从 NextAuth/Prisma 闭包切成 token hash + `AdminIdentityStore`/`SessionStore` 端口，保留 sessionVersion 拒绝语义 | Codex |
| `AdminCapability` / `ADMIN_CAPABILITY_CONFIG` | `src/lib/admin-capabilities.ts` | `3-29` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 能力名改为 Novel 管理四项；promo/revenue 无默认角色，四项均登记 2FA 风险属性 | Codex |
| `hasAdminCapability` | `src/lib/admin-capabilities.ts` | `45-66` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 role/user env allowlist；输入改为端口化 `AdminAuthContext` | Codex |
| `requireAdminCapability` | `src/lib/admin-capabilities.ts` | `68-80` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 统一为 `admin_capability_denied` 403，并与 2FA 检查保持分层 | Codex |
| TOTP secret/URI/verification primitives | `src/lib/totp.ts` | `3-60` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 SHA1/6 位/30s/±1；移除 otpauth/qrcode 依赖，以 Node crypto 实现 RFC 6238，issuer 改 cps-novel | Codex |
| `encryptTotpSecret` / `decryptTotpSecret` | `src/lib/totp-crypto.ts` | `1-118` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 AES-256-GCM v1 载荷与严格 key/payload 校验；改为显式可注入 key，仍只用于 TOTP | Codex |
| Recovery Code primitives | `src/lib/recovery-codes.ts` | `4-63` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 10 个一次性格式和掩码；因禁止新增 bcryptjs 改为 Node scrypt + 独立盐 | Codex |
| Login failure dual-key limiter | `src/lib/auth-utils.ts` | `5-208` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 username/IP 双维度、5 次/15min；identifier 改 SHA-256 且持久化切为 `LoginAttemptStore` | Codex |
| 2FA pending setup lifecycle | `src/lib/two-factor-settings.ts` | `4-239` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 10min pending、确认后启用、恢复码轮换与 sessionVersion 前进；切断 Prisma/QR UI 闭包 | Codex |
| 2FA login challenge lifecycle | `src/lib/two-factor-login.ts` | `263-529` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 hash token、5min、5 次、TOTP/恢复码和单次消费；改为存储端口 | Codex |
| `ADMIN_PAGE_ROOTS` / segment-safe match | `src/proxy.ts` | `20-45` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 路由清单换为 Novel 后台 14 根路径，并新增未登记页面/API/Action 默认 404 | Codex |
| Credential capability boundary pattern | `src/app/(admin)/channel-accounts/actions.ts` | `49-200` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 只保留六操作命名与入口先鉴权模式；本轮不搬 Credential 写入、解密、渠道校验或 Action 实现 | Codex |
| `validateCredentialJwtLocally` | `src/lib/channel-account/jwt.ts` | `66-109` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留三段 JWT、base64url payload 与 exp 秒/毫秒解析；输出映射为 active/expired/invalid，不声明验签且不访问网络 | Codex |
| Worker Credential AES-GCM envelope | `src/lib/channel-account/credential-crypto.ts` | `31-131` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 AES-256-GCM 严格 key/envelope 校验；改为 Worker-only versioned key、bytea envelope，并用 account/credential UUID AAD 隔离 | Codex |
| Worker Credential fingerprint HMAC | `src/lib/channel-account/credential-crypto.ts` | `133-148` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `ADAPT` | 保留 HMAC-SHA256 指纹；拆分独立稳定 fingerprint key，完整值仅 Worker/DB 内部，DTO 只给 12 字符 prefix | Codex |
| insert-before-delete fingerprint reservation | `src/lib/changdu-total-revenue/credential-service.ts` | `299-301,385-389` | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` | `PATTERN_ONLY` | 保留唯一占位先预留再释放旧值的并发原则；小说使用 PostgreSQL UNIQUE 最终裁决并纳入 P1-07 fenced transaction | Codex |

### 无搬运的任务（显式登记，避免被当成漏登）

| 任务 | CPS 复刻分类 | 原因 |
| --- | --- | --- |
| P1-11 阅读器功能 | `ORIGINAL_REQUIRED` | CPS 零可复用的正文托管、分章渲染、阅读版式资产——CPS 的试看是视频跳转，语义不可平移。**本轮无任何从 CPS 搬入的符号。** |

## 使用说明

- `symbol`：被搬运的具体符号名（函数名/类型名/表名/字段名/组件名等），一行一个符号，不得用文件级粗粒度笼统登记；
- `source_file` + `source_lines`：CPS 参考仓库中的精确文件路径与行号区间；
- `changed_what`：即使 `port_kind = COPY`，也需注明"原样复制"；`ADAPT`/`PG_REIMPLEMENT` 必须具体说明改了什么；
- `owner`：登记该符号的执行方（Claude 或 Codex）。
