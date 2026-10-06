/**
 * 后台批量发布的"收尾"：每个子任务合并成一个试读抓取任务，整批结束时只触发一次
 * 站点地图刷新（开发单 §三）。只改**触发的次数和时机**，不碰试读抓取、站点地图
 * 本身的逻辑——这里调用的仍然是它们现成的入口：
 *   - 试读：`dispatchPublicationPreviews`（`@/server/publication/dispatcher`，按书合并入队）；
 *   - 站点地图：`enqueueSitemapRefresh`（`./sitemap-refresh`，自带合并/跟进机制）。
 *
 * 触发点是子任务 handler 注册的 `afterItemCommit`（每个条目落库提交之后）。它是
 * "尽力而为"的观察者——进程恰好在条目提交与本函数之间死掉，这一轮收尾就丢了。所以
 * 这里**不靠一次性标记**，而是每次都从条目行重新推导、并用计数水位线判断"还差没差"：
 *   - 子任务：所有条目都离开 pending/processing 之后，把"已发布且尚未被上次派发
 *     覆盖"的文章合并派发一次试读；派发记录在子任务 `result.previewDispatch`，水位线
 *     是 `publishedCount`；重试失败项后新发布的文章会让水位线落后，下一次收尾补发；
 *   - 整批：所有子任务都没有未完成条目（暂停中的子任务仍有 pending 条目，所以不算
 *     结束）之后，已发布总数超过上次触发时覆盖的数（`sitemapRefresh.coveredPublishedCount`）
 *     才触发站点地图刷新，在同一事务里持有父任务行锁，双 worker 不会各触发一次。
 * 派发本身都是幂等的（试读按书加锁、请求令牌含文章集合；站点地图自带合并），重复
 * 调用最坏是多一次空转，不会重复建任务。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  ARTICLE_PUBLISH_BATCH_TASK_TYPE,
  ARTICLE_PUBLISH_TASK_TYPE,
  type ArticlePublishSitemapRefreshRecord,
} from "@/domain/article-publish-batch";
import { dispatchPublicationPreviews } from "@/server/publication/dispatcher";

import { enqueueSitemapRefresh } from "./sitemap-refresh";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value ? value : null;
}

async function mergeResult(
  db: Pick<PrismaClient, "$executeRaw">,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE generic_task
    SET result = COALESCE(result, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
        updated_at = transaction_timestamp()
    WHERE id = ${taskId}::uuid
  `);
}

type SettledChildRow = { id: string; params: Prisma.JsonValue; published_count: number };

/**
 * 把一个父任务名下"已经没有未完成条目、且有已发布文章、且派发水位线落后"的子任务
 * 逐个收尾：默认合并派发一次试读；勾了「暂不抓试读」则只记录跳过。
 */
async function dispatchSettledChildren(db: PrismaClient, parentTaskId: string): Promise<void> {
  const children = await db.$queryRaw<SettledChildRow[]>(Prisma.sql`
    SELECT c.id, c.params, pub.published_count
    FROM generic_task c
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS published_count
      FROM generic_task_item i
      WHERE i.task_id = c.id AND i.status = 'success' AND i.result->>'outcome' = 'published'
    ) pub
    WHERE c.parent_task_id = ${parentTaskId}::uuid
      AND c.task_type = ${ARTICLE_PUBLISH_TASK_TYPE}
      AND pub.published_count > 0
      AND NOT EXISTS (
        SELECT 1 FROM generic_task_item open_item
        WHERE open_item.task_id = c.id AND open_item.status IN ('pending', 'processing')
      )
      AND COALESCE((c.result->'previewDispatch'->>'publishedCount')::int, -1) <> pub.published_count
    ORDER BY c.created_at ASC, c.id ASC
  `);
  for (const child of children) {
    const params = asRecord(child.params);
    const batchRequestId = stringParam(params, "batchRequestId");
    const actorId = stringParam(params, "actorId");
    if (!batchRequestId || !actorId) continue;
    const rows = await db.$queryRaw<Array<{ article_id: string }>>(Prisma.sql`
      SELECT result->>'articleId' AS article_id
      FROM generic_task_item
      WHERE task_id = ${child.id}::uuid AND status = 'success' AND result->>'outcome' = 'published'
        AND result->>'articleId' IS NOT NULL
      ORDER BY result->>'articleId' ASC
    `);
    const articleIds = rows.map((row) => row.article_id);
    const at = new Date().toISOString();
    if (params.skipPreview === true) {
      await mergeResult(db, child.id, {
        previewDispatch: { skipped: true, publishedCount: child.published_count, at },
      });
      continue;
    }
    const outcome = await dispatchPublicationPreviews({
      articleIds,
      requestId: `${batchRequestId}:preview:${child.id}`,
      actorId,
    }, db);
    if (!outcome) {
      // 派发规划失败（已在 dispatcher 里记日志）：不推进水位线，下一次收尾再试。
      await mergeResult(db, child.id, { previewDispatch: { failed: true, at } });
      continue;
    }
    await mergeResult(db, child.id, {
      previewDispatch: {
        publishedCount: child.published_count,
        groupCount: outcome.groups.length,
        skipReasonCounts: outcome.skipReasonCounts,
        at,
      },
    });
  }
}

export type SettleArticlePublishBatchOptions = Readonly<{ env?: NodeJS.ProcessEnv }>;

/**
 * 整批收尾：只有当父任务名下所有子任务都没有 pending/processing 条目时才动作。
 * 返回 `true` 表示这次调用触发了站点地图刷新。
 */
async function settleParentBatch(
  db: PrismaClient,
  parentTaskId: string,
  options: SettleArticlePublishBatchOptions,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ result: Prisma.JsonValue | null; params: Prisma.JsonValue }>>(Prisma.sql`
      SELECT result, params FROM generic_task
      WHERE id = ${parentTaskId}::uuid AND task_type = ${ARTICLE_PUBLISH_BATCH_TASK_TYPE}
      FOR UPDATE
    `);
    const parent = locked[0];
    if (!parent) return false;
    const [open] = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM generic_task_item i
      JOIN generic_task c ON c.id = i.task_id
      WHERE c.parent_task_id = ${parentTaskId}::uuid AND c.task_type = ${ARTICLE_PUBLISH_TASK_TYPE}
        AND i.status IN ('pending', 'processing')
    `);
    if (open.n > 0) return false;
    const [agg] = await tx.$queryRaw<Array<{ published_count: number; published_books: number }>>(Prisma.sql`
      SELECT
        count(*) FILTER (WHERE i.status = 'success' AND i.result->>'outcome' = 'published')::int AS published_count,
        count(DISTINCT i.result->>'novelId') FILTER (
          WHERE i.status = 'success' AND i.result->>'outcome' = 'published' AND i.result->>'novelId' IS NOT NULL
        )::int AS published_books
      FROM generic_task_item i
      JOIN generic_task c ON c.id = i.task_id
      WHERE c.parent_task_id = ${parentTaskId}::uuid AND c.task_type = ${ARTICLE_PUBLISH_TASK_TYPE}
    `);
    const result = asRecord(parent.result);
    const params = asRecord(parent.params);
    const previous = asRecord(result.sitemapRefresh);
    const covered = typeof previous.coveredPublishedCount === "number" ? previous.coveredPublishedCount : 0;
    const patch: Record<string, unknown> = {};
    if (params.skipPreview === true) {
      patch.previewSkippedBookCount = agg.published_books;
    }
    let triggered = false;
    if (agg.published_count > covered) {
      const enqueued = await enqueueSitemapRefresh({
        reason: "article_publish_batch",
        triggeredBy: `${ARTICLE_PUBLISH_BATCH_TASK_TYPE}#${parentTaskId}`,
      }, tx, options.env ? { env: options.env } : {});
      const record: ArticlePublishSitemapRefreshRecord = {
        status: enqueued.status,
        triggerCount: (typeof previous.triggerCount === "number" ? previous.triggerCount : 0) + 1,
        coveredPublishedCount: agg.published_count,
        triggeredAt: new Date().toISOString(),
      };
      patch.sitemapRefresh = record;
      triggered = true;
    }
    patch.publishedCount = agg.published_count;
    await mergeResult(tx, parentTaskId, patch);
    return triggered;
  });
}

/**
 * 收尾一整批：先收尾本批所有已结束、尚未被收尾的子任务（试读），再尝试整批收尾（站点
 * 地图）。仍有未完成条目的批次什么都不做——它们的 `afterItemCommit` 会在最后一个条目
 * 提交后再来一遍。除了 `afterItemCommit`，任务中心的"整批中止"在提交之后也调它一次：
 * 中止时若恰好没有在途条目，就没有任何后续 `afterItemCommit` 会来收尾已发布的那部分。
 */
export async function settleArticlePublishBatch(
  db: PrismaClient,
  parentTaskId: string,
  options: SettleArticlePublishBatchOptions = {},
): Promise<void> {
  await dispatchSettledChildren(db, parentTaskId);
  await settleParentBatch(db, parentTaskId, options);
}

/**
 * 子任务 handler 的 `afterItemCommit`：`taskId` 是刚提交了一个条目的子任务。
 * 子任务自己还有未完成条目时直接返回（一次索引计数查询）。
 */
export async function finalizeArticlePublishAfterItem(
  db: PrismaClient,
  childTaskId: string,
  options: SettleArticlePublishBatchOptions = {},
): Promise<void> {
  const child = await db.genericTask.findUnique({
    where: { id: childTaskId },
    select: { taskType: true, parentTaskId: true },
  });
  if (!child || child.taskType !== ARTICLE_PUBLISH_TASK_TYPE || !child.parentTaskId) return;
  const open = await db.genericTaskItem.count({
    where: { taskId: childTaskId, status: { in: ["pending", "processing"] } },
  });
  if (open > 0) return;
  await settleArticlePublishBatch(db, child.parentTaskId, options);
}
