import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { NormalizedCatalogSelection } from "@/domain/catalog-batch";

export const CATALOG_BATCH_TASK_TYPE = "batch.materialize.v1";
export const CATALOG_BATCH_TARGET_TYPE = "catalog_filter_snapshot";
export const CONTENT_CREATE_TASK_TYPE = "content.create.v1";
export const CONTENT_CREATE_TARGET_TYPE = "novel_source_item";
export const CATALOG_BATCH_CHUNK_SIZE = 50;
export const CATALOG_BATCH_TTL_MS = 6 * 60 * 60 * 1_000;

export type CatalogBatchOperation = "content_create" | "promo_claim";

export type CatalogBatchPayload = Readonly<{
  operation: CatalogBatchOperation;
  selection: NormalizedCatalogSelection;
  actorId: string;
  requestId: string;
  submittedAt: string;
  expiresAt: string;
  channelAccounts?: Readonly<Record<string, string>>;
  templateKeysByLocale?: Readonly<Record<string, string>>;
}>;

export class CatalogBatchInputError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CatalogBatchInputError"; }
}

export function catalogBatchScopeHash(payload: Pick<CatalogBatchPayload, "operation" | "selection">): string {
  return createHash("sha256").update(JSON.stringify({ operation: payload.operation, selection: payload.selection })).digest("hex");
}

export async function enqueueCatalogBatch(
  db: PrismaClient,
  input: Omit<CatalogBatchPayload, "submittedAt" | "expiresAt">,
  now = new Date(),
  enabled = true,
  validateNewInput?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<{ taskId: string; duplicate: boolean; taskStatus: "pending" | "disabled" }> {
  const ordered = (record?: Readonly<Record<string, string>>) => record
    ? Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))) : undefined;
  const canonicalInput = { ...input,
    ...(input.channelAccounts ? { channelAccounts: ordered(input.channelAccounts) } : {}),
    ...(input.templateKeysByLocale ? { templateKeysByLocale: ordered(input.templateKeysByLocale) } : {}),
  };
  const inputFingerprint = createHash("sha256").update(JSON.stringify(canonicalInput)).digest("hex");
  const requestToken = `catalog_batch:${createHash("sha256").update(`${input.operation}\n${input.actorId}\n${input.requestId}`).digest("hex")}`;
  const existing = await db.genericTask.findUnique({ where: { requestToken }, select: { id: true, params: true, status: true } });
  if (existing) {
    const p = existing.params as Record<string, unknown>;
    if (p.inputFingerprint !== inputFingerprint) throw new CatalogBatchInputError("request_replay_mismatch");
    return { taskId: existing.id, duplicate: true, taskStatus: existing.status === "disabled" ? "disabled" : "pending" };
  }
  const taskId = randomUUID();
  const payload: CatalogBatchPayload = {
    ...canonicalInput,
    submittedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CATALOG_BATCH_TTL_MS).toISOString(),
  };
  try {
    await db.$transaction(async (tx) => {
      await validateNewInput?.(tx);
      await tx.genericTask.create({ data: {
        id: taskId, taskType: CATALOG_BATCH_TASK_TYPE, operationScopeHash: catalogBatchScopeHash(payload),
        mode: "apply", status: enabled ? "pending" : "disabled", requestToken, totalCount: 1,
        params: { ...(payload as unknown as Prisma.InputJsonObject), inputFingerprint },
        items: { create: { targetType: CATALOG_BATCH_TARGET_TYPE, targetId: taskId, payload: payload as unknown as Prisma.InputJsonObject } },
      } });
      await tx.operationAudit.create({ data: {
        actorType: "admin", actorId: input.actorId, action: "catalog_batch.queued",
        entityType: "GenericTask", entityId: taskId, requestId: input.requestId,
        taskType: CATALOG_BATCH_TASK_TYPE, taskId,
        afterSnapshot: { operation: input.operation, selectionScope: input.selection.scope, expiresAt: payload.expiresAt },
      } });
    });
    return { taskId, duplicate: false, taskStatus: enabled ? "pending" : "disabled" };
  } catch (error) {
    const replay = await db.genericTask.findUnique({ where: { requestToken }, select: { id: true, params: true, status: true } });
    if (replay) {
      const p = replay.params as Record<string, unknown>;
      if (p.inputFingerprint !== inputFingerprint) throw new CatalogBatchInputError("request_replay_mismatch");
      return { taskId: replay.id, duplicate: true, taskStatus: replay.status === "disabled" ? "disabled" : "pending" };
    }
    throw error;
  }
}
