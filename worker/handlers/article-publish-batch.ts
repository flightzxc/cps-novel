/**
 * 父任务 `article.publish.batch.v1`：按提交时的筛选快照枚举草稿，每
 * {@link ARTICLE_PUBLISH_LEAF_MAX} 篇拆成一个子任务 `article.publish.v1`。结构照搬
 * `./article-generate-batch.ts` 的 v2 路径（单事务枚举 + 建子任务，父任务自己的条目
 * 在事务里一并落库）。
 *
 * 枚举复用文章列表页的同一个 WHERE（`listArticleIdsForFilter`，按 id 键集游标翻页，
 * 不会因为"发布改了 updatedAt"而漏行或重复），只是把状态固定为 `draft`。枚举不预判
 * 发布检查：能不能发由每个条目执行时的发布核心逐篇判定（失败带原因，可重试）。
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  ARTICLE_PUBLISH_BATCH_MAX,
  ARTICLE_PUBLISH_BATCH_TASK_TYPE,
  ARTICLE_PUBLISH_LEAF_MAX,
  normalizeArticlePublishFilter,
} from "../../src/domain/article-publish-batch";
import {
  articlePublishChildToken,
  createArticlePublishLeafTask,
} from "../../src/lib/tasks/article-publish";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { listArticleIdsForFilter } from "../../src/server/articles";

function parseEnvelope(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("article_publish_batch_payload_invalid");
  const p = value as Record<string, unknown>;
  if (typeof p.actorId !== "string" || !p.actorId || typeof p.requestId !== "string" || !p.requestId
    || typeof p.submittedAt !== "string" || !Number.isFinite(Date.parse(p.submittedAt))
    || typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt))
    || typeof p.skipPreview !== "boolean"
    || !p.filter || typeof p.filter !== "object" || Array.isArray(p.filter)) {
    throw new Error("article_publish_batch_payload_invalid");
  }
  return {
    actorId: p.actorId,
    requestId: p.requestId,
    submittedAt: p.submittedAt,
    expiresAt: p.expiresAt,
    skipPreview: p.skipPreview,
    // 重新归一一遍持久化的快照，而不是原样信任：被手改过或来自未来版本的行
    // 不会让枚举范围悄悄变宽（未知键直接抛错）。
    filter: normalizeArticlePublishFilter(p.filter),
  };
}

export function createArticlePublishBatchHandler(db: PrismaClient): TaskHandler {
  void db;
  return async ({ lease }) => {
    if (lease.taskType !== ARTICLE_PUBLISH_BATCH_TASK_TYPE || lease.itemId === "") {
      throw new Error("article_publish_batch_lease_invalid");
    }
    const payload = parseEnvelope(lease.payload);
    return {
      status: "success",
      transactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      transactionTimeoutMs: 300_000,
      protectedWrite: async (tx) => {
        const expiry = Date.parse(payload.expiresAt);
        if (!Number.isFinite(expiry) || Date.now() >= expiry) {
          const expired = {
            enumerationStatus: "expired", selectedCount: 0, submittedCount: 0, childTaskCount: 0,
            skipPreview: payload.skipPreview,
          };
          await tx.genericTask.update({ where: { id: lease.taskId }, data: { result: expired } });
          return { status: "skipped", result: { enumerationStatus: "expired" } };
        }

        let after: string | undefined;
        let selectedCount = 0;
        let childTaskCount = 0;
        let truncated = false;
        for (;;) {
          const page = await listArticleIdsForFilter(tx, {
            ...payload.filter,
            status: "draft",
            ...(after ? { afterId: after } : {}),
            limit: ARTICLE_PUBLISH_LEAF_MAX,
          });
          if (page.articleIds.length === 0) break;
          // 全选上限的兜底：提交时已按 50,000 校验过，这里防的是提交之后草稿又涨了。
          const room = ARTICLE_PUBLISH_BATCH_MAX - selectedCount;
          if (room <= 0) { truncated = true; break; }
          const articleIds = page.articleIds.slice(0, room);
          await createArticlePublishLeafTask(tx, {
            taskId: randomUUID(),
            parentTaskId: lease.taskId,
            requestToken: articlePublishChildToken(lease.taskId, after ?? "start"),
            articleIds,
            actorId: payload.actorId,
            batchRequestId: payload.requestId,
            skipPreview: payload.skipPreview,
            submittedAt: payload.submittedAt,
          });
          selectedCount += articleIds.length;
          childTaskCount += 1;
          if (articleIds.length < page.articleIds.length) { truncated = true; break; }
          if (page.nextCursor === null) break;
          after = page.nextCursor;
        }

        const result = {
          enumerationStatus: "completed",
          selectedCount,
          submittedCount: selectedCount,
          childTaskCount,
          skipPreview: payload.skipPreview,
          ...(truncated ? { truncated: true } : {}),
          expiresAt: payload.expiresAt,
        };
        await tx.genericTask.update({ where: { id: lease.taskId }, data: { result } });
        await tx.operationAudit.create({
          data: {
            actorType: "worker",
            actorId: lease.workerId,
            action: "article_publish_batch.enumerated",
            entityType: "GenericTask",
            entityId: lease.taskId,
            requestId: payload.requestId,
            taskType: ARTICLE_PUBLISH_BATCH_TASK_TYPE,
            taskId: lease.taskId,
            afterSnapshot: { selectedCount, childTaskCount, skipPreview: payload.skipPreview, truncated },
          },
        });
        return { status: "success", result: { enumerationStatus: "completed", selectedCount, childTaskCount } };
      },
    };
  };
}

export function createArticlePublishBatchWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({
    [ARTICLE_PUBLISH_BATCH_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler: createArticlePublishBatchHandler(db) },
  });
}
