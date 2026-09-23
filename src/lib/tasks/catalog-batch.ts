import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { NormalizedCatalogSelection } from "@/domain/catalog-batch";
import {
  isPromoClaimLifecycleEnabled,
  PROMO_CLAIM_LIFECYCLE_ROLE_BATCH,
  PROMO_CLAIM_LIFECYCLE_VERSION,
  resolvePromoClaimLifecycleConfig,
  type PromoClaimLifecycleRole,
} from "./promo-claim-lifecycle";

export const CATALOG_BATCH_TASK_TYPE = "batch.materialize.v1";
export const CATALOG_BATCH_TARGET_TYPE = "catalog_filter_snapshot";
export const CONTENT_CREATE_TASK_TYPE = "content.create.v1";
export const CONTENT_CREATE_TARGET_TYPE = "novel_source_item";
export const NOVEL_MATERIALIZE_TASK_TYPE = "novel.materialize.v1";
export const NOVEL_MATERIALIZE_TARGET_TYPE = "novel_source_item";
export const CATALOG_BATCH_CHUNK_SIZE = 50;
export const CATALOG_BATCH_TTL_MS = 6 * 60 * 60 * 1_000;
export const CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V1 = 1 as const;
export const CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2 = 2 as const;
export type CatalogBatchEnumEligibilityPolicyVersion =
  | typeof CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V1
  | typeof CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2;

/** `content_create` is retired: retained only so old payloads remain identifiable. */
export type CatalogBatchOperation = "novel_materialize" | "content_create" | "promo_claim";

export type CatalogBatchPayload = Readonly<{
  operation: CatalogBatchOperation;
  selection: NormalizedCatalogSelection;
  actorId: string;
  requestId: string;
  submittedAt: string;
  /**
   * The batch's own enumeration deadline (checked verbatim by `worker/
   * handlers/catalog-batch.ts` before it enumerates). For a lifecycle batch
   * (阶段2, `lifecycleVersion === 1 && lifecycleRole === "batch"`) this is
   * `approvalValidUntil`, not `submittedAt + 6h` — see 设计 §5.2 ("批次自身的
   * expiresAt（枚举条目的截止）改为 approvalValidUntil").
   */
  expiresAt: string;
  /** Missing on historical tasks and interpreted as v1 by the worker. */
  enumEligibilityPolicyVersion?: CatalogBatchEnumEligibilityPolicyVersion;
  channelAccounts?: Readonly<Record<string, string>>;
  /** Retired coupled field. New `novel_materialize` payloads must omit it. */
  templateKeysByLocale?: Readonly<Record<string, string>>;
  /**
   * 阶段2 第2步（`docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`，设计 §5.2）：
   * present, as a matched quadruple with {@link approvedAt}/
   * {@link approvalValidUntil}, exactly when `PROMO_CLAIM_LIFECYCLE_V1_ENABLED`
   * was on at submission time AND `operation === "promo_claim"`. Absent in
   * every other case — switch off, or a `novel_materialize`/`content_create`
   * batch — so a batch's own lifecycle stays fixed at creation and never
   * changes semantics from the switch flipping later (D8). `lifecycleRole` is
   * always `"batch"` here; only the child shard tasks
   * `worker/handlers/catalog-batch.ts` (this step) creates under it carry
   * `lifecycleRole: "shard"` — see `PROMO_CLAIM_LIFECYCLE_ROLES`'s own doc
   * comment for why the two must never be judged by version alone.
   */
  lifecycleVersion?: typeof PROMO_CLAIM_LIFECYCLE_VERSION;
  lifecycleRole?: PromoClaimLifecycleRole;
  /** Submission instant (`= now` at enqueue time). Present iff {@link lifecycleVersion} is. */
  approvedAt?: string;
  /** `approvedAt + approvalTtlMinutes`（D1，批准时钟）. Present iff {@link lifecycleVersion} is; this is also written to {@link expiresAt} above. */
  approvalValidUntil?: string;
}>;

export type CatalogBatchEnqueueInput = Omit<
  CatalogBatchPayload,
  "submittedAt" | "expiresAt" | "enumEligibilityPolicyVersion"
>;

export class CatalogBatchInputError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CatalogBatchInputError"; }
}

export function catalogBatchScopeHash(payload: Pick<CatalogBatchPayload, "operation" | "selection">): string {
  return createHash("sha256").update(JSON.stringify({ operation: payload.operation, selection: payload.selection })).digest("hex");
}

export type CatalogBatchLifecycleFields = Pick<
  CatalogBatchPayload,
  "lifecycleVersion" | "lifecycleRole" | "approvedAt" | "approvalValidUntil"
>;

/**
 * 阶段2 第2步（D8）：pure computation of a new batch's lifecycle stamp,
 * extracted out of `enqueueCatalogBatch` so it can be unit-tested without a
 * database — `enqueueCatalogBatch` itself is only ever tested against real
 * Postgres (`tests/integration/catalog-batch/postgres.test.ts`) because
 * everything else it does (replay/fingerprint matching, the transaction)
 * is inherently DB-shaped, but this one decision is not.
 *
 * The switch is read here, once, at submission time — the caller freezes
 * whatever this returns into the batch's own params (see
 * `CatalogBatchPayload.lifecycleVersion`'s doc comment). Never re-evaluated
 * on enqueue replay (the `existing`/`replay` branches in `enqueueCatalogBatch`
 * return the already-persisted row's params verbatim) and never re-evaluated
 * by the worker's enumeration, which judges a batch's lifecycle purely from
 * these persisted payload fields, not by calling
 * `isPromoClaimLifecycleEnabled` again.
 */
export function resolveCatalogBatchLifecycleFields(
  operation: CatalogBatchOperation,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): { fields: CatalogBatchLifecycleFields; expiresAt: string } {
  const legacyExpiresAt = new Date(now.getTime() + CATALOG_BATCH_TTL_MS).toISOString();
  const lifecycleActive = operation === "promo_claim" && isPromoClaimLifecycleEnabled(env);
  if (!lifecycleActive) return { fields: {}, expiresAt: legacyExpiresAt };
  const config = resolvePromoClaimLifecycleConfig(env);
  const approvedAt = now.toISOString();
  const approvalValidUntil = new Date(now.getTime() + config.approvalTtlMinutes * 60_000).toISOString();
  return {
    fields: {
      lifecycleVersion: PROMO_CLAIM_LIFECYCLE_VERSION,
      lifecycleRole: PROMO_CLAIM_LIFECYCLE_ROLE_BATCH,
      approvedAt,
      approvalValidUntil,
    },
    // 设计 §5.2: the batch's own enumeration deadline becomes the approval
    // clock's deadline, not the legacy flat 6-hour TTL.
    expiresAt: approvalValidUntil,
  };
}

export async function enqueueCatalogBatch(
  db: PrismaClient,
  input: CatalogBatchEnqueueInput,
  now = new Date(),
  enabled = true,
  validateNewInput?: (tx: Prisma.TransactionClient) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ taskId: string; duplicate: boolean; taskStatus: "pending" | "disabled" }> {
  const ordered = (record?: Readonly<Record<string, string>>) => record
    ? Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))) : undefined;
  const allowedInputKeys = new Set([
    "operation", "selection", "actorId", "requestId", "channelAccounts", "templateKeysByLocale",
  ]);
  const legacyBusinessInput = Object.fromEntries(
    Object.entries(input).filter(([key]) => allowedInputKeys.has(key)),
  ) as CatalogBatchEnqueueInput;
  const canonicalInput = { ...legacyBusinessInput,
    ...(legacyBusinessInput.channelAccounts ? { channelAccounts: ordered(legacyBusinessInput.channelAccounts) } : {}),
    ...(legacyBusinessInput.templateKeysByLocale ? { templateKeysByLocale: ordered(legacyBusinessInput.templateKeysByLocale) } : {}),
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
  const enumEligibilityPolicyVersion: CatalogBatchEnumEligibilityPolicyVersion = input.operation === "novel_materialize"
    ? CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2
    : CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V1;
  const { fields: lifecycleFields, expiresAt } = resolveCatalogBatchLifecycleFields(input.operation, now, env);
  const payload: CatalogBatchPayload = {
    ...canonicalInput,
    submittedAt: now.toISOString(),
    expiresAt,
    enumEligibilityPolicyVersion,
    ...lifecycleFields,
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
        afterSnapshot: {
          operation: input.operation,
          selectionScope: input.selection.scope,
          expiresAt: payload.expiresAt,
          enumEligibilityPolicyVersion,
        },
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
