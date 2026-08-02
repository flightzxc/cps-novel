# infra/

**Owner: Codex（独占写入）**

## 用途

数据库角色脚本、备份/恢复方案（`pg_dump` + WAL 归档 + PITR）、Compose/部署相关基础设施配置。`Dockerfile`/compose/CI 相关文件的 merge custodian 也是 Codex（Claude 审核）。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

- 数据库角色与备份方案 → **P1-06（数据库角色、备份和恢复方案）**；
- Compose 与联调环境 → **P1-12（前后端契约联调和本地 Compose）**。

## 特别纪律

- 五角色脚本（`migration_owner` / `web_app` / `worker_app` / `analyst_ro` / `backup_role`）职责不得混用；
- 应用运行时**不使用 owner 角色**；
- 完整恢复演练必须实际执行并计时，不得只写方案不验证；
- Scheduler 容器配置层需实测确认无凭证密钥注入。
