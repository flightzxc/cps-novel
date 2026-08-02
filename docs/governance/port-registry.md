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

## 使用说明

- `symbol`：被搬运的具体符号名（函数名/类型名/表名/字段名/组件名等），一行一个符号，不得用文件级粗粒度笼统登记；
- `source_file` + `source_lines`：CPS 参考仓库中的精确文件路径与行号区间；
- `changed_what`：即使 `port_kind = COPY`，也需注明"原样复制"；`ADAPT`/`PG_REIMPLEMENT` 必须具体说明改了什么；
- `owner`：登记该符号的执行方（Claude 或 Codex）。
