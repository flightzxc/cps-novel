/**
 * 后台批量发布批次的"整批"暂停 / 恢复 / 中止 / 重试失败项（2026-10-06）。
 *
 * 为什么需要它：批量发布父任务自己只有一条枚举条目，枚举做完它的原始 `status` 就变成
 * `completed`，真正在跑的是名下几十到几百个子任务（每 200 篇一个）。现有的单任务
 * 暂停/中止只作用于**一个**任务，建稿批次（`article.generate.batch.v2`）的做法是让
 * 运营到子任务列表里逐个点——发布批次要是 146 个子任务，"暂停"就要点 146 次，起不到
 * 暂停的作用。所以对**这一种**父任务类型，把现有的 pause/resume/abort/retry-failed 四个
 * 动作级联到它名下的子任务；其它任务类型的行为一个字不变。
 *
 * 语义逐条沿用任务管理后台里单任务版本的 `pauseTask` / `resumeTask` / `abortTask` / `retryFailedTask`：
 *   - 暂停：子任务置 `paused`；还是 `pending` 的条目原样保留；`processing` 的条目照常跑完；
 *   - 恢复：只恢复 `paused` 的子任务；
 *   - 中止：不可逆；子任务置 `cancelled`，还是 `pending` 的条目一律标记 `skipped`
 *     （"中止前从未尝试"），已发布 / 已失败 / 已跳过的条目历史不动；
 *   - 重试失败项：只把 `failed` 条目重置为 `pending`；已发布的文章不会被重复发布——
 *     条目重放走的是 `applyPublishTransition` 的稳定请求编号重放分支。
 *
 * 本模块只做"批次 ↔ 子任务"的状态级联与写库，不做 2FA / 幂等重放 / 审计（那些是
 * 任务管理后台 mutation service 的职责；这一层不认识、也不应该 import 那个模块——
 * `worker/`、`scheduler/`、`src/lib/tasks/` 有文本守卫禁止出现它的导入路径）。
 * 所以函数都从不抛业务错误，只返回被影响的子任务数，由调用方判断 0 = 状态冲突。
 */
import { Prisma } from "@prisma/client";

import { ARTICLE_PUBLISH_TASK_TYPE } from "@/domain/article-publish-batch";

import { PROMO_CLAIM_BATCH_ABORT_TERMINATION_REASON } from "./promo-claim-batch-control";
import { recomputeParentTask } from "./store";
import { terminatePendingTaskItems } from "./task-termination";
import type { TaskControlMarker } from "./task-control";

type TxClient = Prisma.TransactionClient;

export type ArticlePublishBatchPauseResult = Readonly<{ affectedChildCount: number }>;
export type ArticlePublishBatchResumeResult = Readonly<{ affectedChildCount: number }>;
export type ArticlePublishBatchAbortResult = Readonly<{
  affectedChildCount: number;
  terminatedPendingItemCount: number;
}>;
export type ArticlePublishBatchRetryResult = Readonly<{
  affectedChildCount: number;
  retriedItemCount: number;
}>;

async function lockChildren(
  tx: TxClient,
  parentTaskId: string,
  statuses: readonly string[],
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM generic_task
    WHERE parent_task_id = ${parentTaskId}::uuid AND task_type = ${ARTICLE_PUBLISH_TASK_TYPE}
      AND status = ANY(${statuses}::text[])
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  `);
  return rows.map((row) => row.id);
}

/** 与 `mergeTaskControlResult` 同一形状：控制标记合并进 `result.taskControl`，不覆盖别的键。 */
function markerPatch(marker: TaskControlMarker): string {
  return JSON.stringify({ taskControl: { ...marker } });
}

export async function pauseArticlePublishBatchTx(
  tx: TxClient,
  parentTaskId: string,
  marker: TaskControlMarker,
): Promise<ArticlePublishBatchPauseResult> {
  const ids = await lockChildren(tx, parentTaskId, ["pending", "processing"]);
  if (ids.length === 0) return { affectedChildCount: 0 };
  const affected = await tx.$executeRaw(Prisma.sql`
    UPDATE generic_task
    SET status = 'paused',
        result = COALESCE(result, '{}'::jsonb) || ${markerPatch(marker)}::jsonb,
        updated_at = transaction_timestamp()
    WHERE id = ANY(${ids}::uuid[]) AND status IN ('pending', 'processing')
  `);
  return { affectedChildCount: affected };
}

export async function resumeArticlePublishBatchTx(
  tx: TxClient,
  parentTaskId: string,
): Promise<ArticlePublishBatchResumeResult> {
  const ids = await lockChildren(tx, parentTaskId, ["paused"]);
  if (ids.length === 0) return { affectedChildCount: 0 };
  const affected = await tx.$executeRaw(Prisma.sql`
    UPDATE generic_task
    SET status = 'pending', updated_at = transaction_timestamp()
    WHERE id = ANY(${ids}::uuid[]) AND status = 'paused'
  `);
  // 暂停期间最后一个在途条目可能已经跑完：此时子任务恢复成 `pending` 却没有任何条目可领，
  // 会永远显示"待处理"。没有未完成条目的，按条目计数重新推导一次终态。
  for (const id of ids) {
    const open = await tx.genericTaskItem.count({
      where: { taskId: id, status: { in: ["pending", "processing"] } },
    });
    if (open === 0) await recomputeParentTask(tx, "generic", id);
  }
  return { affectedChildCount: affected };
}

export async function abortArticlePublishBatchTx(
  tx: TxClient,
  parentTaskId: string,
  marker: TaskControlMarker,
): Promise<ArticlePublishBatchAbortResult> {
  const ids = await lockChildren(tx, parentTaskId, ["pending", "processing", "paused"]);
  let terminated = 0;
  for (const id of ids) {
    const { terminatedCount } = await terminatePendingTaskItems(tx, "generic", id, {
      code: PROMO_CLAIM_BATCH_ABORT_TERMINATION_REASON,
      message: "Task was manually aborted before this item was ever attempted",
    });
    terminated += terminatedCount;
    await tx.$executeRaw(Prisma.sql`
      UPDATE generic_task
      SET status = 'cancelled',
          result = COALESCE(result, '{}'::jsonb) || ${markerPatch({ ...marker, terminatedPendingItemCount: terminatedCount })}::jsonb,
          updated_at = transaction_timestamp()
      WHERE id = ${id}::uuid
    `);
  }
  return { affectedChildCount: ids.length, terminatedPendingItemCount: terminated };
}

export async function retryFailedArticlePublishBatchTx(
  tx: TxClient,
  parentTaskId: string,
): Promise<ArticlePublishBatchRetryResult> {
  const candidates = await lockChildren(tx, parentTaskId, ["failed", "completed_with_errors"]);
  let affectedChildCount = 0;
  let retriedItemCount = 0;
  for (const id of candidates) {
    const retried = (await tx.genericTaskItem.updateMany({
      where: { taskId: id, status: "failed" },
      data: {
        status: "pending", executionToken: null, lockedBy: null, lockedUntil: null,
        heartbeatAt: null, result: Prisma.DbNull, error: Prisma.DbNull, finishedAt: null,
      },
    })).count;
    if (retried === 0) continue;
    affectedChildCount += 1;
    retriedItemCount += retried;
    const [total, success, failed, skipped] = await Promise.all([
      tx.genericTaskItem.count({ where: { taskId: id } }),
      tx.genericTaskItem.count({ where: { taskId: id, status: "success" } }),
      tx.genericTaskItem.count({ where: { taskId: id, status: "failed" } }),
      tx.genericTaskItem.count({ where: { taskId: id, status: "skipped" } }),
    ]);
    // 与单任务重试同一形状：子任务回到 pending，计数按条目重新数，完成时刻清空；
    // `result` 保留（里面的试读派发水位线要留着，补发只针对新发布的文章）。
    await tx.genericTask.update({
      where: { id },
      data: {
        status: "pending", totalCount: total, successCount: success, failedCount: failed,
        skippedCount: skipped, completedAt: null, error: Prisma.DbNull,
      },
    });
  }
  return { affectedChildCount, retriedItemCount };
}
