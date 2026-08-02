# P1-06 数据库角色、权限、备份与恢复报告

```text
RESULT=PASS
TASK_ID=P1-06
BRANCH=feature/v0.1.0-p1-db-ops
COMMITS=b8027a6 feat(p1-06): add PostgreSQL roles and least-privilege grants; test(p1-06): verify backup restore and database permissions (containing commit, exact hash in final handoff)
ROLE_TESTS=PASS (source and restored database, 6/6 each)
WEB_SECRET_READ=DENIED
ANALYST_WRITE=DENIED (INSERT/UPDATE/DELETE)
APP_DDL=DENIED
LOGICAL_BACKUP=PASS
LOGICAL_RESTORE=PASS
RESTORE_DURATION=803ms
PITR_STATUS=SCRIPT_AND_RUNBOOK_ONLY; production PITR not established
DICTIONARY_DRIFT=PASS (0 drift, 825/825 active records)
DISPOSABLE_DATABASE_CLEANED=YES
CPS_STATUS_BEFORE=CLEAN@d77c3b968285698529cf97c7f0f97b286d7a2a9c
CPS_STATUS_AFTER=CLEAN@d77c3b968285698529cf97c7f0f97b286d7a2a9c
BLOCKERS=NONE
NEXT_GATE=GPT_NOTION_P1_06_REVIEW
```

## 1. 基线与范围

- 从 `origin/main@d7287729bd02b4f9957485aec6be96118efae864` 创建独立 worktree 和 `feature/v0.1.0-p1-db-ops`。
- 未修改 Prisma 领域结构、`worker/`、`scheduler/`、`src/lib/tasks/`、UI、Contracts 或 CPS。
- CPS 只读参考库开工前后均 clean，HEAD 保持 `d77c3b968285698529cf97c7f0f97b286d7a2a9c`。
- 未运行 `npm audit fix --force`；`npm ci` 报告的 6 个 high 留给 P1-12 依赖治理。

## 2. 角色与负向验证

一次性环境使用 `postgres:16`，实际版本 `PostgreSQL 16.14 (Debian 16.14-1.pgdg13+1)`，镜像摘要 `postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20`。五个角色密码、bootstrap 密码、密文、fingerprint、任务 token 均在运行时随机产生，通过临时 mode `0600` 文件或进程环境传递；测试输出未记录凭证值。

真实独立连接验证：

- `web_app` 读取凭证元数据成功；读取 `encrypted_secret` 和 `SELECT *` 均失败；DDL 失败。
- `analyst_ro` 的 `statement_timeout=30s`、`default_transaction_read_only=on`；INSERT/UPDATE/DELETE、密文读取及 `SELECT *` 均失败。
- `web_app`、`worker_app` 均不能 UPDATE/DELETE `operation_audit`。
- `worker_app` 可读取密文，并在同一事务完成最小任务 claim、token/epoch 租约写入和 Audit 追加。
- `backup_role` 可读取完整备份数据并完成 `pg_dump`，但 DML/DDL 失败。
- `web_app`、`worker_app`、`analyst_ro`、`backup_role` 均无 `public` schema CREATE；应用连接身份均不是 `migration_owner`。

同一组 6 项集成测试分别在源数据库和恢复数据库执行，均为 6/6 PASS。

## 3. 逻辑备份与恢复证据

流程为：空库 Migration → 最小随机 seed → grants → 角色测试 → `backup_role` custom-format `pg_dump` → 新建 `cps_novel_restore_*` 空库 → `migration_owner` 单事务 `pg_restore` → 重放 grants → 源/恢复核对 → 恢复库角色测试。

| 核对项 | 源库 / 恢复库结果 |
| --- | --- |
| 应用表 | 37 / 37 |
| 字典记录 | 825 active，0 drift / 825 active，0 drift |
| 约束 | 159 / 159；定义摘要一致 |
| 索引 | 163 / 163；对象摘要一致 |
| Trigger | 2 / 2；对象摘要一致 |
| Prisma Migration | 1 completed / 1 completed |
| 关键行数 | channel、credential、task、item、audit 全部一致 |
| 约束摘要 | `117752b310d26b64c68e27d88d91269f` |
| 索引/Trigger 摘要 | `030ebceba287ba307bf55a36e58d5cde` |
| 恢复耗时 | 803 ms |

最终验证还通过 `typecheck`、ESLint、backend 8/8、全量非数据库测试 9/9；数据库测试在显式 disposable 环境执行，普通全量测试中按设计 skip。

## 4. PITR 与清理状态

- 逻辑恢复演练为实际执行结果。
- `backup-physical-base.sh`、`archive-wal.sh`、`restore-pitr.sh`、配置样例和 runbook 已建立，但没有执行 disposable PITR，因此不声明生产 PITR 或实际 PITR 演练完成。
- 轻量基线为 RPO ≤15 分钟、RTO ≤4 小时、PITR/WAL 7 天、每日逻辑备份 14 天、每周 base backup。
- 两次中途验证迭代和最终成功演练均由 trap 清理。最终核对无 `cps-novel-p1-06-*` 容器或 volume，临时 dump、pgpass 和随机凭证目录已删除。
