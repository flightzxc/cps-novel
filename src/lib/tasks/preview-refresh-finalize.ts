/**
 * B-46：试读任务写入章节之后，再入队一次站点地图刷新。
 *
 * 首次发布会立刻触发站点地图刷新，但试读章节要等之后的试读任务写入；章节页只有在章节可读之后
 * 才进站点地图（`PUBLIC_PREVIEW_CHAPTER_WHERE`），于是新书的章节页要等每日 04:00 JST 的兜底
 * 刷新才被收录（2026-10-15 PlotNovel 首批 50 篇发布时章节页只收录了 81/150）。
 *
 * 形态照 `./article-publish-finalize.ts`，只改触发的次数和时机，不碰试读与站点地图本身：
 *   - 触发点是试读 handler 注册的 `afterItemCommit`（每个条目落库提交之后，尽力而为——进程
 *     恰好死在提交与回调之间，这一轮就丢了，由每日兜底刷新补上）；
 *   - **按任务粒度**：任务还有 pending/processing 条目就直接返回；全部结束后，有条目改动了
 *     可读章节（新写 / 改写正文、恢复 stale、置 stale——计数由 handler 写进条目结果）才触发；
 *   - 入队走现成的 `enqueueSitemapRefresh`，不自己建 sitemap_refresh 任务：它自带在途合并
 *     （已有待处理的刷新就合并；正在跑就记一次跟进），不会撞在途唯一约束；
 *   - 在持有任务行锁的同一事务里比对水位线 `result.sitemapRefresh.coveredItemCount`，两个
 *     worker 同时提交最后两个条目也只触发一次；重复回调最坏是一次空转。
 *
 * 不新增环境变量：开关沿用 `FEATURE_SITEMAP_AUTO_REFRESH`（worker / worker-light 早已透传）。
 * 不新增授权：`worker_app` 对 `channel_sync_task` / `channel_sync_task_item` / `generic_task` /
 * `generic_task_item` 已有表级 SELECT/INSERT/UPDATE（`infra/postgres/grants.sql`），每日兜底
 * 刷新（`worker/handlers/sitemap-daily-fallback.ts`）用的就是同一个入队入口。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { isSitemapAutoRefreshEnabled } from "@/lib/flags";

import { MOBOREADER_TASK_TYPES } from "./moboreader";
import { enqueueSitemapRefresh } from "./sitemap-refresh";

export const PREVIEW_SITEMAP_REFRESH_REASON = "preview_chapters_written";

export type PreviewSitemapRefreshRecord = {
  status: "disabled" | "queued" | "coalesced";
  taskId: string | null;
  /** 触发时已结束、且改动了可读章节的成功条目数。 */
  coveredItemCount: number;
  triggerCount: number;
  triggeredAt: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 条目结果里的一个计数键；不是数字（旧条目没有这些键）就按 0 算，绝不因类型不对而报错。 */
function countKey(key: string): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof(i.result -> ${key}) = 'number' THEN (i.result ->> ${key})::numeric ELSE 0 END`;
}

/**
 * 试读 handler 的 `afterItemCommit`：`taskId` 是刚提交了一个条目的试读任务。
 * 任务自己还有未完成条目时直接返回（一次索引计数查询）。
 */
export async function refreshSitemapAfterPreviewTask(
  db: PrismaClient,
  taskId: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  if (!isSitemapAutoRefreshEnabled(env)) return;
  const open = await db.channelSyncTaskItem.count({
    where: { taskId, status: { in: ["pending", "processing"] } },
  });
  if (open > 0) return;

  await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ task_type: string; result: Prisma.JsonValue | null }>>(Prisma.sql`
      SELECT task_type, result FROM channel_sync_task
      WHERE id = ${taskId}::uuid
      FOR UPDATE
    `);
    const task = locked[0];
    if (!task || task.task_type !== MOBOREADER_TASK_TYPES.previewRefresh) return;
    const [stillOpen] = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n FROM channel_sync_task_item
      WHERE task_id = ${taskId}::uuid AND status IN ('pending', 'processing')
    `);
    if (stillOpen.n > 0) return;
    const [written] = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n FROM channel_sync_task_item i
      WHERE i.task_id = ${taskId}::uuid AND i.status = 'success'
        AND ${countKey("contentWrites")} + ${countKey("restoredCount")} + ${countKey("staleCount")} > 0
    `);
    const previous = asRecord(asRecord(task.result).sitemapRefresh);
    const covered = typeof previous.coveredItemCount === "number" ? previous.coveredItemCount : 0;
    if (written.n <= covered) return;

    const enqueued = await enqueueSitemapRefresh({
      reason: PREVIEW_SITEMAP_REFRESH_REASON,
      triggeredBy: `${MOBOREADER_TASK_TYPES.previewRefresh}#${taskId}`,
    }, tx, { env });
    const record: PreviewSitemapRefreshRecord = {
      status: enqueued.status,
      taskId: enqueued.status === "disabled" ? null : enqueued.taskId,
      coveredItemCount: written.n,
      triggerCount: (typeof previous.triggerCount === "number" ? previous.triggerCount : 0) + 1,
      triggeredAt: new Date().toISOString(),
    };
    await tx.$executeRaw(Prisma.sql`
      UPDATE channel_sync_task
      SET result = COALESCE(result, '{}'::jsonb) || ${JSON.stringify({ sitemapRefresh: record })}::jsonb,
          updated_at = transaction_timestamp()
      WHERE id = ${taskId}::uuid
    `);
  });
}
