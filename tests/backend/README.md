# tests/backend/

**Owner: Codex（独占写入）**

## 用途

后端单元测试：Prisma Schema 约束、Worker/Scheduler fencing 逻辑、Auth/Credential、Adapter 等后端模块的测试。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-13（测试、项目隔离检查、恢复 smoke test）** 填充。

## 特别纪律

- P1-04～P1-12 各自验收项须有对应测试覆盖，不得留空档；
- 测试库方案需为 PostgreSQL 原生方案（如 `CREATE DATABASE … TEMPLATE` 或 per-worker schema），不得照搬 CPS 复制 `.db` 文件的做法。
