import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  ARTICLE_GENERATE_UUID,
  normalizeArticleGenerateFilter,
  type NormalizedArticleGenerateFilter,
} from "@/domain/article-generation";

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

export async function enqueueArticleGenerateBatch(
  db: PrismaClient,
  input: {
    readonly novelIds: readonly string[];
    readonly actorId: string;
    readonly requestId: string;
    readonly templateKeysByLocale?: Readonly<Record<string, string>>;
  },
  now = new Date(),
): Promise<{ taskId: string; duplicate: boolean; taskStatus: "pending" }> {
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
  const payload: ArticleGenerateBatchPayload = {
    ...canonicalInput,
    submittedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ARTICLE_GENERATE_TTL_MS).toISOString(),
  };

  try {
    await db.$transaction(async (tx) => {
      await createArticleGenerateLeafTask(tx, {
        taskId,
        parentTaskId: null,
        requestToken,
        novelIds,
        actorId: input.actorId,
        requestId: input.requestId,
        inputFingerprint,
        payload,
        templates,
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
  },
): Promise<void> {
  await tx.genericTask.create({
    data: {
      id: input.taskId,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      taskType: ARTICLE_GENERATE_TASK_TYPE,
      operationScopeHash: articleGenerateScopeHash(input.novelIds),
      mode: "apply",
      status: "pending",
      requestToken: input.requestToken,
      totalCount: input.novelIds.length,
      params: { ...(input.payload as unknown as Prisma.InputJsonObject), inputFingerprint: input.inputFingerprint },
      items: {
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
      },
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
        expiresAt: input.payload.expiresAt,
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      },
    },
  });
}
