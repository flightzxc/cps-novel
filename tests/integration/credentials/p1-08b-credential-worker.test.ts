import { randomBytes, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CREDENTIAL_TASK_TYPES } from "@/lib/credentials/contracts";
import { buildWorkerAllowlist } from "@/lib/tasks";
import {
  encryptCredentialSecretForWorker,
  fingerprintCredentialSecretForWorker,
} from "../../../worker/credentials/crypto";
import { createCredentialWorkerHandlers } from "../../../worker/handlers/credential";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";

const enabled = process.env.P1_08B_DATABASE_TEST === "1";
const databaseUrl = process.env.P1_08B_WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
const ownerUrl = process.env.P1_08B_OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
const owner = new PrismaClient({ datasourceUrl: ownerUrl });
const worker = new PrismaClient({ datasourceUrl: databaseUrl });
const channelId = "08000000-0000-4000-8000-000000000001";
const accountId = "08000000-0000-4000-8000-000000000002";

function jwt(exp: number) {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
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
    await owner.$executeRawUnsafe("TRUNCATE channel CASCADE");
    await owner.channel.create({ data: { id: channelId, code: `p108b-${randomUUID()}`, name: "P1-08B" } });
    await owner.channelAccount.create({ data: { id: accountId, channelId, businessId: randomUUID(), accountName: "P1-08B account", status: "active" } });
  });

  afterAll(async () => { await Promise.all([owner.$disconnect(), worker.$disconnect()]); });

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
