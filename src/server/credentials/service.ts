import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import { CREDENTIAL_TASK_TYPES, type CredentialContractCode, type CredentialMetadata, type CredentialQueuedResult, type CredentialRedactedResult } from "@/lib/credentials/contracts";
import { CredentialLifecycleError } from "@/lib/credentials/lifecycle";
import { validateCredentialJwtLocally } from "@/lib/credentials/jwt";
import {
  encryptNewCredentialSecret,
  fingerprintNewCredentialSecret,
} from "@/lib/credentials/web-ingress-crypto";
import { AdminAccessError } from "@/lib/auth/errors";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";

type Dependencies = { db: PrismaClient; identities: AdminIdentityStore; sessions: SessionStore; now?: Date; env?: NodeJS.ProcessEnv };

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (
    error.code === "P2002"
    || (error.code === "P2010" && (error.meta as { code?: unknown } | undefined)?.code === "23505")
  );
}

function isSerializableWriteConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (
    error.code === "P2034"
    || (error.code === "P2010" && (error.meta as { code?: unknown } | undefined)?.code === "40001")
  );
}

function reason(value: string | undefined, required: boolean): string | null {
  const normalized = value?.trim() ?? "";
  if (required && !normalized) throw new Error("A reason is required");
  if (normalized.length > 1000) throw new Error("Reason is too long");
  return normalized || null;
}

const CREDENTIAL_REPLACE_AUDIT_ACTION = "credential.replace.completed";
const JWT_LIKE_TEXT = /(?:^|\s)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\s|$)/;

export class CredentialReplacementIdempotencyConflictError extends Error {
  readonly code = "admin_mutation_request_id_invalid" as const;
  readonly status = 409 as const;
  readonly details = Object.freeze({ reason: "idempotency_conflict" as const });

  constructor() {
    super("Credential replacement idempotency binding conflict");
  }
}

export class CredentialTaskNotFoundError extends Error {
  readonly code = "credential_task_not_found" as const;
  readonly status = 404 as const;

  constructor() {
    super("Credential task does not exist or is outside the permitted query scope");
    this.name = "CredentialTaskNotFoundError";
  }
}

type CredentialReplacementBinding = Readonly<{
  requestId: string;
  actorId: string;
  channelAccountId: string;
  fingerprintPrefix: string;
}>;

type CredentialMetadataRow = {
  id: string;
  channelAccountId: string;
  credentialType: string;
  fingerprintPrefix: string;
  status: string;
  expiresAt: Date | null;
  lastValidatedAt: Date | null;
};

function credentialMetadata(row: CredentialMetadataRow): CredentialMetadata {
  return {
    credentialId: row.id,
    channelAccountId: row.channelAccountId,
    credentialType: row.credentialType,
    fingerprintPrefix: row.fingerprintPrefix,
    status: row.status as CredentialMetadata["status"],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
  };
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

function assertCredentialReplacementBinding(input: {
  binding: CredentialReplacementBinding;
  audit: {
    requestId: string | null;
    action: string;
    actorId: string | null;
    afterSnapshot: Prisma.JsonValue | null;
  };
  credential: CredentialMetadataRow;
}): void {
  const snapshot = input.audit.afterSnapshot;
  const snapshotPrefix = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Prisma.JsonObject).fingerprintPrefix
    : null;
  if (
    input.audit.requestId !== input.binding.requestId
    || input.audit.action !== CREDENTIAL_REPLACE_AUDIT_ACTION
    || input.audit.actorId !== input.binding.actorId
    || input.credential.channelAccountId !== input.binding.channelAccountId
    || snapshotPrefix !== input.binding.fingerprintPrefix
    || input.credential.fingerprintPrefix !== input.binding.fingerprintPrefix
  ) {
    throw new CredentialReplacementIdempotencyConflictError();
  }
}

type CredentialReplacementReader = Pick<
  Prisma.TransactionClient,
  "operationAudit" | "channelAccountCredential"
>;

async function findCommittedCredentialReplacement(
  db: CredentialReplacementReader,
  binding: CredentialReplacementBinding,
): Promise<CredentialMetadata | null> {
  const audit = await db.operationAudit.findFirst({
    where: {
      actorType: "admin",
      action: CREDENTIAL_REPLACE_AUDIT_ACTION,
      requestId: binding.requestId,
    },
    select: {
      requestId: true,
      action: true,
      actorId: true,
      entityId: true,
      afterSnapshot: true,
    },
  });
  if (!audit) return null;
  const row = await db.channelAccountCredential.findUnique({
    where: { id: audit.entityId },
    select: {
      id: true,
      channelAccountId: true,
      credentialType: true,
      fingerprintPrefix: true,
      status: true,
      expiresAt: true,
      lastValidatedAt: true,
    },
  });
  if (!row) throw new CredentialReplacementIdempotencyConflictError();
  assertCredentialReplacementBinding({ binding, audit, credential: row });
  return credentialMetadata(row);
}

/**
 * Synchronous add/replace ingress. The plaintext JWT is used only for this
 * invocation, never enters a task/audit/log, and is encrypted before the
 * transaction writes the sole permitted persisted representation.
 */
export async function addOrReplaceCredential(input: {
  authorization: AdminServiceAuthorization;
  requestId: string;
  channelAccountId: string;
  credentialType?: "bearer_jwt";
  secret: string;
  reason: string;
}, deps: Dependencies): Promise<CredentialMetadata> {
  if (input.authorization.entryId !== "admin.credential.replace") {
    throw new AdminAccessError(
      "admin_service_authorization_required",
      403,
      "Service authorization is not valid for Credential replacement",
    );
  }
  const context = await actor(input.authorization, "admin.credential.replace", input.requestId, deps);
  const why = reason(input.reason, true);
  if (
    (input.secret.trim() && why?.includes(input.secret.trim()))
    || (why !== null && JWT_LIKE_TEXT.test(why))
  ) {
    throw new CredentialLifecycleError(
      "credential_validation_failed",
      "The operation reason must not contain credential material",
    );
  }
  const now = deps.now ?? new Date();
  const validation = validateCredentialJwtLocally(input.secret, now);
  if (validation.status === "invalid") {
    throw new CredentialLifecycleError(
      "credential_validation_failed",
      "The submitted credential is not a valid JWT",
    );
  }

  const fingerprint = fingerprintNewCredentialSecret(input.secret, deps.env);
  const idempotencyBinding: CredentialReplacementBinding = Object.freeze({
    requestId: input.requestId,
    actorId: context.identity.id,
    channelAccountId: input.channelAccountId,
    fingerprintPrefix: fingerprint.prefix,
  });
  const prior = await findCommittedCredentialReplacement(deps.db, idempotencyBinding);
  if (prior) return prior;

  const credentialId = randomUUID();
  const credentialType = input.credentialType ?? "bearer_jwt";
  const encrypted = encryptNewCredentialSecret({
    secret: input.secret,
    channelAccountId: input.channelAccountId,
    credentialId,
    env: deps.env,
  });

  try {
    return await deps.db.$transaction(async (tx) => {
      const existing = await findCommittedCredentialReplacement(tx, idempotencyBinding);
      if (existing) return existing;

      const accounts = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT status
        FROM channel_account
        WHERE id=${input.channelAccountId}::uuid AND deleted_at IS NULL
        FOR UPDATE
      `);
      if (accounts[0]?.status !== "active") {
        throw new CredentialLifecycleError(
          "account_inactive",
          "The channel account is not active",
        );
      }

      const previous = await tx.$queryRaw<Array<{ id: string; fingerprint_prefix: string }>>(Prisma.sql`
        SELECT id, fingerprint_prefix
        FROM channel_account_credential
        WHERE channel_account_id=${input.channelAccountId}::uuid
          AND credential_type=${credentialType}
          AND status='active'
        ORDER BY id
        FOR UPDATE
      `);

      // An active replacement is inserted in a non-active intermediate state so
      // its fingerprint can be reserved before the old latch is released.
      const initialStatus = validation.status === "active" ? "invalid" : "expired";
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO channel_account_credential (
          id, channel_account_id, credential_type, encrypted_secret, key_version,
          secret_fingerprint, fingerprint_prefix, expires_at, last_validated_at,
          status, created_at, updated_at
        ) VALUES (
          ${credentialId}::uuid, ${input.channelAccountId}::uuid, ${credentialType},
          ${encrypted.encryptedSecret}, ${encrypted.keyVersion}, ${fingerprint.full},
          ${fingerprint.prefix}, ${validation.expiresAt}, ${now}, ${initialStatus},
          transaction_timestamp(), transaction_timestamp()
        )
      `);

      if (validation.status === "active") {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO channel_credential_active_fingerprint (
            id, fingerprint, credential_id, channel_account_id, credential_type, created_at
          ) VALUES (
            ${randomUUID()}::uuid, ${fingerprint.full}, ${credentialId}::uuid,
            ${input.channelAccountId}::uuid, ${credentialType}, transaction_timestamp()
          )
        `);
      }

      await tx.$executeRaw(Prisma.sql`
        UPDATE channel_account_credential
        SET status='superseded', updated_at=transaction_timestamp()
        WHERE channel_account_id=${input.channelAccountId}::uuid
          AND credential_type=${credentialType}
          AND status='active'
          AND id<>${credentialId}::uuid
      `);
      if (previous.length > 0) {
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM channel_credential_active_fingerprint
          WHERE credential_id IN (${Prisma.join(previous.map((row) => Prisma.sql`${row.id}::uuid`))})
        `);
      }
      if (validation.status === "active") {
        await tx.$executeRaw(Prisma.sql`
          UPDATE channel_account_credential
          SET status='active', updated_at=transaction_timestamp()
          WHERE id=${credentialId}::uuid AND status='invalid'
        `);
      }

      await tx.channelAccount.update({
        where: { id: input.channelAccountId },
        data: { lastValidatedAt: now },
        select: { id: true },
      });
      await tx.credentialChangeLog.create({
        data: {
          channelAccountId: input.channelAccountId,
          credentialId,
          actorType: "admin",
          actorId: context.identity.id,
          action: previous.length > 0 ? "replace" : "add",
          oldFingerprint: previous[0]?.fingerprint_prefix ?? null,
          newFingerprint: fingerprint.prefix,
          reason: why,
          detail: { credentialType, status: validation.status },
        },
        select: { id: true },
      });
      await tx.operationAudit.create({
        data: {
          actorType: "admin",
          actorId: context.identity.id,
          action: CREDENTIAL_REPLACE_AUDIT_ACTION,
          entityType: "ChannelAccountCredential",
          entityId: credentialId,
          requestId: input.requestId,
          reason: why,
          afterSnapshot: {
            channelAccountId: input.channelAccountId,
            credentialType,
            status: validation.status,
            fingerprintPrefix: fingerprint.prefix,
          },
        },
      });

      return credentialMetadata({
        id: credentialId,
        channelAccountId: input.channelAccountId,
        credentialType,
        fingerprintPrefix: fingerprint.prefix,
        status: validation.status,
        expiresAt: validation.expiresAt,
        lastValidatedAt: now,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    const uniqueConflict = isUniqueConflict(error);
    if (!uniqueConflict && !isSerializableWriteConflict(error)) throw error;
    const committed = await findCommittedCredentialReplacement(deps.db, idempotencyBinding);
    if (committed) return committed;
    if (!uniqueConflict) throw error;
    throw new CredentialLifecycleError(
      "credential_fingerprint_conflict",
      "An active credential already uses this fingerprint",
    );
  }
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
  if (
    !task
    || !Object.values(CREDENTIAL_TASK_TYPES).includes(task.taskType as never)
    || task.taskType === CREDENTIAL_TASK_TYPES.replaceGated
  ) {
    throw new CredentialTaskNotFoundError();
  }
  return {
    state: task.status,
    result: (task.items[0]?.result as CredentialRedactedResult | null) ?? null,
    error: projectPersistedCredentialTaskFailure(task.items[0]?.error),
  };
}
