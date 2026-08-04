import { Prisma, type PrismaClient } from "@prisma/client";

import { CREDENTIAL_TASK_TYPES, type CredentialRedactedResult } from "../../src/lib/credentials/contracts";
import { validateCredentialJwtLocally } from "../../src/lib/credentials/jwt";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { decryptCredentialSecretForWorker } from "../credentials/crypto";

type Payload = { channelAccountId: string; credentialId: string; actorId: string; mutationRequestId: string; operation: string };
type CredentialRow = { id: string; channel_account_id: string; credential_type: string; encrypted_secret: Uint8Array; key_version: number; secret_fingerprint: string; fingerprint_prefix: string; status: string };

function payload(value: unknown): Payload {
  const item = value as Partial<Payload>;
  if (!item || !item.channelAccountId || !item.credentialId || !item.actorId || !item.mutationRequestId) throw new Error("credential_validation_failed");
  return item as Payload;
}

export function createCredentialValidateHandler(db: PrismaClient): TaskHandler {
  return async ({ lease }) => {
    const input = payload(lease.payload);
    const accounts = await db.$queryRaw<Array<{ status: string }>>`SELECT status FROM channel_account WHERE id=${input.channelAccountId}::uuid AND deleted_at IS NULL`;
    if (accounts[0]?.status !== "active") return { status: "failed", error: { code: "account_inactive", message: "Channel account is inactive" } };
    const credentials = await db.$queryRaw<CredentialRow[]>`SELECT id,channel_account_id,credential_type,encrypted_secret,key_version,secret_fingerprint,fingerprint_prefix,status FROM channel_account_credential WHERE id=${input.credentialId}::uuid AND channel_account_id=${input.channelAccountId}::uuid`;
    const credential = credentials[0];
    if (!credential) return { status: "failed", error: { code: "credential_missing", message: "Credential is missing" } };
    if (credential.status === "superseded") return { status: "failed", error: { code: "credential_validation_failed", message: "Superseded credential cannot be validated" } };
    const active = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM channel_account_credential
      WHERE channel_account_id=${input.channelAccountId}::uuid
        AND credential_type=${credential.credential_type} AND status='active'
      ORDER BY id
    `;
    if (active.length > 1) return { status: "failed", error: { code: "credential_ambiguous", message: "Credential selection is ambiguous" } };
    const now = new Date();
    const secret = decryptCredentialSecretForWorker(credential.encrypted_secret, input.channelAccountId, input.credentialId, credential.key_version);
    const validation = validateCredentialJwtLocally(secret, now);
    const code = validation.status === "expired" ? "credential_expired" : validation.status === "invalid" ? "credential_validation_failed" : null;
    const result: CredentialRedactedResult = {
      code, credentialId: credential.id, status: validation.status,
      expiresAt: validation.expiresAt?.toISOString() ?? null, lastValidatedAt: now.toISOString(),
      fingerprintPrefix: credential.fingerprint_prefix,
    };
    return { status: "success", result, protectedWrite: async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`SELECT status FROM channel_account_credential WHERE id=${credential.id}::uuid FOR UPDATE`);
      if (!locked[0] || locked[0].status === "superseded") throw new Error("credential_validation_failed");
      if (validation.status === "active" && locked[0].status !== "active") {
        const active = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*)::bigint AS count FROM channel_account_credential WHERE channel_account_id=${input.channelAccountId}::uuid AND credential_type=${credential.credential_type} AND status='active' AND id<>${credential.id}::uuid`);
        if (active[0].count > 0n) throw new Error("credential_validation_failed");
      }
      await tx.$executeRaw(Prisma.sql`UPDATE channel_account_credential SET status=${validation.status},expires_at=${validation.expiresAt},last_validated_at=${now},updated_at=transaction_timestamp() WHERE id=${credential.id}::uuid`);
      if (validation.status === "active") {
        await tx.$executeRaw(Prisma.sql`INSERT INTO channel_credential_active_fingerprint(id,fingerprint,credential_id,channel_account_id,credential_type) VALUES(gen_random_uuid(),${credential.secret_fingerprint},${credential.id}::uuid,${input.channelAccountId}::uuid,${credential.credential_type}) ON CONFLICT(credential_id) DO NOTHING`);
      } else {
        await tx.$executeRaw(Prisma.sql`DELETE FROM channel_credential_active_fingerprint WHERE credential_id=${credential.id}::uuid`);
      }
      await tx.credentialChangeLog.create({ data: { channelAccountId: input.channelAccountId, credentialId: credential.id, actorType: "admin", actorId: input.actorId, action: "validate", newFingerprint: credential.fingerprint_prefix, detail: { status: validation.status }, } });
      await tx.operationAudit.create({ data: { actorType: "admin", actorId: input.actorId, action: "credential.validate.completed", entityType: "ChannelAccountCredential", entityId: credential.id, requestId: input.mutationRequestId, taskType: lease.taskType, taskId: lease.taskId } });
    } };
  };
}

export function createCredentialSupersedeHandler(db: PrismaClient): TaskHandler {
  return async ({ lease }) => {
    const input = payload(lease.payload);
    const accounts = await db.$queryRaw<Array<{ status: string }>>`SELECT status FROM channel_account WHERE id=${input.channelAccountId}::uuid AND deleted_at IS NULL`;
    if (accounts[0]?.status !== "active") return { status: "failed", error: { code: "account_inactive", message: "Channel account is inactive" } };
    const metadata = await db.$queryRaw<Array<{ fingerprint_prefix: string; expires_at: Date | null; last_validated_at: Date | null; status: string }>>`
      SELECT fingerprint_prefix,expires_at,last_validated_at,status
      FROM channel_account_credential
      WHERE id=${input.credentialId}::uuid AND channel_account_id=${input.channelAccountId}::uuid
    `;
    if (!metadata[0]) return { status: "failed", error: { code: "credential_missing", message: "Credential is missing" } };
    if (metadata[0].status !== "active") return { status: "failed", error: { code: "credential_validation_failed", message: "Only an active credential may be superseded" } };
    const result: CredentialRedactedResult = {
      code: null, credentialId: input.credentialId, status: "superseded",
      expiresAt: metadata[0].expires_at?.toISOString() ?? null,
      lastValidatedAt: metadata[0].last_validated_at?.toISOString() ?? null,
      fingerprintPrefix: metadata[0].fingerprint_prefix,
    };
    return { status: "success", result, protectedWrite: async (tx) => {
      const rows = await tx.$queryRaw<Array<{ fingerprint_prefix: string; expires_at: Date | null; last_validated_at: Date | null }>>(Prisma.sql`
        UPDATE channel_account_credential SET status='superseded',updated_at=transaction_timestamp()
        WHERE id=${input.credentialId}::uuid AND channel_account_id=${input.channelAccountId}::uuid AND status='active'
        RETURNING fingerprint_prefix,expires_at,last_validated_at
      `);
      if (rows.length !== 1) throw new Error("credential_validation_failed");
      await tx.$executeRaw(Prisma.sql`DELETE FROM channel_credential_active_fingerprint WHERE credential_id=${input.credentialId}::uuid`);
      await tx.credentialChangeLog.create({ data: { channelAccountId: input.channelAccountId, credentialId: input.credentialId, actorType: "admin", actorId: input.actorId, action: "supersede", oldFingerprint: rows[0].fingerprint_prefix, reason: "explicit_admin_supersede" } });
      await tx.operationAudit.create({ data: { actorType: "admin", actorId: input.actorId, action: "credential.supersede.completed", entityType: "ChannelAccountCredential", entityId: input.credentialId, requestId: input.mutationRequestId, taskType: lease.taskType, taskId: lease.taskId } });
    } };
  };
}

export function createCredentialWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({
    [CREDENTIAL_TASK_TYPES.validate]: { family: "generic", maxAttempts: 3, handler: createCredentialValidateHandler(db) },
    [CREDENTIAL_TASK_TYPES.supersede]: { family: "generic", maxAttempts: 3, handler: createCredentialSupersedeHandler(db) },
  });
}
