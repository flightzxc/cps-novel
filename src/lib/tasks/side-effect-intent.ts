import { Prisma, type PrismaClient, type SideEffectIntent } from "@prisma/client";
import { isUniqueConstraintViolation } from "@/lib/db/db-retry";

export type SideEffectIntentTransition =
  | "confirmed"
  | "failed"
  | "claim_retry_blocked"
  | "manual_review_required";

export interface PrepareSideEffectIntentInput {
  effectKey: string;
  operationType: string;
  idempotencyKey: string;
  targetType: string;
  targetId: string;
  taskItemType?: string;
  taskItemId?: string;
  channelAccountId?: string;
  channelAppId?: string;
  promoLinkId?: string;
  attemptFingerprint?: string;
  requestSummary?: Prisma.InputJsonValue;
}

export class SideEffectIdentityConflictError extends Error {
  readonly code = "SIDE_EFFECT_IDENTITY_CONFLICT";
  constructor(readonly effectKey: string) {
    super(`Side-effect identity conflicts with an existing intent: ${effectKey}`);
    this.name = "SideEffectIdentityConflictError";
  }
}

function requireHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be exactly 64 hexadecimal characters`);
  }
}

function sameIdentity(row: SideEffectIntent, input: PrepareSideEffectIntentInput): boolean {
  return (
    row.effectKey === input.effectKey &&
    row.operationType === input.operationType &&
    row.idempotencyKey === input.idempotencyKey &&
    row.targetType === input.targetType &&
    row.targetId === input.targetId
  );
}

/** Resolves only after the independent intent transaction has committed. */
export async function prepareSideEffectIntent(
  prisma: PrismaClient,
  input: PrepareSideEffectIntentInput,
): Promise<{ created: boolean; intent: SideEffectIntent }> {
  requireHash(input.effectKey, "effectKey");
  requireHash(input.idempotencyKey, "idempotencyKey");
  if (input.attemptFingerprint) requireHash(input.attemptFingerprint, "attemptFingerprint");
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.sideEffectIntent.findUnique({ where: { effectKey: input.effectKey } });
      if (existing) {
        if (!sameIdentity(existing, input)) throw new SideEffectIdentityConflictError(input.effectKey);
        return { created: false, intent: existing };
      }
      const intent = await tx.sideEffectIntent.create({
        data: {
          effectKey: input.effectKey,
          operationType: input.operationType,
          idempotencyKey: input.idempotencyKey,
          targetType: input.targetType,
          targetId: input.targetId,
          taskItemType: input.taskItemType,
          taskItemId: input.taskItemId,
          channelAccountId: input.channelAccountId,
          channelAppId: input.channelAppId,
          promoLinkId: input.promoLinkId,
          attemptFingerprint: input.attemptFingerprint,
          requestSummary: input.requestSummary ?? {},
        },
      });
      return { created: true, intent };
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    const existing = await prisma.sideEffectIntent.findUnique({ where: { effectKey: input.effectKey } });
    if (!existing || !sameIdentity(existing, input)) {
      throw new SideEffectIdentityConflictError(input.effectKey);
    }
    return { created: false, intent: existing };
  }
}

export function isAllowedSideEffectTransition(
  current: string,
  next: SideEffectIntentTransition,
): boolean {
  if (current === "prepared") {
    return next === "confirmed" || next === "failed" || next === "claim_retry_blocked";
  }
  if (current === "claim_retry_blocked") {
    // The outcome is unknown. The generic worker graph may only hand the
    // intent to manual review. Reaching `confirmed` from here requires
    // independent readback evidence and goes through
    // `confirmSideEffectIntentByReadbackInTransaction`; `failed` is only
    // reachable through the X9 adjudicator after manual review.
    return next === "manual_review_required";
  }
  // `manual_review_required`, `confirmed` and `failed` are terminal for the
  // generic worker graph. Only the dedicated X9 adjudication boundary may
  // leave `manual_review_required`.
  return false;
}

export async function transitionSideEffectIntentInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    effectKey: string;
    status: SideEffectIntentTransition;
    responseShape?: Prisma.InputJsonValue;
  },
): Promise<SideEffectIntent> {
  const current = await tx.sideEffectIntent.findUnique({ where: { effectKey: input.effectKey } });
  if (!current) throw new Error(`Side-effect intent not found: ${input.effectKey}`);
  if (!isAllowedSideEffectTransition(current.status, input.status)) {
    throw new Error(`Illegal side-effect transition: ${current.status} -> ${input.status}`);
  }
  const changed = await tx.sideEffectIntent.updateMany({
    where: { id: current.id, status: current.status },
    data: {
      status: input.status,
      responseShape: input.responseShape,
      confirmedAt: input.status === "confirmed" ? new Date() : undefined,
    },
  });
  if (changed.count !== 1) {
    throw new Error(`Concurrent side-effect transition rejected: ${current.status} -> ${input.status}`);
  }
  return tx.sideEffectIntent.findUniqueOrThrow({ where: { id: current.id } });
}

export async function transitionSideEffectIntent(
  prisma: PrismaClient,
  input: {
    effectKey: string;
    status: SideEffectIntentTransition;
    responseShape?: Prisma.InputJsonValue;
  },
): Promise<SideEffectIntent> {
  return prisma.$transaction((tx) => transitionSideEffectIntentInTransaction(tx, input));
}

/** Statuses from which an independent readback may confirm the intent. */
export const READBACK_CONFIRMABLE_STATUSES = ["prepared", "claim_retry_blocked"] as const;

export function isReadbackConfirmableStatus(current: string): boolean {
  return (READBACK_CONFIRMABLE_STATUSES as readonly string[]).includes(current);
}

export interface SideEffectReadbackEvidence {
  hasWebUrl: boolean;
  hasAppUrl: boolean;
}

function readbackEvidenceIsValid(value: unknown): value is SideEffectReadbackEvidence {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as SideEffectReadbackEvidence).hasWebUrl === "boolean"
    && typeof (value as SideEffectReadbackEvidence).hasAppUrl === "boolean";
}

function jsonObjectOrEmpty(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Prisma.JsonObject) : {};
}

/**
 * Readback-recovery confirmation boundary.
 *
 * This is the ONLY way an intent whose outcome is still unknown to the
 * worker (`prepared`, or `claim_retry_blocked` in the crash window before
 * it reaches manual review) may become `confirmed` without the X9
 * adjudicator: the caller has re-read the upstream object through the
 * read-only readback path, located it, and is writing the local business
 * rows (PromoLink, Article binding) in the *same* fenced transaction `tx`.
 * The generic worker graph (`isAllowedSideEffectTransition`) deliberately
 * has no `claim_retry_blocked -> confirmed` edge; do not add one there.
 *
 * Evidence is mandatory and is merged over the intent's existing
 * `responseShape` so the ambiguity trail (failureCategory / readbackStatus
 * recorded when the intent was blocked) is preserved next to the
 * confirmation.
 */
export async function confirmSideEffectIntentByReadbackInTransaction(
  tx: Prisma.TransactionClient,
  input: { effectKey: string; evidence: SideEffectReadbackEvidence },
): Promise<SideEffectIntent> {
  if (!readbackEvidenceIsValid(input.evidence)) {
    throw new Error("Readback evidence is required to confirm a side-effect intent");
  }
  const current = await tx.sideEffectIntent.findUnique({ where: { effectKey: input.effectKey } });
  if (!current) throw new Error(`Side-effect intent not found: ${input.effectKey}`);
  if (!isReadbackConfirmableStatus(current.status)) {
    throw new Error(`Illegal side-effect readback confirmation: ${current.status} -> confirmed`);
  }
  const responseShape: Prisma.InputJsonObject = {
    ...(jsonObjectOrEmpty(current.responseShape) as Prisma.InputJsonObject),
    source: "readback",
    confirmedFrom: current.status,
    hasWebUrl: input.evidence.hasWebUrl,
    hasAppUrl: input.evidence.hasAppUrl,
  };
  const changed = await tx.sideEffectIntent.updateMany({
    where: { id: current.id, status: current.status },
    data: { status: "confirmed", responseShape, confirmedAt: new Date() },
  });
  if (changed.count !== 1) {
    throw new Error(`Concurrent side-effect transition rejected: ${current.status} -> confirmed`);
  }
  return tx.sideEffectIntent.findUniqueOrThrow({ where: { id: current.id } });
}

export function markSideEffectUnknown(
  prisma: PrismaClient,
  effectKey: string,
  responseShape?: Prisma.InputJsonValue,
): Promise<SideEffectIntent> {
  return transitionSideEffectIntent(prisma, {
    effectKey,
    status: "claim_retry_blocked",
    responseShape,
  });
}
