-- 修复 GET /api/health/worker 在冷缓存下超时、把正常的 worker 误报成 503
-- （2026-10-05 生产只读实证）。
--
-- 根因：`src/server/health/worker-status.ts` 的"最近心跳"查询
--   SELECT max(heartbeat_at) ... WHERE heartbeat_at IS NOT NULL
-- 在 `generic_task_item`（生产约 36.8 万行 / 496 MB）和 `channel_sync_task_item`
-- （约 8 万行 / 83 MB）上没有任何索引覆盖 `heartbeat_at`，每次请求整表顺序扫描：缓存热时
-- 87 ms，缓存冷时 1.5 s，越过 `HEALTH_DATABASE_TIMEOUT_MS = 1500`，按设计返回
-- failed / 503，而 worker 本身完全正常。
--
-- 修法：每张表加一个只含"当前在途行"的部分索引（几个页，与表的历史规模无关）：
--   (heartbeat_at) WHERE heartbeat_at IS NOT NULL
-- `src/lib/tasks/store.ts` 在领取（assignLease）和心跳（heartbeatTaskItem）时写
-- heartbeat_at，在完成/重排/过期恢复（guardedFinalize / guardedRequeue /
-- recoverExpiredItem）时置回 NULL，所以非空行 = 当前在途的 item，索引永远只有几十行；
-- 查询同步改成每表 `ORDER BY heartbeat_at DESC LIMIT 1` 再取两者较大值，走索引末端。
--
-- 同一次健康检查里的"过期租约"查询
--   status = 'processing' AND locked_until < transaction_timestamp()
-- 不需要新索引：初始迁移（20260803090000_p1_initial_schema）早已建了
--   generic_task_item_expired_lease_idx / channel_sync_task_item_expired_lease_idx
--   (locked_until, id) WHERE status = 'processing' AND locked_until IS NOT NULL
-- （worker 的 selectExpired 也靠它），`locked_until < …` 是严格比较，规划器能证明它蕴含
-- `locked_until IS NOT NULL`，于是该查询本来就能走这两个索引。真实库 EXPLAIN 证据与"索引
-- 删掉就红"的变异见 tests/integration/health/worker-health-indexes-postgres.test.ts。再加
-- 一对 `(locked_until) WHERE status = 'processing'` 只会是重复索引，白白放大每次
-- 领取/心跳/完成的写成本，所以不加。
--
-- 只加索引：不改列、不改 CHECK、不改 FK、不改数据、不动任何已有迁移，也不需要改
-- `infra/postgres/grants.sql`（索引随表由 migration_owner 持有，查询角色用索引不需要额外
-- 权限）。Prisma 6.19 的 @@index 不支持 where 子句，因此这两个部分索引只存在于本迁移 SQL
-- （与 generic_task_catalog_scan_* / *_expired_lease_idx / channel_account_hold_active_uidx
-- 同一约定），字典里记为 managed_by=migration_sql。命名沿用同表既有部分索引的
-- `{完整表名}_{用途}_idx`。
--
-- 不用 CREATE INDEX CONCURRENTLY：迁移在 Prisma 事务里执行，CONCURRENTLY 不能在事务块
-- 中运行；release.sh 的 migrate-approved 在维护模式（应用已停）下执行。普通 CREATE INDEX
-- 持有 SHARE 锁（阻塞写、不阻塞读），窗口 = 对该表的一次顺序扫描 + 对几十行排序建树。

CREATE INDEX "generic_task_item_heartbeat_idx"
  ON "generic_task_item" ("heartbeat_at")
  WHERE "heartbeat_at" IS NOT NULL;

CREATE INDEX "channel_sync_task_item_heartbeat_idx"
  ON "channel_sync_task_item" ("heartbeat_at")
  WHERE "heartbeat_at" IS NOT NULL;
