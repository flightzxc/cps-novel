# prisma/

**Owner: Codex（独占写入）**

## 用途

Prisma Schema 定义、数据库 migration 文件、seed 脚本。是本项目唯一的数据库结构真源。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-05（PostgreSQL Schema、Migration、约束和索引）** 填充。

## 特别纪律

- **PostgreSQL only**，禁止任何 SQLite 残留（连接串、方言配置、SQLite 专用类型/函数均不得出现）；
- 状态类字段必须有 `CHECK` 约束，不允许裸字符串枚举；
- 软删场景使用部分唯一索引排除已软删行，**唯一例外**是 `public_redirect_code`（见 `docs/governance/database-governance.md`）——其唯一索引不得排除软删行，因为该码永不复用；
- 每条从 CPS `prisma/schema.prisma` 搬运的表/字段形态，必须登记 `docs/governance/port-registry.md`。
