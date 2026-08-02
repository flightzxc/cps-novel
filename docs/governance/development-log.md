# 开发日志

按时间倒序或正序均可，本文件用于记录每次实质性开发动作的摘要，供后续任务与审计回溯。

---

## 2026-08-03 · P1-05B 初始 PostgreSQL Migration

### 本轮做了什么

- 使用已固定的 Prisma CLI/Client 6.19.2，从 37-model Schema 生成并审查 `20260803090000_p1_initial_schema`；
- 在同一 Migration 中补齐 66 个状态/数值/跨字段 CHECK、active scope/identity 部分唯一索引、三类 Item 的 pending/recovery 独立索引，以及公开码不可变和 operation audit append-only trigger；
- Article → PromoLink 复合 FK 使用 PostgreSQL 默认 MATCH SIMPLE，并通过 `pg_constraint.confmatchtype='s'` 实测；
- 将 825 条数据库字典记录激活，记录 `managed_by`、`physical_name`、Migration ID 和 evidence；
- 新增 Schema/字典/pg_catalog 双向 drift 检查，以及一次性 PostgreSQL 16 Docker 验证脚本；
- PostgreSQL 16.14 空库部署、重复部署、双向 drift、16 个负向场景、5 类正向场景和六条索引执行计划全部通过；完整测试 12/12 PASS；
- 所有 disposable 容器与 volume 已清理，CPS 参考仓库保持 clean@`d77c3b9`。

### 明确没做的（本轮范围外）

- 未创建数据库角色、GRANT/REVOKE、备份或 PITR；
- 未实现 Worker、Scheduler、Auth、Credential、Adapter；
- 未创建正式数据库或 Compose，未连接生产、预生产或 CPS 数据库；
- 未修改 `package.json`、lockfile、`src/app/**`、`src/components/**` 或 `src/contracts/**`。

## 2026-08-02 · P1-04 工程骨架

### 本轮做了什么

- 建立 Codex 独占写入目录的占位结构：`prisma/`、`src/server/`、`src/lib/db/`、`src/lib/auth/`、`src/lib/credentials/`、`src/lib/tasks/`、`src/lib/adapters/`、`worker/`、`scheduler/`、`infra/`、`scripts/`、`tests/backend/`、`tests/integration/`，每个目录含 `README.md`（Owner、用途、本轮范围、填充任务、特别纪律）与 `.gitkeep`；
- 建立 Claude 独占写入目录的占位结构：`src/components/`、`src/design/`、`src/features/admin-ui/`、`src/features/public-ui/`，同样含 `README.md` + `.gitkeep`；
- 建立共享路径 `src/contracts/`（Claude 为 merge custodian）与 `src/domain/`（Codex 为 merge custodian）的占位说明，未写任何类型定义；
- 建立 `docs/governance/` 下四份治理文档：`port-registry.md`（空表头）、`database-governance.md`（骨架）、`version-registry.md`（首条记录）、`development-log.md`（本文件）；
- 建立仓库根 `CLAUDE.md` 作为架构事实唯一权威源。

### 明确没做的（本轮范围外）

- 无 Prisma Schema / migration（留给 P1-05）；
- 无 Worker / Scheduler 实现（留给 P1-07）；
- 无 Adapter 实现（留给 P1-07 前后，具体任务编号待 Notion 台账明确）；
- 无 Auth / Credential 实现（留给 P1-08）；
- 无数据库连接、角色、备份方案（留给 P1-05 / P1-06）；
- 无 Docker Compose 配置（留给 P1-12）；
- 无 CI workflow（本轮不创建 `.github/` 任何内容）；
- `src/contracts/` 内无任何业务 DTO / 类型定义，仅有目录说明。
