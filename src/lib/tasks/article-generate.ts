import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  ARTICLE_GENERATE_UUID,
  normalizeArticleGenerateFilter,
  type ArticleGenerateBlockedReason,
  type NormalizedArticleGenerateFilter,
} from "@/domain/article-generation";
import { resolveArticleGenerateAdmissions } from "@/server/content-creation/eligibility";

export const ARTICLE_GENERATE_TASK_TYPE = "article.generate.v1";
export const ARTICLE_GENERATE_BATCH_TASK_TYPE = "article.generate.batch.v1";
export const ARTICLE_GENERATE_TARGET_TYPE = "novel";
export const ARTICLE_GENERATE_BATCH_TARGET_TYPE = "article_generate_filter";
export const ARTICLE_GENERATE_TTL_MS = 6 * 60 * 60 * 1_000;
export const ARTICLE_GENERATE_CHUNK_SIZE = 50;
export const ARTICLE_GENERATE_LEAF_MAX = 200;

export type ArticleGenerateBatchPayload = Readonly<{
  novelIds: readonly string[];
  actorId: string;
  requestId: string;
  submittedAt: string;
  expiresAt: string;
  templateKeysByLocale?: Readonly<Record<string, string>>;
}>;

export type ArticleGenerateParentPayload = Readonly<{
  filter: NormalizedArticleGenerateFilter;
  actorId: string;
  requestId: string;
  submittedAt: string;
  expiresAt: string;
  templateKeysByLocale?: Readonly<Record<string, string>>;
}>;

export type ArticleGenerateAdmissionSummary = Readonly<{
  selectedCount: number;
  submittedCount: number;
  blockedCount: number;
  blockedReasonCounts: Readonly<Partial<Record<ArticleGenerateBlockedReason, number>>>;
}>;

export type ArticleGenerateEnqueueResult = Readonly<{
  taskId: string;
  duplicate: boolean;
  taskStatus: "pending" | "completed_with_errors";
  admission: ArticleGenerateAdmissionSummary;
}>;

export class ArticleGenerateInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ArticleGenerateInputError";
  }
}

function ordered(record?: Readonly<Record<string, string>>): Record<string, string> | undefined {
  return record
    ? Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
    : undefined;
}

export function normalizeArticleGenerateNovelIds(novelIds: readonly string[]): readonly string[] {
  if (!Array.isArray(novelIds) || novelIds.some((id) => typeof id !== "string")) {
    throw new ArticleGenerateInputError("novel_ids_invalid");
  }
  const ids = Array.from(new Set(novelIds.map((id) => id.trim().toLowerCase()))).sort();
  if (ids.length === 0) throw new ArticleGenerateInputError("novel_ids_required");
  if (ids.length > ARTICLE_GENERATE_LEAF_MAX) throw new ArticleGenerateInputError("novel_ids_too_many");
  if (ids.some((id) => !ARTICLE_GENERATE_UUID.test(id))) throw new ArticleGenerateInputError("novel_id_invalid");
  return Object.freeze(ids);
}

export function articleGenerateScopeHash(novelIds: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...novelIds].sort())).digest("hex");
}

export function articleGenerateParentScopeHash(filter: NormalizedArticleGenerateFilter): string {
  return createHash("sha256").update(JSON.stringify(filter)).digest("hex");
}

function admissionSummaryFromResult(
  value: unknown,
  fallbackSelectedCount: number,
): ArticleGenerateAdmissionSummary {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const selectedCount = typeof result.selectedCount === "number" ? result.selectedCount : fallbackSelectedCount;
  const submittedCount = typeof result.submittedCount === "number" ? result.submittedCount : selectedCount;
  const rawReasons = result.blockedReasonCounts && typeof result.blockedReasonCounts === "object"
    && !Array.isArray(result.blockedReasonCounts)
    ? result.blockedReasonCounts as Record<string, unknown>
    : {};
  const allowedReasons = new Set<ArticleGenerateBlockedReason>([
    "novel_not_found",
    "novel_deleted",
    "already_exists",
    "article_soft_deleted",
    "promo_link_missing",
    "promo_link_not_ready",
    "promo_link_deleted",
  ]);
  const blockedReasonCounts = Object.fromEntries(
    Object.entries(rawReasons).filter((entry): entry is [ArticleGenerateBlockedReason, number] =>
      allowedReasons.has(entry[0] as ArticleGenerateBlockedReason)
      && typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0),
  );
  return Object.freeze({
    selectedCount,
    submittedCount,
    blockedCount: Object.values(blockedReasonCounts).reduce((sum, count) => sum + count, 0),
    blockedReasonCounts: Object.freeze(blockedReasonCounts),
  });
}

function taskStatusOf(value: string): "pending" | "completed_with_errors" {
  return value === "completed_with_errors" ? "completed_with_errors" : "pending";
}

export async function enqueueArticleGenerateBatch(
  db: PrismaClient,
  input: {
    readonly novelIds: readonly string[];
    readonly actorId: string;
    readonly requestId: string;
    readonly templateKeysByLocale?: Readonly<Record<string, string>>;
  },
  now = new Date(),
): Promise<ArticleGenerateEnqueueResult> {
  const novelIds = normalizeArticleGenerateNovelIds(input.novelIds);
  const templates = ordered(input.templateKeysByLocale);
  const canonicalInput = {
    novelIds,
    actorId: input.actorId,
    requestId: input.requestId,
    ...(templates ? { templateKeysByLocale: templates } : {}),
  };
  const inputFingerprint = createHash("sha256").update(JSON.stringify(canonicalInput)).digest("hex");
  const requestToken = `article_generate:${createHash("sha256").update(`${input.actorId}\n${input.requestId}`).digest("hex")}`;
  const existing = await db.genericTask.findUnique({
    where: { requestToken },
    select: { id: true, params: true, status: true, result: true },
  });
  if (existing) {
    const params = existing.params as Record<string, unknown>;
    if (params.inputFingerprint !== inputFingerprint) {
      throw new ArticleGenerateInputError("request_replay_mismatch");
    }
    return {
      taskId: existing.id,
      duplicate: true,
      taskStatus: taskStatusOf(existing.status),
      admission: admissionSummaryFromResult(existing.result, novelIds.length),
    };
  }

  const taskId = randomUUID();
  const payload: ArticleGenerateBatchPayload = {
    ...canonicalInput,
    submittedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ARTICLE_GENERATE_TTL_MS).toISOString(),
  };

  try {
    const admission = await db.$transaction(async (tx) => {
      const novels = await tx.novel.findMany({
        where: { id: { in: [...novelIds] } },
        select: {
          id: true,
          title: true,
          locale: true,
          businessId: true,
          deletedAt: true,
          articles: { select: { id: true, locale: true, deletedAt: true } },
        },
      });
      const admissions = await resolveArticleGenerateAdmissions(tx, novelIds, novels);
      const readyNovelIds: string[] = [];
      const blockedReasonCounts: Partial<Record<ArticleGenerateBlockedReason, number>> = {};
      for (const novelId of novelIds) {
        const item = admissions.get(novelId)!;
        if (item.canGenerate) {
          readyNovelIds.push(novelId);
        } else if (item.blockedReason) {
          blockedReasonCounts[item.blockedReason] = (blockedReasonCounts[item.blockedReason] ?? 0) + 1;
        }
      }
      const summary: ArticleGenerateAdmissionSummary = Object.freeze({
        selectedCount: novelIds.length,
        submittedCount: readyNovelIds.length,
        blockedCount: novelIds.length - readyNovelIds.length,
        blockedReasonCounts: Object.freeze(blockedReasonCounts),
      });
      const admittedPayload: ArticleGenerateBatchPayload = {
        ...payload,
        novelIds: readyNovelIds,
      };
      await createArticleGenerateLeafTask(tx, {
        taskId,
        parentTaskId: null,
        requestToken,
        novelIds: readyNovelIds,
        actorId: input.actorId,
        requestId: input.requestId,
        inputFingerprint,
        payload: admittedPayload,
        templates,
        admission: summary,
        now,
      });
      return summary;
    });
    return {
      taskId,
      duplicate: false,
      taskStatus: admission.submittedCount === 0 ? "completed_with_errors" : "pending",
      admission,
    };
  } catch (error) {
    const replay = await db.genericTask.findUnique({
      where: { requestToken },
      select: { id: true, params: true, status: true, result: true },
    });
    if (replay) {
      const params = replay.params as Record<string, unknown>;
      if (params.inputFingerprint !== inputFingerprint) {
        throw new ArticleGenerateInputError("request_replay_mismatch");
      }
      return {
        taskId: replay.id,
        duplicate: true,
        taskStatus: taskStatusOf(replay.status),
        admission: admissionSummaryFromResult(replay.result, novelIds.length),
      };
    }
    throw error;
  }
}

export async function enqueueArticleGenerateParentBatch(
  db: PrismaClient,
  input: {
    readonly filter: NormalizedArticleGenerateFilter;
    readonly actorId: string;
    readonly requestId: string;
    readonly templateKeysByLocale?: Readonly<Record<string, string>>;
  },
  now = new Date(),
): Promise<{ taskId: string; duplicate: boolean; taskStatus: "pending" }> {
  const filter = normalizeArticleGenerateFilter(input.filter);
  const templates = ordered(input.templateKeysByLocale);
  const canonicalInput = {
    filter,
    actorId: input.actorId,
    requestId: input.requestId,
    ...(templates ? { templateKeysByLocale: templates } : {}),
  };
  const inputFingerprint = createHash("sha256").update(JSON.stringify(canonicalInput)).digest("hex");
  const requestToken = `article_generate_batch:${createHash("sha256").update(`${input.actorId}\n${input.requestId}`).digest("hex")}`;
  const existing = await db.genericTask.findUnique({
    where: { requestToken },
    select: { id: true, params: true, status: true },
  });
  if (existing) {
    const params = existing.params as Record<string, unknown>;
    if (params.inputFingerprint !== inputFingerprint) {
      throw new ArticleGenerateInputError("request_replay_mismatch");
    }
    return { taskId: existing.id, duplicate: true, taskStatus: "pending" };
  }

  const taskId = randomUUID();
  const payload: ArticleGenerateParentPayload = {
    ...canonicalInput,
    submittedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ARTICLE_GENERATE_TTL_MS).toISOString(),
  };

  try {
    await db.$transaction(async (tx) => {
      await tx.genericTask.create({
        data: {
          id: taskId,
          taskType: ARTICLE_GENERATE_BATCH_TASK_TYPE,
          operationScopeHash: articleGenerateParentScopeHash(filter),
          mode: "apply",
          status: "pending",
          requestToken,
          totalCount: 1,
          params: { ...(payload as unknown as Prisma.InputJsonObject), inputFingerprint },
          items: {
            create: {
              targetType: ARTICLE_GENERATE_BATCH_TARGET_TYPE,
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
          action: "article_generate_batch.queued",
          entityType: "GenericTask",
          entityId: taskId,
          requestId: input.requestId,
          taskType: ARTICLE_GENERATE_BATCH_TASK_TYPE,
          taskId,
          afterSnapshot: { filter, expiresAt: payload.expiresAt },
        },
      });
    });
    return { taskId, duplicate: false, taskStatus: "pending" };
  } catch (error) {
    const replay = await db.genericTask.findUnique({
      where: { requestToken },
      select: { id: true, params: true, status: true },
    });
    if (replay) {
      const params = replay.params as Record<string, unknown>;
      if (params.inputFingerprint !== inputFingerprint) {
        throw new ArticleGenerateInputError("request_replay_mismatch");
      }
      return { taskId: replay.id, duplicate: true, taskStatus: "pending" };
    }
    throw error;
  }
}

export async function createArticleGenerateLeafTask(
  tx: Prisma.TransactionClient,
  input: {
    readonly taskId: string;
    readonly parentTaskId: string | null;
    readonly requestToken: string;
    readonly novelIds: readonly string[];
    readonly actorId: string;
    readonly requestId: string;
    readonly inputFingerprint: string;
    readonly payload: ArticleGenerateBatchPayload;
    readonly templates?: Readonly<Record<string, string>>;
    readonly admission?: ArticleGenerateAdmissionSummary;
    readonly now?: Date;
  },
): Promise<void> {
  const terminalWithoutItems = input.novelIds.length === 0 && input.admission !== undefined;
  await tx.genericTask.create({
    data: {
      id: input.taskId,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      taskType: ARTICLE_GENERATE_TASK_TYPE,
      operationScopeHash: articleGenerateScopeHash(input.novelIds),
      mode: "apply",
      status: terminalWithoutItems ? "completed_with_errors" : "pending",
      requestToken: input.requestToken,
      totalCount: input.novelIds.length,
      params: { ...(input.payload as unknown as Prisma.InputJsonObject), inputFingerprint: input.inputFingerprint },
      ...(input.admission ? { result: input.admission as unknown as Prisma.InputJsonObject } : {}),
      ...(terminalWithoutItems ? {
        startedAt: input.now ?? new Date(),
        completedAt: input.now ?? new Date(),
      } : {}),
      ...(input.novelIds.length > 0 ? { items: {
        create: input.novelIds.map((novelId) => ({
          targetType: ARTICLE_GENERATE_TARGET_TYPE,
          targetId: novelId,
          payload: {
            novelId,
            actorId: input.actorId,
            requestId: `${input.requestId}:${novelId}`,
            expiresAt: input.payload.expiresAt,
            ...(input.templates ? { templateKeysByLocale: input.templates } : {}),
          } as Prisma.InputJsonObject,
        })),
      } } : {}),
    },
  });
  await tx.operationAudit.create({
    data: {
      actorType: input.parentTaskId ? "worker" : "admin",
      actorId: input.actorId,
      action: "article_generate.queued",
      entityType: "GenericTask",
      entityId: input.taskId,
      requestId: input.requestId,
      taskType: ARTICLE_GENERATE_TASK_TYPE,
      taskId: input.taskId,
      afterSnapshot: {
        novelCount: input.novelIds.length,
        ...(input.admission ? {
          selectedCount: input.admission.selectedCount,
          submittedCount: input.admission.submittedCount,
          blockedCount: input.admission.blockedCount,
          blockedReasonCounts: input.admission.blockedReasonCounts,
        } : {}),
        expiresAt: input.payload.expiresAt,
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      },
    },
  });
}
