/**
 * 子任务 `article.publish.v1`：每个条目一篇文章，调用与「发布」按钮**同一个**发布核心
 * `applyPublishTransition`（`src/server/publish-gate/service.ts`）。这里不写任何
 * `Article`/`Novel` 状态，发布检查规则、审计、首次发布副作用全部由那个函数负责。
 *
 * 与按钮路径的三处差别（均为开发单明确要求，且只改"触发的次数和时机"）：
 *   1. 请求编号用 `publishBatchItemRequestId(批次编号, 文章编号)`：稳定、不含序号/随机数，
 *      所以条目被重放（租约过期重领、重试失败项）时 `applyPublishTransition` 的重放检查
 *      能认出"这一篇已经发布过"，不重复触发首次发布的副作用；
 *   2. 不逐篇派发试读（把每篇的文章编号收进本地数组，`applyPublishTransition` 不会逐篇
 *      建试读任务），整个子任务结束后由 `afterItemCommit` 合并派发一次；
 *   3. 首次发布时不逐篇触发站点地图刷新（`deferSitemapRefresh`），整批结束后触发一次。
 *   IndexNow 仍按首次发布逐篇派发，沿用现有口径。
 *
 * 为什么条目先读一次文章状态：后台任务从提交到执行之间可能隔了很久，条目执行时文章
 * 可能已经被人发布、下线或删除。按钮路径对此没有保护（人点的是眼前这一行），后台任务
 * 必须有——否则一个过期的批次会把已下线的文章重新发布出去。非草稿且不是"本条目自己
 * 已经发布过的重放"→ 跳过（`not_draft`），不算失败。
 */
import type { PrismaClient } from "@prisma/client";

import { ARTICLE_PUBLISH_TASK_TYPE } from "../../src/domain/article-publish-batch";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { finalizeArticlePublishAfterItem } from "../../src/lib/tasks/article-publish-finalize";
import { applyPublishTransition, publishBatchItemRequestId } from "../../src/server/publish-gate/service";

type Payload = {
  readonly articleId: string;
  readonly actorId: string;
  readonly batchRequestId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parse(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("article_publish_payload_invalid");
  const p = value as Record<string, unknown>;
  if (typeof p.articleId !== "string" || !UUID.test(p.articleId)
    || typeof p.actorId !== "string" || !p.actorId
    || typeof p.batchRequestId !== "string" || !p.batchRequestId) {
    throw new Error("article_publish_payload_invalid");
  }
  return { articleId: p.articleId, actorId: p.actorId, batchRequestId: p.batchRequestId };
}

export function createArticlePublishHandler(db: PrismaClient): TaskHandler {
  return async ({ lease }) => {
    if (lease.taskType !== ARTICLE_PUBLISH_TASK_TYPE) throw new Error("article_publish_lease_invalid");
    const payload = parse(lease.payload);
    const requestId = publishBatchItemRequestId(payload.batchRequestId, payload.articleId);
    const actor = { type: "admin" as const, adminId: payload.actorId };

    const article = await db.article.findFirst({
      where: { id: payload.articleId },
      select: { status: true, deletedAt: true },
    });
    if (!article || article.deletedAt) {
      return { status: "skipped", result: { outcome: "not_found", articleId: payload.articleId } };
    }
    if (article.status !== "draft") {
      // 重放识别：本条目自己（同一个稳定请求编号）已经发布过 → 让发布核心走它的重放分支，
      // 拿到与第一次一致的结果；否则就是别人改过状态，跳过。
      const own = await db.operationAudit.findFirst({
        where: {
          actorType: "admin",
          action: "article.publish",
          entityType: "Article",
          entityId: payload.articleId,
          requestId,
        },
        select: { id: true },
      });
      if (!own) {
        return {
          status: "skipped",
          result: { outcome: "not_draft", articleId: payload.articleId, articleStatus: article.status },
        };
      }
    }

    // 传入本地数组 = 告诉发布核心"试读由调用方合并派发"，它只收集、不逐篇建任务。
    const previewCollector: string[] = [];
    const result = await applyPublishTransition(
      db,
      { articleId: payload.articleId, requestId, actor },
      previewCollector,
      { deferSitemapRefresh: true },
    );
    switch (result.outcome) {
      case "published":
        return {
          status: "success",
          result: {
            outcome: "published",
            articleId: result.articleId,
            novelId: result.novelId,
            locale: result.locale,
            firstPublish: result.firstPublish,
            // false = 这是重放：这一篇早先已经发布过，本次什么都没写。
            wrote: previewCollector.length > 0,
            warnings: [...result.warnings],
          },
        };
      case "rejected":
        return {
          status: "failed",
          result: { outcome: "rejected", articleId: payload.articleId, reasons: [...result.gate.reasons] },
          error: {
            code: "publish_gate_rejected",
            message: "Publish gate rejected this article",
            detail: { reasons: result.gate.reasons.join(",") },
          },
        };
      case "not_found":
        return { status: "skipped", result: { outcome: "not_found", articleId: payload.articleId } };
      case "conflict":
        // 并发改动：发布核心已经回滚、什么都没写；重新读事实再判一次是安全的。
        return {
          status: "retry",
          result: { outcome: "conflict", articleId: payload.articleId },
          error: { code: "publish_conflict", message: "Article changed while publishing" },
        };
    }
  };
}

export function createArticlePublishWorkerHandlers(db: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  return createHandlerRegistry({
    [ARTICLE_PUBLISH_TASK_TYPE]: {
      family: "generic",
      maxAttempts: 3,
      handler: createArticlePublishHandler(db),
      afterItemCommit: (taskId) => finalizeArticlePublishAfterItem(db, taskId, { env }),
    },
  });
}
