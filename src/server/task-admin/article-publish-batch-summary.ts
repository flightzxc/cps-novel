/**
 * 后台批量发布批次的结果汇总（任务详情页"发布结果"一节）：已发布 / 发布检查拒绝（按
 * 原因汇总）/ 跳过 / 未尝试 / 未完成，以及试读与站点地图的收尾情况。
 *
 * 全部由条目行与子任务行用两条聚合 SQL 推导，不依赖任何"收尾时写下的"数字，所以暂停、
 * 中止、重试失败项之后立刻就是准确的。对外只暴露计数与白名单化的拒绝原因码——条目的
 * 原始 `result`/`error` 永远不出这个模块（"X9 read DTO allowlists" 契约）。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { ARTICLE_PUBLISH_TASK_TYPE } from "@/domain/article-publish-batch";
import { narrowPublishGateReason, type PublishGateReason } from "@/contracts/publish-gate";

export type ArticlePublishBatchSummaryDto = Readonly<{
  /** 提交时是否勾选了「发布时暂不抓试读」。 */
  skipPreview: boolean;
  publishedCount: number;
  /** 发布检查不通过（条目失败，可重试）。 */
  rejectedCount: number;
  /** 其它原因失败（系统异常等，可重试）。 */
  otherFailedCount: number;
  /** 条目执行时文章已不是草稿（别人先改了状态）。 */
  notDraftCount: number;
  /** 条目执行时文章已被删除。 */
  notFoundCount: number;
  /** 被中止、从未尝试的条目。 */
  abortedUnattemptedCount: number;
  /** 仍待处理或处理中的条目。 */
  unfinishedCount: number;
  /** 拒绝原因码 → 篇数；只含发布检查登记过的原因码。 */
  rejectedReasonCounts: Readonly<Partial<Record<PublishGateReason, number>>>;
  preview: Readonly<{
    /** 勾选「暂不抓试读」时：已发布文章对应的本数（按书去重）；否则 `null`。 */
    skippedBookCount: number | null;
    /** 已完成试读合并派发的子任务数。 */
    dispatchedChildCount: number;
    /** 这些派发一共建出的试读抓取任务组数（按渠道账号 × 应用分组）。 */
    taskGroupCount: number;
  }>;
  sitemapRefresh: Readonly<{
    status: "queued" | "coalesced" | "disabled" | "failed";
    triggerCount: number;
    triggeredAt: string;
  }> | null;
}>;

type CountRow = {
  published: number;
  rejected: number;
  other_failed: number;
  not_draft: number;
  not_found: number;
  aborted_unattempted: number;
  unfinished: number;
};
type PreviewRow = { dispatched_child_count: number; task_group_count: number };
type ReasonRow = { reason: string; count: number };

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function loadArticlePublishBatchSummary(
  db: PrismaClient,
  parentTaskId: string,
  parent: { readonly params: unknown; readonly result: unknown },
): Promise<ArticlePublishBatchSummaryDto> {
  const [counts] = await db.$queryRaw<CountRow[]>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE i.status = 'success' AND i.result->>'outcome' = 'published')::int AS published,
      count(*) FILTER (WHERE i.status = 'failed' AND i.result->>'outcome' = 'rejected')::int AS rejected,
      count(*) FILTER (WHERE i.status = 'failed' AND COALESCE(i.result->>'outcome', '') <> 'rejected')::int AS other_failed,
      count(*) FILTER (WHERE i.status = 'skipped' AND i.result->>'outcome' = 'not_draft')::int AS not_draft,
      count(*) FILTER (WHERE i.status = 'skipped' AND i.result->>'outcome' = 'not_found')::int AS not_found,
      count(*) FILTER (WHERE i.status = 'skipped' AND i.error->>'code' = 'task_manually_aborted')::int AS aborted_unattempted,
      count(*) FILTER (WHERE i.status IN ('pending', 'processing'))::int AS unfinished
    FROM generic_task_item i
    JOIN generic_task c ON c.id = i.task_id
    WHERE c.parent_task_id = ${parentTaskId}::uuid AND c.task_type = ${ARTICLE_PUBLISH_TASK_TYPE}
  `);
  const [preview] = await db.$queryRaw<PreviewRow[]>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE c.result->'previewDispatch'->>'groupCount' IS NOT NULL)::int AS dispatched_child_count,
      COALESCE(sum((c.result->'previewDispatch'->>'groupCount')::int), 0)::int AS task_group_count
    FROM generic_task c
    WHERE c.parent_task_id = ${parentTaskId}::uuid AND c.task_type = ${ARTICLE_PUBLISH_TASK_TYPE}
  `);
  const reasonRows = await db.$queryRaw<ReasonRow[]>(Prisma.sql`
    SELECT reason.value AS reason, count(*)::int AS count
    FROM generic_task_item i
    JOIN generic_task c ON c.id = i.task_id
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(i.result->'reasons') = 'array' THEN i.result->'reasons' ELSE '[]'::jsonb END
    ) AS reason(value)
    WHERE c.parent_task_id = ${parentTaskId}::uuid AND c.task_type = ${ARTICLE_PUBLISH_TASK_TYPE}
      AND i.status = 'failed' AND i.result->>'outcome' = 'rejected'
    GROUP BY reason.value
  `);
  const rejectedReasonCounts: Partial<Record<PublishGateReason, number>> = {};
  for (const row of reasonRows) {
    const reason = narrowPublishGateReason(row.reason);
    if (reason && row.count > 0) rejectedReasonCounts[reason] = row.count;
  }

  const params = plainObject(parent.params);
  const result = plainObject(parent.result);
  const skipPreview = params.skipPreview === true;
  const sitemap = plainObject(result.sitemapRefresh);
  const sitemapStatus = sitemap.status;
  return Object.freeze({
    skipPreview,
    publishedCount: counts?.published ?? 0,
    rejectedCount: counts?.rejected ?? 0,
    otherFailedCount: counts?.other_failed ?? 0,
    notDraftCount: counts?.not_draft ?? 0,
    notFoundCount: counts?.not_found ?? 0,
    abortedUnattemptedCount: counts?.aborted_unattempted ?? 0,
    unfinishedCount: counts?.unfinished ?? 0,
    rejectedReasonCounts: Object.freeze(rejectedReasonCounts),
    preview: Object.freeze({
      skippedBookCount: skipPreview && typeof result.previewSkippedBookCount === "number"
        ? result.previewSkippedBookCount
        : null,
      dispatchedChildCount: preview?.dispatched_child_count ?? 0,
      taskGroupCount: preview?.task_group_count ?? 0,
    }),
    sitemapRefresh: sitemapStatus === "queued" || sitemapStatus === "coalesced"
      || sitemapStatus === "disabled" || sitemapStatus === "failed"
      ? Object.freeze({
          status: sitemapStatus,
          triggerCount: typeof sitemap.triggerCount === "number" ? sitemap.triggerCount : 0,
          triggeredAt: typeof sitemap.triggeredAt === "string" ? sitemap.triggeredAt : "",
        })
      : null,
  });
}
