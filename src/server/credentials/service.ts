import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import { CREDENTIAL_TASK_TYPES, type CredentialContractCode, type CredentialMetadata, type CredentialQueuedResult, type CredentialRedactedResult } from "@/lib/credentials/contracts";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";

type Dependencies = { db: PrismaClient; identities: AdminIdentityStore; sessions: SessionStore; now?: Date; env?: NodeJS.ProcessEnv };

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function reason(value: string | undefined, required: boolean): string | null {
  const normalized = value?.trim() ?? "";
  if (required && !normalized) throw new Error("A reason is required");
  if (normalized.length > 1000) throw new Error("Reason is too long");
  return normalized || null;
}

async function actor(authorization: AdminServiceAuthorization, entryId: string, requestId: string, deps: Dependencies) {
  return requireFreshAdminServiceMutation(authorization, "credential:manage", { ...deps, entryId, requestId });
}

export async function createChannelAccount(input: { authorization: AdminServiceAuthorization; requestId: string; channelId: string; businessId: string; accountName: string }, deps: Dependencies) {
  const context = await actor(input.authorization, "admin.channel_account.create", input.requestId, deps);
  try {
    return await deps.db.$transaction(async (tx) => {
      const existing = await tx.operationAudit.findFirst({ where: { actorType: "admin", action: "channel_account.create", requestId: input.requestId } });
      if (existing) return tx.channelAccount.findUnique({ where: { id: existing.entityId } });
      const account = await tx.channelAccount.create({ data: { channelId: input.channelId, businessId: input.businessId.trim(), accountName: input.accountName.trim(), status: "active" } });
      await tx.operationAudit.create({ data: { actorType: "admin", actorId: context.identity.id, action: "channel_account.create", entityType: "ChannelAccount", entityId: account.id, requestId: input.requestId } });
      return account;
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const committed = await deps.db.operationAudit.findFirst({ where: { actorType: "admin", action: "channel_account.create", requestId: input.requestId } });
    if (!committed) throw error;
    return deps.db.channelAccount.findUnique({ where: { id: committed.entityId } });
  }
}

export async function setChannelAccountStatus(input: { authorization: AdminServiceAuthorization; entryId: "admin.channel_account.disable" | "admin.channel_account.enable"; requestId: string; channelAccountId: string; nextStatus: "active" | "disabled"; reason: string }, deps: Dependencies) {
  const context = await actor(input.authorization, input.entryId, input.requestId, deps);
  const why = reason(input.reason, true);
  const auditAction = input.nextStatus === "active" ? "channel_account.enable" : "channel_account.disable";
  try {
    return await deps.db.$transaction(async (tx) => {
      const existing = await tx.operationAudit.findFirst({ where: { actorType: "admin", action: auditAction, requestId: input.requestId } });
      if (existing) return tx.channelAccount.findUnique({ where: { id: existing.entityId } });
      const before = await tx.channelAccount.findUniqueOrThrow({ where: { id: input.channelAccountId } });
      const account = await tx.channelAccount.update({ where: { id: input.channelAccountId }, data: { status: input.nextStatus } });
      await tx.operationAudit.create({ data: { actorType: "admin", actorId: context.identity.id, action: auditAction, entityType: "ChannelAccount", entityId: account.id, requestId: input.requestId, reason: why, beforeSnapshot: { status: before.status }, afterSnapshot: { status: account.status } } });
      return account;
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const committed = await deps.db.operationAudit.findFirst({ where: { actorType: "admin", action: auditAction, requestId: input.requestId } });
    if (!committed) throw error;
    return deps.db.channelAccount.findUnique({ where: { id: committed.entityId } });
  }
}

export async function listCredentialMetadata(db: PrismaClient, channelAccountId: string): Promise<CredentialMetadata[]> {
  const rows = await db.channelAccountCredential.findMany({ where: { channelAccountId }, select: { id: true, channelAccountId: true, credentialType: true, fingerprintPrefix: true, status: true, expiresAt: true, lastValidatedAt: true }, orderBy: { createdAt: "desc" } });
  return rows.map((row) => ({ credentialId: row.id, channelAccountId: row.channelAccountId, credentialType: row.credentialType, fingerprintPrefix: row.fingerprintPrefix, status: row.status as CredentialMetadata["status"], expiresAt: row.expiresAt?.toISOString() ?? null, lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null }));
}

export async function enqueueCredentialOperation(input: { authorization: AdminServiceAuthorization; entryId: "admin.credential.validate" | "admin.credential.supersede"; requestId: string; channelAccountId: string; credentialId: string; operation: "validate" | "supersede"; reason?: string }, deps: Dependencies): Promise<CredentialQueuedResult> {
  const context = await actor(input.authorization, input.entryId, input.requestId, deps);
  reason(input.reason, input.operation === "supersede");
  const now = deps.now ?? new Date();
  const taskType = input.operation === "validate" ? CREDENTIAL_TASK_TYPES.validate : CREDENTIAL_TASK_TYPES.supersede;
  const requestToken = `credential:${input.operation}:${input.requestId}`;
  const operationScopeHash = createHash("sha256").update(`${input.operation}\0${input.channelAccountId}\0${input.credentialId}`).digest("hex");
  const queued = (task: { id: string; createdAt: Date }): CredentialQueuedResult => ({
    code: "credential_validation_queued", state: "queued", taskId: task.id,
    credentialId: input.credentialId, channelAccountId: input.channelAccountId,
    enqueuedAt: task.createdAt.toISOString(), mutationRequestId: input.requestId,
  });
  try {
    return await deps.db.$transaction(async (tx) => {
    const prior = await tx.genericTask.findUnique({ where: { requestToken } });
    if (prior) return queued(prior);
    const taskId = randomUUID();
    const payload = { channelAccountId: input.channelAccountId, credentialId: input.credentialId, actorId: context.identity.id, mutationRequestId: input.requestId, operation: input.operation };
    await tx.genericTask.create({ data: { id: taskId, taskType, channelAccountId: input.channelAccountId, operationScopeHash, requestToken, status: "pending", params: payload, items: { create: [{ targetType: "credential", targetId: input.credentialId, payload }] } } });
    await tx.operationAudit.create({ data: { actorType: "admin", actorId: context.identity.id, action: `credential.${input.operation}.queued`, entityType: "ChannelAccountCredential", entityId: input.credentialId, requestId: input.requestId, taskType, taskId, reason: input.reason?.trim() || null } });
    return { code: "credential_validation_queued", state: "queued", taskId, credentialId: input.credentialId, channelAccountId: input.channelAccountId, enqueuedAt: now.toISOString(), mutationRequestId: input.requestId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const prior = await deps.db.genericTask.findFirst({ where: {
      OR: [
        { requestToken },
        { taskType, channelAccountId: input.channelAccountId, operationScopeHash, status: { in: ["pending", "processing"] } },
      ],
    }, orderBy: { createdAt: "desc" } });
    if (!prior) throw error;
    return queued(prior);
  }
}

const CREDENTIAL_TASK_FAILURE_CODES = Object.freeze([
  "account_inactive",
  "credential_missing",
  "credential_ambiguous",
  "credential_validation_failed",
  "credential_fingerprint_conflict",
] as const satisfies readonly CredentialContractCode[]);

export type CredentialTaskFailureCode = (typeof CREDENTIAL_TASK_FAILURE_CODES)[number];
export type CredentialTaskFailure = Readonly<{ code: CredentialTaskFailureCode }>;

/**
 * `generic_task_item.error` is already sanitized before persistence. This
 * projection applies a second allowlist and deliberately drops every field
 * except the stable code before the value can reach a frontend contract.
 */
export function projectPersistedCredentialTaskFailure(error: unknown): CredentialTaskFailure | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && CREDENTIAL_TASK_FAILURE_CODES.includes(code as CredentialTaskFailureCode)
    ? Object.freeze({ code: code as CredentialTaskFailureCode })
    : null;
}

export type CredentialTaskReadResult = {
  state: string;
  result: CredentialRedactedResult | null;
  error: CredentialTaskFailure | null;
};

export async function getCredentialTaskResult(db: PrismaClient, taskId: string): Promise<CredentialTaskReadResult> {
  const task = await db.genericTask.findUnique({
    where: { id: taskId },
    select: {
      taskType: true,
      status: true,
      items: { take: 1, select: { result: true, error: true } },
    },
  });
  if (!task || !Object.values(CREDENTIAL_TASK_TYPES).includes(task.taskType as never) || task.taskType === CREDENTIAL_TASK_TYPES.replaceGated) throw new Error("credential_missing");
  return {
    state: task.status,
    result: (task.items[0]?.result as CredentialRedactedResult | null) ?? null,
    error: projectPersistedCredentialTaskFailure(task.items[0]?.error),
  };
}
