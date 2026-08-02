# P1-06 PostgreSQL 16 备份与 PITR Runbook

## 1. 状态和恢复目标

本任务实际执行并计时的是 **逻辑备份与全新数据库恢复演练**。物理 base backup、连续 WAL 归档和 PITR 本轮只交付脚本、配置样例与操作手册，**不代表已建立生产级 PITR**。若没有独立的 disposable PITR 证据，报告必须填写 `PITR_STATUS=SCRIPT_AND_RUNBOOK_ONLY`。

轻量运行基线：RPO 不超过 15 分钟、RTO 不超过 4 小时；WAL/PITR 窗口 7 天；每日 custom-format 逻辑备份保留 14 天；每周一次物理 base backup，至少保留两份以覆盖 PITR 窗口。生产备份必须异地、静态加密、传输加密、不可覆盖，并与数据库主机使用不同故障域。

## 2. 角色与凭证

- `migration_owner` 只执行 Migration 和隔离恢复，不供应用进程使用。
- `backup_role` 具有全库只读和 `REPLICATION`，其凭证只从运行时 secret manager 写入 mode `0600` 的临时 `PGPASSFILE`；禁止命令行密码、仓库文件和日志输出。
- Web、Worker、Analyst、Scheduler 都不能取得备份凭证。Scheduler 也没有解密密钥。
- 备份文件包含 `encrypted_secret`，按 S3 管理；恢复环境必须隔离网络和访问主体。

## 3. 日常逻辑备份

在 PostgreSQL 16 客户端环境设置 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER=backup_role`、`PGPASSFILE`，然后执行：

```bash
scripts/db/backup-logical.sh --output /backup/logical/cps_novel_YYYYMMDDTHHMMSSZ.dump
```

作业必须同时保存 `.dump`、`.sha256`、`.metadata`，并验证 `pg_restore --list`。每日备份完成后复制到异地不可变存储；生命周期规则在 14 天后删除逻辑备份。失败、校验失败或 24 小时没有成功归档立即告警。

## 4. 物理 base backup 与 WAL

主库设置参考 `infra/postgres/pitr/postgresql.conf.example`。`archive_command` 必须只在归档真正持久化后返回 0，且不得覆盖同名但内容不同的 WAL。生产部署应把 `archive-wal.sh` 的本地归档目录替换为带版本锁/不可变策略的异地对象存储适配器。

每周在备份执行节点运行：

```bash
scripts/db/backup-physical-base.sh --output-dir /backup/base/cps_novel_YYYYMMDDTHHMMSSZ
```

保存 `backup_manifest`、`base.tar.gz` 和 `pg_wal.tar.gz`；复制到异地后执行供应商校验及定期 `pg_verifybackup` 演练。持续监控 `pg_stat_archiver.failed_count`、`last_failed_time`、`last_archived_time` 和 `pg_wal` 磁盘占用：归档延迟超过 5 分钟预警，达到 15 分钟宣告 RPO 风险；磁盘 70% 预警、85% 紧急。

## 5. 隔离 PITR 步骤

1. 建立无生产入口、无应用凭证的隔离恢复主机，安装与源库相同 PostgreSQL 16 小版本。
2. 选择目标时间之前最近一份已校验 base backup，冻结其文件和后续 WAL；记录操作者、事故编号、时间线与时区。
3. 创建全新的、路径中含 `p1-06-pitr` 的空目录，设置 `P1_06_ALLOW_DISPOSABLE_PITR=1` 和只读 WAL archive 路径。
4. 执行 `scripts/db/restore-pitr.sh --base-backup ... --pgdata ... --target-time 'ISO-8601'`。脚本只准备 `recovery.signal`、`restore_command`、`recovery_target_time` 和 `recovery_target_action='pause'`，不会启动 PostgreSQL。
5. 由 DBA 以隔离端口启动实例，观察日志直到 recovery pause。任何缺失 WAL、timeline 不匹配或 checksum 错误都终止演练，不得跳过。
6. 只读核对 37 张应用表、关键行数、约束摘要、`_prisma_migrations`、业务事故点前后记录和字典 drift。
7. 复核目标点正确后才执行 `pg_wal_replay_resume()` 并提升；错误则销毁该实例，从步骤 2 重新选择目标。
8. 恢复结果通过后轮换所有可能进入备份的凭证，再按正式变更流程切换流量。原主库保留只读证据，不覆盖、不回写。

## 6. 演练、清理与证据

每月至少进行一次逻辑恢复；每季度进行一次隔离 base backup + WAL/PITR 演练。记录备份开始/完成、目标时间、恢复开始/完成、RPO/RTO、校验结果、归档缺口和清理证据。演练结束后删除 disposable 容器、volume、PGDATA、临时 `PGPASSFILE` 和本地 dump；生产保留策略只能由备份系统生命周期规则执行，禁止脚本使用宽泛递归删除。

参考：PostgreSQL 16 官方文档 [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)、[pg_basebackup](https://www.postgresql.org/docs/16/app-pgbasebackup.html)、[Continuous Archiving and PITR](https://www.postgresql.org/docs/16/continuous-archiving.html)。
