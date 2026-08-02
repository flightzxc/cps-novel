import { Prisma, type PrismaClient, type SideEffectIntent } from "@prisma/client";

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
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
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
  return current === "claim_retry_blocked" && next === "manual_review_required";
}

export async function transitionSideEffectIntent(
  prisma: PrismaClient,
  input: {
    effectKey: string;
    status: SideEffectIntentTransition;
    responseShape?: Prisma.InputJsonValue;
  },
): Promise<SideEffectIntent> {
  return prisma.$transaction(async (tx) => {
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
  });
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
