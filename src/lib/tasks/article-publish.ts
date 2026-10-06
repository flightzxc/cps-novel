/**
 * 文章后台批量发布任务的入队与子任务建立（2026-10-06，开发单《文章批量发布后台
 * 任务_全选拆分》；设计决定见 `docs/adr/ADR-ARTICLE-PUBLISH-BATCH-TASK.md`）。
 *
 * 结构照搬 `./article-generate.ts` 的 `article.generate.batch.v2`：
 *   - 父任务 `article.publish.batch.v1`：本文件的 {@link enqueueArticlePublishParentBatch}
 *     只建父任务（一条枚举条目）；枚举与拆分在 worker 里
 *     （`worker/handlers/article-publish-batch.ts`）；
 *   - 子任务 `article.publish.v1`：{@link createArticlePublishLeafTask}，每 200 篇一个，
 *     每个条目一篇文章，由 `worker/handlers/article-publish.ts` 逐篇调用
 *     `applyPublishTransition`。
 *
 * 本文件**不**碰任何发布规则，也不写 `Article`/`Novel` 的状态：唯一能写 `published`
 * 的函数仍然只有 `src/server/publish-gate/service.ts` 的 `applyPublishTransition`。
 */
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  ARTICLE_PUBLISH_BATCH_MAX,
  ARTICLE_PUBLISH_BATCH_TARGET_TYPE,
  ARTICLE_PUBLISH_BATCH_TASK_TYPE,
  ARTICLE_PUBLISH_LEAF_MAX,
  ARTICLE_PUBLISH_TARGET_TYPE,
  ARTICLE_PUBLISH_TASK_TYPE,
  ARTICLE_PUBLISH_TTL_MS,
  ArticlePublishInputError,
  normalizeArticlePublishFilter,
  type ArticlePublishFilter,
} from "@/domain/article-publish-batch";
import { isUniqueConstraintViolation } from "@/lib/db/db-retry";

export {
  ARTICLE_PUBLISH_BATCH_MAX,
  ARTICLE_PUBLISH_BATCH_TARGET_TYPE,
  ARTICLE_PUBLISH_BATCH_TASK_TYPE,
  ARTICLE_PUBLISH_LEAF_MAX,
  ARTICLE_PUBLISH_TARGET_TYPE,
  ARTICLE_PUBLISH_TASK_TYPE,
  ARTICLE_PUBLISH_TTL_MS,
  ArticlePublishInputError,
};

export type ArticlePublishParentPayload = Readonly<{
  filter: ArticlePublishFilter;
  /** 「发布时暂不抓试读」：true 时整批不建试读抓取任务，父任务结果里记录跳过的本数。 */
  skipPreview: boolean;
  /** 提交人。worker 以该管理员身份发布，审计里 actor 写的就是它。 */
  actorId: string;
  /** 批次编号：每篇文章的请求编号由 `publishBatchItemRequestId(requestId, articleId)` 派生。 */
  requestId: string;
  /** 提交时筛选里的草稿篇数（仅作展示/审计参考，实际范围以枚举为准）。 */
  estimatedDraftCount: number;
  submittedAt: string;
  expiresAt: string;
}>;

export type ArticlePublishEnqueueResult = Readonly<{
  taskId: string;
  duplicate: boolean;
  taskStatus: "pending";
}>;

/** 批次编号长度上限：160（`operation_audit.request_id`）减去 `:` 与文章 UUID（37）再留余量。 */
export const ARTICLE_PUBLISH_REQUEST_ID_MAX_LENGTH = 100;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function articlePublishParentScopeHash(filter: ArticlePublishFilter, skipPreview: boolean): string {
  return sha256(JSON.stringify({ filter, skipPreview }));
}

export async function enqueueArticlePublishParentBatch(
  db: PrismaClient,
  input: {
    readonly filter: unknown;
    readonly skipPreview?: boolean;
    readonly actorId: string;
    readonly requestId: string;
    /** 调用方用同一份 WHERE 数出的草稿篇数；这里只校验上限与非空，不重新数。 */
    readonly draftCount: number;
  },
  now = new Date(),
): Promise<ArticlePublishEnqueueResult> {
  const filter = normalizeArticlePublishFilter(input.filter);
  const skipPreview = input.skipPreview === true;
  // `operation_audit.request_id` 是 VARCHAR(160)，每篇的派生编号是 `批次:文章UUID`（+37）。
  if (typeof input.actorId !== "string" || !input.actorId
    || typeof input.requestId !== "string" || !input.requestId
    || input.requestId.length > ARTICLE_PUBLISH_REQUEST_ID_MAX_LENGTH) {
    throw new ArticlePublishInputError("request_invalid");
  }
  if (!Number.isSafeInteger(input.draftCount) || input.draftCount < 0) {
    throw new ArticlePublishInputError("draft_count_invalid");
  }
  if (input.draftCount === 0) throw new ArticlePublishInputError("no_draft_in_filter");
  if (input.draftCount > ARTICLE_PUBLISH_BATCH_MAX) throw new ArticlePublishInputError("selection_too_large");

  const canonicalInput = { filter, skipPreview, actorId: input.actorId, requestId: input.requestId };
  const inputFingerprint = sha256(JSON.stringify(canonicalInput));
  const requestToken = `article_publish_batch:${sha256(`${input.actorId}\n${input.requestId}`)}`;
  const existing = await db.genericTask.findUnique({
    where: { requestToken },
    select: { id: true, params: true },
  });
  if (existing) {
    const params = existing.params as Record<string, unknown>;
    if (params.inputFingerprint !== inputFingerprint) throw new ArticlePublishInputError("request_replay_mismatch");
    return { taskId: existing.id, duplicate: true, taskStatus: "pending" };
  }

  const taskId = randomUUID();
  const payload: ArticlePublishParentPayload = {
    ...canonicalInput,
    estimatedDraftCount: input.draftCount,
    submittedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ARTICLE_PUBLISH_TTL_MS).toISOString(),
  };
  try {
    await db.$transaction(async (tx) => {
      await tx.genericTask.create({
        data: {
          id: taskId,
          taskType: ARTICLE_PUBLISH_BATCH_TASK_TYPE,
          operationScopeHash: articlePublishParentScopeHash(filter, skipPreview),
          mode: "apply",
          status: "pending",
          requestToken,
          totalCount: 1,
          params: { ...(payload as unknown as Prisma.InputJsonObject), inputFingerprint },
          items: {
            create: {
              targetType: ARTICLE_PUBLISH_BATCH_TARGET_TYPE,
              targetId: taskId,
              payload: payload as unknown as Prisma.InputJsonObject,
            },
          },
        },
      });
      await tx.operationAudit.create({
        data: {
          actorType: "admin",
          actorId: input.actorId,
          action: "article_publish_batch.queued",
          entityType: "GenericTask",
          entityId: taskId,
          requestId: input.requestId,
          taskType: ARTICLE_PUBLISH_BATCH_TASK_TYPE,
          taskId,
          afterSnapshot: {
            filter,
            skipPreview,
            estimatedDraftCount: input.draftCount,
            expiresAt: payload.expiresAt,
          },
        },
      });
    });
    return { taskId, duplicate: false, taskStatus: "pending" };
  } catch (error) {
    const replay = await db.genericTask.findUnique({
      where: { requestToken },
      select: { id: true, params: true },
    });
    if (replay) {
      const params = replay.params as Record<string, unknown>;
      if (params.inputFingerprint !== inputFingerprint) throw new ArticlePublishInputError("request_replay_mismatch");
      return { taskId: replay.id, duplicate: true, taskStatus: "pending" };
    }
    // 同一份筛选的另一个批次还在枚举（活跃 scope 唯一索引）：明确告诉调用方，而不是裸抛 P2002。
    if (isUniqueConstraintViolation(error)) throw new ArticlePublishInputError("batch_already_queued");
    throw error;
  }
}

export type ArticlePublishLeafParams = Readonly<{
  actorId: string;
  batchRequestId: string;
  skipPreview: boolean;
  parentTaskId: string;
  articleCount: number;
  submittedAt: string;
}>;

export function articlePublishChildToken(parentTaskId: string, afterId: string): string {
  return `article_publish_child:${sha256(`${parentTaskId}\n${afterId}`)}`;
}

/**
 * 在父任务的枚举事务里建一个子任务（≤ {@link ARTICLE_PUBLISH_LEAF_MAX} 篇）。
 * `operationScopeHash` 带上父任务编号：活跃 scope 唯一索引不会因为两个不同批次
 * 恰好枚举出同一组文章而让后一个批次的整个枚举事务失败。
 */
export async function createArticlePublishLeafTask(
  tx: Prisma.TransactionClient,
  input: {
    readonly taskId: string;
    readonly parentTaskId: string;
    readonly requestToken: string;
    readonly articleIds: readonly string[];
    readonly actorId: string;
    readonly batchRequestId: string;
    readonly skipPreview: boolean;
    readonly submittedAt: string;
  },
): Promise<void> {
  if (input.articleIds.length === 0 || input.articleIds.length > ARTICLE_PUBLISH_LEAF_MAX) {
    throw new ArticlePublishInputError("leaf_size_invalid");
  }
  const params: ArticlePublishLeafParams = {
    actorId: input.actorId,
    batchRequestId: input.batchRequestId,
    skipPreview: input.skipPreview,
    parentTaskId: input.parentTaskId,
    articleCount: input.articleIds.length,
    submittedAt: input.submittedAt,
  };
  await tx.genericTask.create({
    data: {
      id: input.taskId,
      parentTaskId: input.parentTaskId,
      taskType: ARTICLE_PUBLISH_TASK_TYPE,
      operationScopeHash: sha256(JSON.stringify({ parentTaskId: input.parentTaskId, articleIds: [...input.articleIds].sort() })),
      mode: "apply",
      status: "pending",
      requestToken: input.requestToken,
      totalCount: input.articleIds.length,
      params: params as unknown as Prisma.InputJsonObject,
      items: {
        create: input.articleIds.map((articleId) => ({
          targetType: ARTICLE_PUBLISH_TARGET_TYPE,
          targetId: articleId,
          payload: {
            articleId,
            actorId: input.actorId,
            batchRequestId: input.batchRequestId,
            skipPreview: input.skipPreview,
          } as Prisma.InputJsonObject,
        })),
      },
    },
  });
}
