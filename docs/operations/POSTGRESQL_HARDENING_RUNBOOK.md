# PostgreSQL 16 硬化配置与启用 Runbook

## 1. 状态与边界

X2 交付的是仓库内的 PostgreSQL 配置合同、角色会话超时与一次性
PostgreSQL 16 验证。`infra/postgres/pitr/postgresql.conf.example` **不是现网加载证据**；
仅合入仓库不能宣称生产已启用 `pg_stat_statements`、慢查询日志或新的连接上限。

本次零 schema migration。`CREATE EXTENSION pg_stat_statements` 是生产运维窗口中的显式步骤，
不写入 Prisma migration，也不由应用进程执行。

## 2. 冻结参数

### 角色会话预算

| 角色 | `statement_timeout` | `lock_timeout` | `idle_in_transaction_session_timeout` |
| --- | ---: | ---: | ---: |
| `web_app` | 30 秒 | 5 秒 | 60 秒 |
| `worker_app` | 5 分钟 | 15 秒 | 5 分钟 |
| `scheduler_app` | 1 分钟 | 5 秒 | 60 秒 |

`ALTER ROLE ... SET` 只在新会话上生效。重放 `infra/postgres/roles.sql` 后必须滚动重启
Web、Worker 和 Scheduler 连接池，不得用旧长连接的 `SHOW` 结果作为验收证据。

### 集群参数

| 参数 | 冻结值 |
| --- | --- |
| `max_connections` | `100` |
| `log_min_duration_statement` | `500ms` |
| `shared_preload_libraries` | `pg_stat_statements` |
| `compute_query_id` | `auto` |
| `pg_stat_statements.track` | `all` |

`max_connections=100` 是容量上限合同，不是对应用池可以合计占满 100 个连接的授权。
所有运行容器的池上限总和继续至少保留 30% 管理、迁移、备份和峰值余量。

## 3. 生产启用窗口

1. 记录变更单、目标 PostgreSQL 16 小版本、当前参数快照、连接数和回滚负责人。
2. 确认目标实例已安装与服务端小版本匹配的 `pg_stat_statements` 扩展文件。在隔离或备库环境先用同一配置启动。
3. 将样例中的冻结参数合并到目标实例的受管配置，并用 PostgreSQL 提供的配置检查确认无语法错误。
4. 重放 `infra/postgres/roles.sql`，但不将密码写入命令行或日志。
5. 在受控窗口重启 PostgreSQL。`shared_preload_libraries` 和 `max_connections` 需要重启；仅执行 `pg_reload_conf()` 不能完成 X2 开闸。
6. 数据库恢复健康后，由受授权的 DBA 在每个需要观测的数据库显式执行：

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```

7. 滚动重启 Web、Worker 和 Scheduler 连接池，再用各自登录角色建立新会话验证超时。
8. 观察慢查询日志量、连接数、查询延迟和错误率。未完成下节全部核验前，状态只能是“配置已部署，待验证”。

## 4. 必须保存的验证证据

以 DBA 身份运行：

```sql
SELECT current_setting('server_version') AS server_version;
SELECT current_setting('max_connections') AS max_connections;
SELECT current_setting('log_min_duration_statement') AS log_min_duration_statement;
SELECT current_setting('shared_preload_libraries') AS shared_preload_libraries;
SELECT current_setting('compute_query_id') AS compute_query_id;
SELECT current_setting('pg_stat_statements.track') AS pg_stat_statements_track;
SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements';
SELECT count(*) >= 0 AS pg_stat_statements_readable FROM pg_stat_statements;
```

分别以 `web_app`、`worker_app`、`scheduler_app` 的**新连接**运行：

```sql
SELECT current_user,
       current_setting('statement_timeout') AS statement_timeout,
       current_setting('lock_timeout') AS lock_timeout,
       current_setting('idle_in_transaction_session_timeout') AS idle_timeout;
```

证据包必须包含变更前后参数、PostgreSQL 重启时间、扩展版本、三个角色的新会话结果、
慢查询日志样本和监控图。不得只保存配置文件 diff。

## 5. 回滚

若启动失败或资源压力超出基线，恢复变更前的受管配置并重启 PostgreSQL，
然后重启应用连接池。不自动 `DROP EXTENSION`；扩展对象的去留需由 DBA 依赖检查后另行决定。
回滚后重跑第 4 节查询，保存失败原因、实际恢复时间和未解决风险。

## 6. 一次性验证

`scripts/run-x2-postgres-hardening-verification.sh` 会启动一个临时 PostgreSQL 16 容器，
加载样例配置，验证三个运行角色的新会话超时，并实际创建/查询
`pg_stat_statements`。容器和 volume 由 trap 清理；该 PASS 只证明仓库合同可在一次性
实例上生效，不是生产启用证据。
