# P1-05B 初始 PostgreSQL Migration 验证报告

## 1. 结论

P1-05B 已将 37-model Prisma Schema 落地为单个 PostgreSQL 16 初始 Migration，并在完全 disposable 的 PostgreSQL 16.14 容器中完成空库部署、重复部署、Schema drift、字典 drift、真实正负约束测试和索引执行计划验证。

- Migration：`20260803090000_p1_initial_schema`
- Prisma CLI：`6.19.2`
- Prisma Client：`6.19.2`
- PostgreSQL：`16.14 (Debian 16.14-1.pgdg13+1)`
- 业务表：37
- 数据字典：825 条，825 条 active，stable_key 零重复
- pg_catalog：159 个约束，其中 66 个 CHECK、56 个 FK；163 个索引；2 个非内部 trigger
- 数据库和 Schema drift：零
- 字典和 Schema/pg_catalog drift：零
- disposable 容器与 volume：已清理

## 2. 依赖与基线

- Schema/字典基线：`39a2b609baa48d16e9c4924fa74bd21686bfa951`
- Claude dependency commit：`db0d4cd1ab2089793644f8e378ef64e95b6f2a51`
- P1-05B 未修改 `package.json` 或 lockfile。
- `npm ci` 后确认 `prisma=6.19.2`、`@prisma/client=6.19.2`。
- CPS 参考仓库验证前后均为 clean@`d77c3b968285698529cf97c7f0f97b286d7a2a9c`。

## 3. Migration 内容

Prisma 管理 37 张表、普通列、PK、FK、全量 UNIQUE 和普通索引。初始 Migration 同文件追加：

- 全部状态和受限枚举 CHECK；
- 数值、时间窗、ScheduleRun/CronRun、任务 Item lease shape 和 Article publication shape CHECK；
- active credential、Novel/Chapter/Article identity、三类 active task scope 和 carousel manual slot 部分唯一索引；
- GenericTask nullable scope 使用 PostgreSQL `NULLS NOT DISTINCT`；
- 三类 Item 各自的 task-scoped pending、global pending 和 expired lease recovery 部分索引；
- `promo_public_code_immutable_trigger`；
- `operation_audit_append_only`；
- Article → PromoLink 复合 FK `article_promo_link_novel_fkey`，实际 `confmatchtype='s'`，即 PostgreSQL 默认 MATCH SIMPLE。

`public_redirect_code`、credential fingerprint latch、IndexNow `(url, revision)`、`side_effect_intent.effect_key` 和 carousel serving `(locale, position)` 均使用全量数据库唯一性。

## 4. Migration 与 drift 验证

| 验证 | 结果 |
| --- | --- |
| `prisma validate` | PASS |
| `prisma generate` | PASS |
| 空库 `prisma migrate deploy` | PASS，应用 1 个 Migration |
| 第二次 `migrate deploy` | PASS，`No pending migrations to apply.` |
| migrations → Schema diff | PASS，`No difference detected.` |
| live database → Schema diff | PASS，`No difference detected.` |
| 37 个 model 对应表 | PASS |
| Schema ↔ active dictionary | PASS，零孤儿、零幽灵 |
| dictionary ↔ pg_catalog | PASS，零遗漏 |
| SQLite/PRAGMA/busy/伪锁扫描 | PASS |
| 未加引号 camelCase SQL alias 扫描 | PASS |

## 5. 真实约束测试

以下失败均由 PostgreSQL 实际拒绝：

1. published Article 的 title 为空白；
2. published Article 的 slug 为空白；
3. published Article 的 body 为空白；
4. published Article 缺 promo_link_id；
5. published Article 缺 published_at；
6. Article 引用另一 Novel 的 PromoLink；
7. 重复 public_redirect_code；
8. PromoLink 软删后复用旧 public_redirect_code；
9. 修改已分配 public_redirect_code；
10. 重复 credential fingerprint latch；
11. 同 account + app + project_type 创建第二个 active CatalogScan；
12. 重复 IndexNow `(url, revision)`；
13. 重复 `side_effect_intent.effect_key`；
14. 非法 Novel status；
15. UPDATE operation_audit；
16. DELETE operation_audit。

以下合法写入均成功：

- draft Article 的 promo_link_id、published_at 均为空；
- MATCH SIMPLE 接受 `promo_link_id=NULL`、`novel_id NOT NULL`；
- 不同账户可对相同 App/project_type 分别建立 active CatalogScan；
- 同一账户可对不同 App/project_type 分别建立 active CatalogScan；
- NovelChapter 的 `stale` 和 `withdrawn` 状态均可写入。

## 6. pending claim 与 expired recovery 执行计划

测试为每种 Item 表装载 6,000 行并执行 `ANALYZE`，未关闭 seqscan。pending 和 recovery 使用两条独立 SQL，均不含 OR。

| Item 表 | pending 实际索引 | recovery 实际索引 |
| --- | --- | --- |
| `catalog_scan_task_item` | `catalog_scan_task_item_pending_global_idx` | `catalog_scan_task_item_expired_lease_idx` |
| `channel_sync_task_item` | `channel_sync_task_item_pending_global_idx` | `channel_sync_task_item_expired_lease_idx` |
| `generic_task_item` | `generic_task_item_pending_global_idx` | `generic_task_item_expired_lease_idx` |

六个 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 计划均真实命中预期部分索引。

## 7. 自动化与清理

- `scripts/check-database-dictionary-drift.mjs`：静态核对 Schema/JSONL，并在有数据库时双向核对 pg_catalog。
- `scripts/run-p1-05b-postgres-verification.sh`：创建唯一容器、volume、数据库和 shadow database；密码运行时随机生成且不输出；任何退出路径由 trap 清理。
- backend 测试：3/3 PASS。
- integration 测试：8/8 PASS。
- 完整 `npm test`：3 个文件、12 个测试 PASS。
- 最终 Docker 资源查询未发现 `cps-novel-p1-05b-*` 残留。

`npm ci` 报告现有依赖树有 6 个 high severity audit 项；本任务未修改依赖，且不使用 `npm audit fix --force` 扩大变更范围，交由依赖 custodian 后续专项处理。该观察不影响本轮 Migration 正确性结论。

## 8. 后续边界

- P1-06：数据库角色、列级权限、备份/PITR 与恢复演练。
- P1-07：Worker/Scheduler、SKIP LOCKED claim、heartbeat、token/epoch fencing 写事务。
- P1-08：Auth、Credential 加解密与后台 API。

P1-05B 未实现上述运行时能力，也未连接任何正式、预生产或 CPS 数据库。
