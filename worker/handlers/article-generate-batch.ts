import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  articleGenerateEligibleWhere,
  resolveArticleGenerateAdmissions,
} from "../../src/server/content-creation/eligibility";
import {
  ARTICLE_GENERATE_BATCH_TASK_TYPE,
  ARTICLE_GENERATE_LEAF_MAX,
  ARTICLE_GENERATE_TASK_TYPE,
  createArticleGenerateLeafTask,
  type ArticleGenerateParentPayload,
} from "../../src/lib/tasks/article-generate";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";

function parsePayload(value: unknown): ArticleGenerateParentPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("article_generate_batch_payload_invalid");
  }
  const p = value as Partial<ArticleGenerateParentPayload>;
  if (typeof p.actorId !== "string" || !p.actorId || typeof p.requestId !== "string" || !p.requestId
    || typeof p.submittedAt !== "string" || !Number.isFinite(Date.parse(p.submittedAt))
    || typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt))
    || !p.filter || typeof p.filter !== "object") {
    throw new Error("article_generate_batch_payload_invalid");
  }
  return p as ArticleGenerateParentPayload;
}

function childToken(parentId: string, afterId: string): string {
  return `article_generate_child:${createHash("sha256").update(`${parentId}\n${afterId}`).digest("hex")}`;
}

export function createArticleGenerateBatchHandler(db: PrismaClient): TaskHandler {
  void db;
  return async ({ lease }) => {
    if (lease.taskType !== ARTICLE_GENERATE_BATCH_TASK_TYPE || lease.itemId === "") {
      throw new Error("article_generate_batch_lease_invalid");
    }
    const payload = parsePayload(lease.payload);
    return {
      status: "success",
      transactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      transactionTimeoutMs: 120_000,
      protectedWrite: async (tx) => {
        const expiry = Date.parse(payload.expiresAt);
        if (!Number.isFinite(expiry) || Date.now() >= expiry) {
          await tx.genericTask.update({
            where: { id: lease.taskId },
            data: { result: {
              enumerationStatus: "expired",
              selectedCount: 0,
              submittedCount: 0,
              blockedCount: 0,
              blockedReasonCounts: {},
              childTaskCount: 0,
            } },
          });
          return { status: "skipped", result: { enumerationStatus: "expired" } };
        }

        const where = articleGenerateEligibleWhere(payload.filter);
        let after: string | undefined;
        let selectedCount = 0;
        let submittedCount = 0;
        let childTaskCount = 0;
        const blockedReasonCounts: Record<string, number> = {};
        const templates = payload.templateKeysByLocale;
        while (true) {
          const rows = await tx.novel.findMany({
            where: {
              ...where,
              ...(after ? { id: { gt: after } } : {}),
            },
            orderBy: { id: "asc" },
            take: ARTICLE_GENERATE_LEAF_MAX,
            select: {
              id: true,
              title: true,
              locale: true,
              businessId: true,
              deletedAt: true,
              articles: { select: { id: true, locale: true, deletedAt: true } },
            },
          });
          if (rows.length === 0) break;
          const pageNovelIds = rows.map((row) => row.id);
          selectedCount += pageNovelIds.length;
          const admissions = await resolveArticleGenerateAdmissions(tx, pageNovelIds, rows);
          const readyNovelIds = pageNovelIds.filter((novelId) => {
            const admission = admissions.get(novelId)!;
            if (admission.canGenerate) return true;
            if (admission.blockedReason) {
              blockedReasonCounts[admission.blockedReason] = (blockedReasonCounts[admission.blockedReason] ?? 0) + 1;
            }
            return false;
          });
          if (readyNovelIds.length > 0) {
            const childId = randomUUID();
            const leafPayload = {
              novelIds: readyNovelIds,
              actorId: payload.actorId,
              requestId: `${payload.requestId}:${childTaskCount}`,
              submittedAt: payload.submittedAt,
              expiresAt: payload.expiresAt,
              ...(templates ? { templateKeysByLocale: templates } : {}),
            };
            await createArticleGenerateLeafTask(tx, {
              taskId: childId,
              parentTaskId: lease.taskId,
              requestToken: childToken(lease.taskId, after ?? "start"),
              novelIds: readyNovelIds,
              actorId: payload.actorId,
              requestId: payload.requestId,
              inputFingerprint: createHash("sha256").update(JSON.stringify(leafPayload)).digest("hex"),
              payload: leafPayload,
              templates,
            });
            submittedCount += readyNovelIds.length;
            childTaskCount += 1;
          }
          after = rows.at(-1)!.id;
          if (rows.length < ARTICLE_GENERATE_LEAF_MAX) break;
        }

        await tx.genericTask.update({
          where: { id: lease.taskId },
          data: {
            result: {
              enumerationStatus: "completed",
              selectedCount,
              submittedCount,
              blockedCount: selectedCount - submittedCount,
              blockedReasonCounts,
              childTaskCount,
              expiresAt: payload.expiresAt,
            },
          },
        });
        return {
          status: "success",
          result: {
            enumerationStatus: "completed",
            selectedCount,
            submittedCount,
            blockedCount: selectedCount - submittedCount,
            blockedReasonCounts,
            childTaskCount,
          },
        };
      },
    };
  };
}

export function createArticleGenerateBatchWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({
    [ARTICLE_GENERATE_BATCH_TASK_TYPE]: {
      family: "generic",
      maxAttempts: 3,
      handler: createArticleGenerateBatchHandler(db),
    },
  });
}

export const ARTICLE_GENERATE_CHILD_TASK_TYPE = ARTICLE_GENERATE_TASK_TYPE;
