# src/lib/db/

**Owner: Codex（独占写入）**

## 用途

数据库客户端封装（Prisma Client 实例化与连接池配置）、通用查询辅助函数、事务辅助工具。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-05（PostgreSQL Schema、Migration、约束和索引）** 填充。

## 特别纪律

- 应用连接**不使用** `migration_owner` 等管理员角色，按 P1-06 落地的五角色方案分权连接；
- 任何原生 SQL 一律禁止未加引号的 `AS camelCase` 别名；
- 领取类查询（任务领取、租约恢复）必须走独立索引路径，pending 与租约过期两条路径不得用 `OR` 合并。
