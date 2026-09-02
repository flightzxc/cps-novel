import { Prisma } from "@prisma/client";

import { HEALTH_DATABASE_TIMEOUT_MS, type HealthDatabaseClient } from "./service";

/**
 * `/api/health/worker` 判定逻辑（RC-7b）。
 *
 * 不是 CPS 移植——CPS `v8.3.6` 没有等价端点（`git ls-tree v8.3.6 --
 * src/app/api/health` 只有 `backup/ live/ ready/ route.ts` 四项，已核实）。这里
 * 复用的是同一套 Keyword 监控形态（见 `backup-status.ts` 头注释与 CPS
 * 2026-08-22 DEVLOG），判据本身取自本仓自己的运维文档
 * `docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` §2「Expired processing locks」：
 * 过期处理锁（`status = 'processing' AND locked_until < transaction_timestamp()`）
 * 是"租约到期但没有 Worker 在正常回收"的信号；`heartbeat_at` 字段与三张
 * `*_task_item` 表名取自 `src/lib/tasks/store.ts`（`heartbeatTaskItem`/
 * `assignLease` 等写路径）与 `prisma/schema.prisma` 的 `CatalogScanTaskItem` /
 * `ChannelSyncTaskItem` / `GenericTaskItem` 模型（`@map("heartbeat_at")`）。
 *
 * 判定：
 *   - 查询失败或超过 `HEALTH_DATABASE_TIMEOUT_MS`（与 `getHealthReport` 共用同
 *     一个探测预算常量，见 `./service.ts`）→ failed（503）。
 *   - 存在过期处理锁（expiredLocks > 0）→ degraded（503）。
 *   - 否则 → ok（200）。
 * `lastHeartbeatAgeSeconds` 只是诊断信息，不参与判定——三张表里从未有过
 * `heartbeat_at`（从未有 item 被租用过）时为 `null`，按 idle 处理，视为 ok，
 * 不是 failed/degraded 的触发条件。
 *
 * 响应体不含 SQL、表名、连接串或错误堆栈：只输出
 * `{ workerStatus, expiredLocks, lastHeartbeatAgeSeconds, checkedAt }`。
 */

export type WorkerStatusValue = "ok" | "degraded" | "failed";

export interface WorkerHealthResult {
  workerStatus: WorkerStatusValue;
  expiredLocks: number;
  lastHeartbeatAgeSeconds: number | null;
  checkedAt: string;
}

export interface WorkerStatusOptions {
  timeoutMs?: number;
  now?: () => number;
}

interface ExpiredLockRow {
  family: string;
  task_type: string;
  expired_count: bigint | number;
  oldest_expiry: Date;
  maximum_overdue: unknown;
}

interface HeartbeatRow {
  last_heartbeat_at: Date | null;
}

// 逐字取自 docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md §2「Expired processing
// locks」——只读证据查询，不带任何调用方参数，用 Prisma.sql 标签而非字符串拼接。
const EXPIRED_LOCKS_QUERY = Prisma.sql`
  WITH expired AS (
    SELECT 'catalog_scan'::text AS family, 'catalog_scan'::text AS task_type,
           i.locked_until
    FROM catalog_scan_task_item i
    WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
    UNION ALL
    SELECT 'channel_sync', t.task_type, i.locked_until
    FROM channel_sync_task_item i
    JOIN channel_sync_task t ON t.id = i.task_id
    WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
    UNION ALL
    SELECT 'generic', t.task_type, i.locked_until
    FROM generic_task_item i
    JOIN generic_task t ON t.id = i.task_id
    WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
  )
  SELECT family, task_type, count(*) AS expired_count,
         min(locked_until) AS oldest_expiry,
         max(transaction_timestamp() - locked_until) AS maximum_overdue
  FROM expired
  GROUP BY family, task_type
  ORDER BY maximum_overdue DESC, family, task_type
`;

// 心跳年龄不在运维文档里，字段/表名取自 src/lib/tasks/store.ts 与
// prisma/schema.prisma（见上方头注释）。三表 UNION 取全局最新一次心跳。
const LAST_HEARTBEAT_QUERY = Prisma.sql`
  SELECT max(heartbeat_at) AS last_heartbeat_at
  FROM (
    SELECT heartbeat_at FROM catalog_scan_task_item WHERE heartbeat_at IS NOT NULL
    UNION ALL
    SELECT heartbeat_at FROM channel_sync_task_item WHERE heartbeat_at IS NOT NULL
    UNION ALL
    SELECT heartbeat_at FROM generic_task_item WHERE heartbeat_at IS NOT NULL
  ) AS heartbeats
`;

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
}

export async function evaluateWorkerStatus(
  database: HealthDatabaseClient,
  options: WorkerStatusOptions = {},
): Promise<WorkerHealthResult> {
  const now = (options.now ?? Date.now)();
  const timeoutMs = options.timeoutMs ?? HEALTH_DATABASE_TIMEOUT_MS;
  const checkedAt = new Date(now).toISOString();

  const outcome = await Promise.race([
    Promise.all([
      database.$queryRaw<ExpiredLockRow[]>(EXPIRED_LOCKS_QUERY),
      database.$queryRaw<HeartbeatRow[]>(LAST_HEARTBEAT_QUERY),
    ]).then(
      ([expiredRows, heartbeatRows]) => ({ status: "resolved" as const, expiredRows, heartbeatRows }),
      () => ({ status: "rejected" as const }),
    ),
    delay(timeoutMs, { status: "timeout" as const }),
  ]);

  if (outcome.status !== "resolved") {
    return { workerStatus: "failed", expiredLocks: 0, lastHeartbeatAgeSeconds: null, checkedAt };
  }

  const expiredLocks = outcome.expiredRows.reduce((sum, row) => sum + Number(row.expired_count), 0);
  const lastHeartbeatAt = outcome.heartbeatRows[0]?.last_heartbeat_at ?? null;
  const lastHeartbeatAgeSeconds = lastHeartbeatAt
    ? Math.max(0, Math.round((now - new Date(lastHeartbeatAt).getTime()) / 1000))
    : null;

  return {
    workerStatus: expiredLocks > 0 ? "degraded" : "ok",
    expiredLocks,
    lastHeartbeatAgeSeconds,
    checkedAt,
  };
}
