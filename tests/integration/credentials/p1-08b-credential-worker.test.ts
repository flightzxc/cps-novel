import { randomBytes, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { hashAdminSessionToken } from "@/lib/auth";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { CREDENTIAL_TASK_TYPES } from "@/lib/credentials/contracts";
import { buildWorkerAllowlist } from "@/lib/tasks";
import { requireAdminActionAccess } from "@/server/auth/guards";
import {
  P1_08B_ADMIN_REGISTRY,
  addOrReplaceCredential,
} from "@/server/credentials";
import {
  encryptCredentialSecretForWorker,
  fingerprintCredentialSecretForWorker,
} from "../../../worker/credentials/crypto";
import { createCredentialWorkerHandlers } from "../../../worker/handlers/credential";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";
import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";

const enabled = process.env.P1_08B_DATABASE_TEST === "1";
const databaseUrl = process.env.P1_08B_WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
const ownerUrl = process.env.P1_08B_OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
const owner = new PrismaClient({ datasourceUrl: ownerUrl });
const web = new PrismaClient({ datasourceUrl: process.env.P1_08B_WEB_DATABASE_URL ?? databaseUrl });
const webSecond = new PrismaClient({ datasourceUrl: process.env.P1_08B_WEB_DATABASE_URL ?? databaseUrl });
const worker = new PrismaClient({ datasourceUrl: databaseUrl });
const channelId = "08000000-0000-4000-8000-000000000001";
const accountId = "08000000-0000-4000-8000-000000000002";

function jwt(exp: number) {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

async function ingressAuthorization(requestId: string, now: Date, actorId = "p108b-web-admin") {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: actorId,
    username: actorId,
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const token = `p108b-session-${actorId}-${requestId}`;
  const session: AdminSessionRecord = {
    id: randomUUID(),
    tokenHash: hashAdminSessionToken(token),
    identityId: identity.id,
    sessionVersion: 1,
    issuedAt: new Date(now.getTime() - 60_000),
    lastSeenAt: now,
    absoluteExpiresAt: new Date(now.getTime() + 3_600_000),
    twoFactorCompletedAt: now,
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  const guarded = await requireAdminActionAccess({
    actionId: "admin.credential.replace",
    sessionToken: token,
    origin: "https://admin.example.com",
    canonicalOrigin: "https://admin.example.com",
    requestId,
  }, {
    identities: stores,
    sessions: stores,
    registry: P1_08B_ADMIN_REGISTRY,
    now,
  });
  return { stores, authorization: guarded.serviceAuthorization! };
}

async function ingest(input: {
  secret: string;
  requestId?: string;
  channelAccountId?: string;
  now?: Date;
  reason?: string;
  actorId?: string;
  db?: PrismaClient;
}) {
  const requestId = input.requestId ?? randomUUID();
  const now = input.now ?? new Date("2026-08-04T12:00:00.000Z");
  const guarded = await ingressAuthorization(requestId, now, input.actorId);
  return addOrReplaceCredential({
    authorization: guarded.authorization,
    requestId,
    channelAccountId: input.channelAccountId ?? accountId,
    secret: input.secret,
    reason: input.reason ?? "Owner-approved credential rotation",
  }, {
    db: input.db ?? web,
    identities: guarded.stores,
    sessions: guarded.stores,
    now,
    env: process.env,
  });
}

async function mutationCounts() {
  return {
    credentials: await owner.channelAccountCredential.count(),
    activeCredentials: await owner.channelAccountCredential.count({ where: { status: "active" } }),
    changes: await owner.credentialChangeLog.count(),
    audits: await owner.operationAudit.count({ where: { action: "credential.replace.completed" } }),
  };
}

async function captureFailure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}

function expectIdempotencyConflict(error: unknown) {
  const expected = {
    status: 409,
    code: "admin_mutation_request_id_invalid",
    details: { reason: "idempotency_conflict" },
  };
  expect(error).toMatchObject(expected);
  expect(JSON.parse(JSON.stringify(error))).toEqual(expected);
}

async function createCredential(secret: string, status: "active" | "superseded" | "expired" | "invalid" = "active") {
  const credentialId = randomUUID();
  const fingerprint = fingerprintCredentialSecretForWorker(secret);
  await owner.channelAccountCredential.create({ data: {
    id: credentialId, channelAccountId: accountId, credentialType: "bearer_jwt",
    encryptedSecret: Uint8Array.from(encryptCredentialSecretForWorker(secret, accountId, credentialId)),
    keyVersion: 1, secretFingerprint: fingerprint.full, fingerprintPrefix: fingerprint.prefix, status,
  } });
  if (status === "active") await owner.channelCredentialActiveFingerprint.create({ data: {
    fingerprint: fingerprint.full, credentialId, channelAccountId: accountId, credentialType: "bearer_jwt",
  } });
  return credentialId;
}

async function enqueue(operation: "validate" | "supersede", credentialId: string) {
  const taskType = operation === "validate" ? CREDENTIAL_TASK_TYPES.validate : CREDENTIAL_TASK_TYPES.supersede;
  const mutationRequestId = randomUUID();
  return owner.genericTask.create({ data: {
    taskType, channelAccountId: accountId, operationScopeHash: randomBytes(32).toString("hex"),
    requestToken: `p108b:${mutationRequestId}`, totalCount: 1,
    items: { create: [{ targetType: "credential", targetId: credentialId, payload: {
      channelAccountId: accountId, credentialId, actorId: "p108b-admin", mutationRequestId, operation,
    } }] },
  }, include: { items: true } });
}

async function cycle() {
  const handlers = createCredentialWorkerHandlers(worker);
  return processOneWorkerCycle({
    prisma: worker, workerId: "p108b-worker", handlers,
    allowlist: buildWorkerAllowlist(`${CREDENTIAL_TASK_TYPES.validate},${CREDENTIAL_TASK_TYPES.supersede}`, handlers),
    signal: new AbortController().signal, leaseMs: 30_000,
  });
}

describe.skipIf(!enabled).sequential("P1-08B Credential Worker", () => {
  beforeAll(async () => {
    if (!process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1 || !process.env.CHANNEL_CREDENTIAL_FINGERPRINT_KEY) {
      throw new Error("Disposable Worker credential keys are required");
    }
  });

  beforeEach(async () => {
    await owner.$executeRawUnsafe("TRUNCATE operation_audit RESTART IDENTITY");
    await owner.$executeRawUnsafe("TRUNCATE channel CASCADE");
    await owner.channel.create({ data: { id: channelId, code: `p108b-${randomUUID()}`, name: "P1-08B" } });
    await owner.channelAccount.create({ data: { id: accountId, channelId, businessId: randomUUID(), accountName: "P1-08B account", status: "active" } });
  });

  afterAll(async () => { await Promise.all([
    owner.$disconnect(),
    web.$disconnect(),
    webSecond.$disconnect(),
    worker.$disconnect(),
  ]); });

  it("adds a valid JWT synchronously without a task or plaintext leak", async () => {
    const marker = `P108B_WEB_SECRET_${randomUUID()}`;
    const secret = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 1_900_000_000, marker })).toString("base64url")}.signature`;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await ingest({ secret });
      expect(result).toMatchObject({ status: "active", fingerprintPrefix: expect.any(String) });
      expect(result).not.toHaveProperty("secret");
      expect(result).not.toHaveProperty("encryptedSecret");
      expect(await owner.genericTask.count()).toBe(0);

      const stored = await owner.channelAccountCredential.findUniqueOrThrow({
        where: { id: result.credentialId },
      });
      expect(Buffer.from(stored.encryptedSecret).toString("utf8")).not.toContain(secret);
      const evidence = {
        response: result,
        audits: await owner.operationAudit.findMany(),
        changes: await owner.credentialChangeLog.findMany(),
        tasks: await owner.genericTask.findMany({ include: { items: true } }),
        logs: [...log.mock.calls, ...error.mock.calls],
      };
      const serialized = JSON.stringify(
        evidence,
        (_key, value) => typeof value === "bigint" ? value.toString() : value,
      );
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(marker);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("stores an expired JWT as expired and rejects malformed JWTs with zero writes", async () => {
    const expired = await ingest({ secret: jwt(1) });
    expect(expired.status).toBe("expired");
    const before = await owner.channelAccountCredential.count();
    await expect(ingest({ secret: `malformed-${randomUUID()}` })).rejects.toMatchObject({
      code: "credential_validation_failed",
    });
    const validSecret = jwt(1_900_000_000);
    await expect(ingest({ secret: validSecret, reason: validSecret })).rejects.toMatchObject({
      code: "credential_validation_failed",
    });
    expect(await owner.channelAccountCredential.count()).toBe(before);
    expect(await owner.operationAudit.count()).toBe(1);
    expect(await owner.credentialChangeLog.count()).toBe(1);
  });

  it("replaces the old active row and makes mutationRequestId retries idempotent", async () => {
    const first = await ingest({ secret: jwt(1_900_000_000) });
    const requestId = randomUUID();
    const nextSecret = jwt(1_910_000_000);
    const replaced = await ingest({ secret: nextSecret, requestId });
    const replayed = await ingest({ secret: nextSecret, requestId });
    expect(replayed).toEqual(replaced);
    expect(await owner.channelAccountCredential.findUniqueOrThrow({ where: { id: first.credentialId } })).toMatchObject({ status: "superseded" });
    expect(await owner.channelAccountCredential.count()).toBe(2);
    expect(await owner.channelAccountCredential.count({ where: { status: "active" } })).toBe(1);
    expect(await owner.credentialChangeLog.count()).toBe(2);
    expect(await owner.operationAudit.count({ where: { action: "credential.replace.completed" } })).toBe(2);
    expect(await owner.operationAudit.count({ where: { requestId } })).toBe(1);
    expect(await owner.genericTask.count()).toBe(0);
  });

  it("coalesces concurrent identical retries from independent Web connections", async () => {
    const old = await ingest({ secret: jwt(1_900_000_000) });
    const requestId = randomUUID();
    const secret = jwt(1_910_000_000);
    const [first, second] = await Promise.all([
      ingest({ secret, requestId, db: web }),
      ingest({ secret, requestId, db: webSecond }),
    ]);

    expect(second).toEqual(first);
    expect(await owner.channelAccountCredential.findUniqueOrThrow({
      where: { id: old.credentialId },
    })).toMatchObject({ status: "superseded" });
    expect(await mutationCounts()).toEqual({
      credentials: 2,
      activeCredentials: 1,
      changes: 2,
      audits: 2,
    });
    expect(await owner.operationAudit.count({ where: { requestId } })).toBe(1);
  });

  it("rejects cross-actor requestId reuse without exposing or writing the first result", async () => {
    const requestId = randomUUID();
    const secret = jwt(1_900_000_000);
    const committed = await ingest({ secret, requestId, actorId: "p108b-actor-one" });
    const before = await mutationCounts();
    const error = await captureFailure(() => ingest({
      secret,
      requestId,
      actorId: "p108b-actor-two",
    }));

    expectIdempotencyConflict(error);
    expect(JSON.stringify(error)).not.toContain(committed.credentialId);
    expect(JSON.stringify(error)).not.toContain(committed.fingerprintPrefix);
    expect(await mutationCounts()).toEqual(before);
  });

  it("rejects cross-account requestId reuse with zero additional writes", async () => {
    const requestId = randomUUID();
    const secret = jwt(1_900_000_000);
    await ingest({ secret, requestId });
    const secondAccountId = randomUUID();
    await owner.channelAccount.create({ data: {
      id: secondAccountId,
      channelId,
      businessId: randomUUID(),
      accountName: "P1-08B idempotency conflict account",
      status: "active",
    } });
    const before = await mutationCounts();
    const error = await captureFailure(() => ingest({
      secret,
      requestId,
      channelAccountId: secondAccountId,
    }));

    expectIdempotencyConflict(error);
    expect(await mutationCounts()).toEqual(before);
    expect(await owner.channelAccountCredential.count({
      where: { channelAccountId: secondAccountId },
    })).toBe(0);
  });

  it("rejects requestId reuse with a different JWT and preserves the committed active row", async () => {
    const requestId = randomUUID();
    const committed = await ingest({ secret: jwt(1_900_000_000), requestId });
    const before = await mutationCounts();
    const error = await captureFailure(() => ingest({
      secret: jwt(1_910_000_000),
      requestId,
    }));

    expectIdempotencyConflict(error);
    expect(await mutationCounts()).toEqual(before);
    expect(await owner.channelAccountCredential.findUniqueOrThrow({
      where: { id: committed.credentialId },
    })).toMatchObject({ status: "active" });
  });

  it("allows one concurrent payload and explicitly conflicts the mismatched retry", async () => {
    const requestId = randomUUID();
    const outcomes = await Promise.allSettled([
      ingest({ secret: jwt(1_900_000_000), requestId, db: web }),
      ingest({ secret: jwt(1_910_000_000), requestId, db: webSecond }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectIdempotencyConflict((rejected[0] as PromiseRejectedResult).reason);
    expect(await mutationCounts()).toEqual({
      credentials: 1,
      activeCredentials: 1,
      changes: 1,
      audits: 1,
    });
    expect(await owner.operationAudit.count({ where: { requestId } })).toBe(1);
  });

  it("returns stable account and fingerprint conflicts without partial replacement", async () => {
    const secret = jwt(1_900_000_000);
    const first = await ingest({ secret });
    await owner.channelAccount.update({ where: { id: accountId }, data: { status: "disabled" } });
    await expect(ingest({ secret: jwt(1_920_000_000) })).rejects.toMatchObject({ code: "account_inactive" });
    expect(await owner.channelAccountCredential.findUniqueOrThrow({ where: { id: first.credentialId } })).toMatchObject({ status: "active" });

    const secondAccountId = randomUUID();
    await owner.channelAccount.create({ data: {
      id: secondAccountId,
      channelId,
      businessId: randomUUID(),
      accountName: "P1-08B second account",
      status: "active",
    } });
    await expect(ingest({ secret, channelAccountId: secondAccountId })).rejects.toMatchObject({
      code: "credential_fingerprint_conflict",
    });
    expect(await owner.channelAccountCredential.count({ where: { channelAccountId: secondAccountId } })).toBe(0);
    expect(await owner.credentialChangeLog.count({ where: { channelAccountId: secondAccountId } })).toBe(0);
  });

  it("validates locally, updates lastValidatedAt, and persists only a redacted result", async () => {
    const credentialId = await createCredential(jwt(Math.floor(Date.now() / 1000) + 3600), "invalid");
    const task = await enqueue("validate", credentialId);
    expect(JSON.stringify(task.items[0].payload)).not.toMatch(/secret|ciphertext|fingerprint|jwt/i);
    expect(await cycle()).toBe(true);
    const credential = await owner.channelAccountCredential.findUniqueOrThrow({ where: { id: credentialId } });
    const item = await owner.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } });
    expect(credential.status).toBe("active");
    expect(credential.lastValidatedAt).toBeInstanceOf(Date);
    expect(item.status).toBe("success");
    expect(item.result).toMatchObject({ code: null, credentialId, status: "active", fingerprintPrefix: credential.fingerprintPrefix });
    expect(JSON.stringify(item.result)).not.toMatch(/secret|ciphertext|stack|database|hmac-sha256/i);
  });

  it("marks expired and malformed JWTs without network calls", async () => {
    for (const [secret, expectedStatus, expectedCode] of [
      [jwt(1), "expired", "credential_expired"],
      ["malformed", "invalid", "credential_validation_failed"],
    ] as const) {
      const credentialId = await createCredential(secret, "invalid");
      const task = await enqueue("validate", credentialId);
      await cycle();
      expect(await owner.channelAccountCredential.findUniqueOrThrow({ where: { id: credentialId } })).toMatchObject({ status: expectedStatus });
      expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } })).toMatchObject({ result: expect.objectContaining({ code: expectedCode, status: expectedStatus }) });
    }
  });

  it("never reactivates superseded credentials", async () => {
    const credentialId = await createCredential(jwt(Math.floor(Date.now() / 1000) + 3600), "superseded");
    const task = await enqueue("validate", credentialId);
    await cycle();
    expect(await owner.channelAccountCredential.findUniqueOrThrow({ where: { id: credentialId } })).toMatchObject({ status: "superseded", lastValidatedAt: null });
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } })).toMatchObject({ status: "failed", error: expect.objectContaining({ code: "credential_validation_failed" }) });
  });

  it("supersedes only active credentials and releases the fingerprint latch", async () => {
    const credentialId = await createCredential(jwt(Math.floor(Date.now() / 1000) + 3600));
    const task = await enqueue("supersede", credentialId);
    await cycle();
    expect(await owner.channelAccountCredential.findUniqueOrThrow({ where: { id: credentialId } })).toMatchObject({ status: "superseded" });
    expect(await owner.channelCredentialActiveFingerprint.count({ where: { credentialId } })).toBe(0);
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } })).toMatchObject({ status: "success", result: expect.objectContaining({ status: "superseded" }) });
  });

  it("returns account_inactive and prevents ambiguous active rows at the database boundary", async () => {
    const credentialId = await createCredential(jwt(Math.floor(Date.now() / 1000) + 3600));
    await owner.channelAccount.update({ where: { id: accountId }, data: { status: "disabled" } });
    const inactive = await enqueue("validate", credentialId);
    await cycle();
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: inactive.items[0].id } })).toMatchObject({ error: expect.objectContaining({ code: "account_inactive" }) });

    await owner.channelAccount.update({ where: { id: accountId }, data: { status: "active" } });
    await expect(createCredential(jwt(Math.floor(Date.now() / 1000) + 7200))).rejects.toThrow();
    expect(await owner.channelAccountCredential.count({ where: { channelAccountId: accountId, status: "active" } })).toBe(1);
  });

  it("uses the database UNIQUE constraint as final fingerprint arbitration", async () => {
    const first = await createCredential(jwt(Math.floor(Date.now() / 1000) + 3600));
    const second = await createCredential(jwt(Math.floor(Date.now() / 1000) + 7200), "invalid");
    const latch = await owner.channelCredentialActiveFingerprint.findUniqueOrThrow({ where: { credentialId: first } });
    await expect(owner.channelCredentialActiveFingerprint.create({ data: {
      fingerprint: latch.fingerprint, credentialId: second, channelAccountId: accountId, credentialType: "bearer_jwt",
    } })).rejects.toThrow();
    expect(await owner.channelCredentialActiveFingerprint.count({ where: { fingerprint: latch.fingerprint } })).toBe(1);
  });
});
