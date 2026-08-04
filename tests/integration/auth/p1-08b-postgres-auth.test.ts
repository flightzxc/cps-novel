import { randomBytes, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgreSQLAdminIdentityStore,
  PostgreSQLAuthUnitOfWork,
  PostgreSQLLoginAttemptStore,
  PostgreSQLSessionStore,
  PostgreSQLTwoFactorStore,
  authenticateAdminLogin,
  hashAdminPassword,
  hashAdminSessionToken,
  hashLoginAttemptIdentifier,
  requireAdminSession,
} from "@/lib/auth";
import type { AuthTransactionStage } from "@/lib/auth/postgres";
import { requireAdminActionAccess } from "@/server/auth/guards";
import { P1_08B_ADMIN_REGISTRY, createChannelAccount, enqueueCredentialOperation } from "@/server/credentials";

const enabled = process.env.P1_08B_DATABASE_TEST === "1";
const url = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};

const owner = new PrismaClient({ datasourceUrl: url("P1_08B_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: url("P1_08B_WEB_DATABASE_URL") });
const worker = new PrismaClient({ datasourceUrl: url("P1_08B_WORKER_DATABASE_URL") });
const scheduler = new PrismaClient({ datasourceUrl: url("P1_08B_SCHEDULER_DATABASE_URL") });
const analyst = new PrismaClient({ datasourceUrl: url("P1_08B_ANALYST_DATABASE_URL") });

async function denied(action: () => Promise<unknown>) {
  await expect(action()).rejects.toThrow();
}

async function clearAuth() {
  await owner.$executeRawUnsafe("TRUNCATE admin_identity CASCADE");
  await owner.$executeRawUnsafe("TRUNCATE admin_login_attempt");
}

async function seedRecoveryTransaction() {
  const now = new Date("2026-08-04T04:00:00.000Z");
  const identityId = randomUUID();
  const boundSessionId = randomUUID();
  const oldSessionId = randomUUID();
  const challengeId = randomUUID();
  const recoveryCodeId = randomUUID();
  const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  await owner.adminIdentity.create({ data: {
    id: identityId, username: `admin-${identityId}`, passwordHash: hashAdminPassword("correct horse battery staple"),
    role: "super_admin", status: "active", sessionVersion: 0,
    twoFactor: { create: { enabled: true, encryptedSecret: "totp-envelope", keyVersion: 1, confirmedAt: now } },
  } });
  const sessions = [boundSessionId, oldSessionId].map((id, index) => ({
    id, identityId, tokenHash: hashAdminSessionToken(tokens[index]), sessionVersion: 0,
    issuedAt: new Date(now.getTime() - 60_000), lastSeenAt: now,
    absoluteExpiresAt: new Date(now.getTime() + 3_600_000),
    twoFactorCompletedAt: index === 0 ? null : now, revokedAt: null,
  }));
  await owner.adminSession.createMany({ data: sessions });
  await owner.adminTwoFactorChallenge.create({ data: {
    id: challengeId, identityId, sessionId: boundSessionId,
    tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(now.getTime() + 300_000), createdAt: now,
  } });
  await owner.adminRecoveryCode.create({ data: {
    id: recoveryCodeId, identityId,
    codeHash: "scrypt$v1$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  } });
  return { now, identityId, boundSessionId, oldSessionId, challengeId, recoveryCodeId, sessions, tokens };
}

describe.skipIf(!enabled).sequential("P1-08B PostgreSQL Auth persistence", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName, version }] = await owner.$queryRawUnsafe<Array<{ database_name: string; version: string }>>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS version",
    );
    if (!databaseName.includes("p1_08b")) throw new Error(`Refusing P1-08B tests against ${databaseName}`);
    if (!version.startsWith("16.14")) throw new Error(`PostgreSQL 16.14 required, got ${version}`);
  });

  afterAll(async () => {
    await Promise.all([owner, web, worker, scheduler, analyst].map((client) => client.$disconnect()));
  });

  it("enforces real runtime-role Auth and Credential secret boundaries", async () => {
    const users = await Promise.all([web, worker, scheduler, analyst].map(async (client) =>
      (await client.$queryRawUnsafe<Array<{ current_user: string }>>("SELECT current_user"))[0].current_user));
    expect(users).toEqual(["web_app", "worker_app", "scheduler_app", "analyst_ro"]);
    expect(await web.$queryRawUnsafe("SELECT username, status FROM admin_identity LIMIT 0")).toEqual([]);
    await denied(() => worker.$queryRawUnsafe("SELECT password_hash FROM admin_identity LIMIT 1"));
    await denied(() => worker.$queryRawUnsafe("SELECT token_hash FROM admin_session LIMIT 1"));
    await denied(() => scheduler.$queryRawUnsafe("SELECT encrypted_secret FROM channel_account_credential LIMIT 1"));
    await denied(() => analyst.$queryRawUnsafe("SELECT password_hash FROM admin_identity LIMIT 1"));
    await denied(() => analyst.$queryRawUnsafe("SELECT encrypted_secret FROM channel_account_credential LIMIT 1"));
    for (const client of [web, worker, scheduler, analyst]) {
      await denied(() => client.$executeRawUnsafe("CREATE TABLE p108b_denied (id int)"));
    }
  });

  it("returns a raw Session token once and persists only its SHA-256 hash", async () => {
    await clearAuth();
    await owner.adminIdentity.create({ data: {
      username: "owner@example.com", passwordHash: hashAdminPassword("correct horse battery staple"),
      role: "super_admin", status: "active",
    } });
    const identities = new PostgreSQLAdminIdentityStore(web);
    const sessions = new PostgreSQLSessionStore(web);
    const attempts = new PostgreSQLLoginAttemptStore(web);
    const login = await authenticateAdminLogin({
      username: " OWNER@example.com ", password: "correct horse battery staple", ip: "192.0.2.10",
      identities, sessions, attempts, now: new Date("2026-08-04T04:00:00.000Z"),
    });
    const stored = await owner.adminSession.findUniqueOrThrow({ where: { id: login.context.session.id } });
    expect(stored.tokenHash).toBe(hashAdminSessionToken(login.token));
    expect(stored.tokenHash).not.toBe(login.token);
    expect(await requireAdminSession(login.token, { identities, sessions, now: new Date("2026-08-04T04:16:00.000Z") })).toMatchObject({ twoFactorCompleted: false });
    expect((await owner.adminSession.findUniqueOrThrow({ where: { id: stored.id } })).lastSeenAt.toISOString()).toBe("2026-08-04T04:16:00.000Z");
    expect(await sessions.revoke(stored.id, new Date("2026-08-04T04:17:00.000Z"))).toBe(true);
    await expect(requireAdminSession(login.token, { identities, sessions, now: new Date("2026-08-04T04:18:00.000Z") })).rejects.toMatchObject({ code: "jwt_invalid", status: 401 });
  });

  it("atomically counts concurrent failures and clears only the username bucket", async () => {
    await clearAuth();
    const store = new PostgreSQLLoginAttemptStore(web);
    const now = new Date("2026-08-04T05:00:00.000Z");
    const usernameHash = hashLoginAttemptIdentifier("user", "admin@example.com");
    const ipHash = hashLoginAttemptIdentifier("ip", "192.0.2.20");
    await Promise.all(Array.from({ length: 8 }, () => store.recordFailure({ identifierHash: usernameHash, now, windowMs: 900_000, maxFailures: 5 })));
    expect(await store.find(usernameHash)).toMatchObject({ failureCount: 8 });
    await store.recordFailure({ identifierHash: ipHash, now, windowMs: 900_000, maxFailures: 5 });
    await store.clear(usernameHash);
    expect(await store.find(usernameHash)).toBeNull();
    expect(await store.find(ipHash)).toMatchObject({ failureCount: 1 });
  });

  it("uses CAS so concurrent invalid challenge attempts stop at five", async () => {
    await clearAuth();
    const seeded = await seedRecoveryTransaction();
    const store = new PostgreSQLTwoFactorStore(web);
    const results = await Promise.all(Array.from({ length: 9 }, () => store.incrementChallengeAttempts({ challengeId: seeded.challengeId, now: seeded.now, maxAttempts: 5 })));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect((await owner.adminTwoFactorChallenge.findUniqueOrThrow({ where: { id: seeded.challengeId } })).attemptCount).toBe(5);
  });

  it("rolls back all five recovery completion mutations at every injected failure", async () => {
    const stages: AuthTransactionStage[] = ["recovery_code", "challenge_consumed", "identity_session_version", "bound_session_version", "two_factor_completed"];
    for (const stage of stages) {
      await clearAuth();
      const seeded = await seedRecoveryTransaction();
      const uow = new PostgreSQLAuthUnitOfWork(web, (current) => { if (current === stage) throw new Error(`inject:${stage}`); });
      await expect(uow.completeTwoFactorChallenge({
        challengeId: seeded.challengeId, identityId: seeded.identityId, sessionId: seeded.boundSessionId,
        completedAt: seeded.now, recoveryCodeId: seeded.recoveryCodeId,
      })).rejects.toThrow(`inject:${stage}`);
      expect(await owner.adminRecoveryCode.findUniqueOrThrow({ where: { id: seeded.recoveryCodeId } })).toMatchObject({ usedAt: null });
      expect(await owner.adminTwoFactorChallenge.findUniqueOrThrow({ where: { id: seeded.challengeId } })).toMatchObject({ consumedAt: null });
      expect(await owner.adminIdentity.findUniqueOrThrow({ where: { id: seeded.identityId } })).toMatchObject({ sessionVersion: 0 });
      expect(await owner.adminSession.findUniqueOrThrow({ where: { id: seeded.boundSessionId } })).toMatchObject({ sessionVersion: 0, twoFactorCompletedAt: null });
    }
  });

  it("rolls back setup enablement, recovery rotation, and Session version advance", async () => {
    for (const stage of ["setup_enabled", "setup_recovery", "setup_version"] as const) {
      await clearAuth();
      const identityId = randomUUID();
      const pending = `totp-pending-${randomUUID()}`;
      const now = new Date("2026-08-04T05:30:00.000Z");
      await owner.adminIdentity.create({ data: {
        id: identityId, username: `setup-${identityId}`, passwordHash: hashAdminPassword("correct horse battery staple"),
        role: "super_admin", twoFactor: { create: { pendingEncryptedSecret: pending, pendingKeyVersion: 1, pendingExpiresAt: new Date(now.getTime() + 600_000) } },
      } });
      const uow = new PostgreSQLAuthUnitOfWork(web, (current) => { if (current === stage) throw new Error(`inject:${stage}`); });
      await expect(uow.confirmTwoFactorSetup({
        identityId, expectedSessionVersion: 0, expectedPendingEncryptedSecret: pending, confirmedAt: now,
        recoveryCodes: Array.from({ length: 10 }, () => ({
          id: randomUUID(),
          codeHash: `scrypt$v1$16384$8$1$${randomBytes(16).toString("base64")}$${randomBytes(32).toString("base64")}`,
        })),
      })).rejects.toThrow(`inject:${stage}`);
      expect(await owner.adminIdentity.findUniqueOrThrow({ where: { id: identityId } })).toMatchObject({ sessionVersion: 0 });
      expect(await owner.adminTwoFactor.findUniqueOrThrow({ where: { identityId } })).toMatchObject({ enabled: false, encryptedSecret: null, pendingEncryptedSecret: pending });
      expect(await owner.adminRecoveryCode.count({ where: { identityId } })).toBe(0);
    }
  });

  it("invalidates old Sessions while preserving the bound Session after recovery", async () => {
    await clearAuth();
    const seeded = await seedRecoveryTransaction();
    const result = await new PostgreSQLAuthUnitOfWork(web).completeTwoFactorChallenge({
      challengeId: seeded.challengeId, identityId: seeded.identityId, sessionId: seeded.boundSessionId,
      completedAt: seeded.now, recoveryCodeId: seeded.recoveryCodeId,
    });
    expect(result).toEqual({ status: "committed", sessionVersion: 1 });
    const identity = await new PostgreSQLAdminIdentityStore(web).findById(seeded.identityId);
    expect(identity?.sessionVersion).toBe(1);
    const bound = await owner.adminSession.findUniqueOrThrow({ where: { id: seeded.boundSessionId } });
    const old = await owner.adminSession.findUniqueOrThrow({ where: { id: seeded.oldSessionId } });
    expect(bound).toMatchObject({ sessionVersion: 1, twoFactorCompletedAt: seeded.now });
    expect(old.sessionVersion).toBe(0);
    const sessionStore = new PostgreSQLSessionStore(web);
    const identityStore = new PostgreSQLAdminIdentityStore(web);
    expect(await requireAdminSession(seeded.tokens[0], { identities: identityStore, sessions: sessionStore, now: seeded.now })).toMatchObject({ twoFactorCompleted: true });
    await expect(requireAdminSession(seeded.tokens[1], { identities: identityStore, sessions: sessionStore, now: seeded.now })).rejects.toMatchObject({ code: "jwt_invalid" });
  });

  it("returns committed account and task results for concurrent request-id replays", async () => {
    await clearAuth();
    const now = new Date();
    const identityId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    await owner.adminIdentity.create({ data: {
      id: identityId, username: `idempotency-${identityId}`, passwordHash: hashAdminPassword("correct horse battery staple"),
      role: "super_admin", twoFactor: { create: { enabled: true, encryptedSecret: "totp-envelope", keyVersion: 1, confirmedAt: now } },
      sessions: { create: { id: sessionId, tokenHash: hashAdminSessionToken(token), sessionVersion: 0, issuedAt: now, lastSeenAt: now, absoluteExpiresAt: new Date(now.getTime() + 3_600_000), twoFactorCompletedAt: now } },
    } });
    const identities = new PostgreSQLAdminIdentityStore(web);
    const sessions = new PostgreSQLSessionStore(web);
    const dependencies = { db: web, identities, sessions, now };
    const guard = (actionId: "admin.channel_account.create" | "admin.credential.validate", requestId: string) => requireAdminActionAccess({
      actionId, sessionToken: token, origin: "https://admin.example.test", canonicalOrigin: "https://admin.example.test", requestId,
    }, { identities, sessions, registry: P1_08B_ADMIN_REGISTRY, now });

    const channel = await owner.channel.create({ data: { code: `p108b-idempotency-${randomUUID()}`, name: "P1-08B idempotency" } });
    const accountRequestId = randomUUID();
    const [leftGuard, rightGuard] = await Promise.all([guard("admin.channel_account.create", accountRequestId), guard("admin.channel_account.create", accountRequestId)]);
    const accountInput = { requestId: accountRequestId, channelId: channel.id, businessId: randomUUID(), accountName: "Replay account" };
    const accounts = await Promise.all([
      createChannelAccount({ ...accountInput, authorization: leftGuard.serviceAuthorization! }, dependencies),
      createChannelAccount({ ...accountInput, authorization: rightGuard.serviceAuthorization! }, dependencies),
    ]);
    expect(accounts[0]?.id).toBe(accounts[1]?.id);

    const credential = await owner.channelAccountCredential.create({ data: {
      channelAccountId: accounts[0]!.id, credentialType: "bearer_jwt", encryptedSecret: Uint8Array.from([1]), keyVersion: 1,
      secretFingerprint: `p108b:${randomUUID()}`, fingerprintPrefix: "p108b", status: "invalid",
    } });
    const taskRequestId = randomUUID();
    const [taskLeft, taskRight] = await Promise.all([guard("admin.credential.validate", taskRequestId), guard("admin.credential.validate", taskRequestId)]);
    const taskInput = { entryId: "admin.credential.validate" as const, requestId: taskRequestId, channelAccountId: accounts[0]!.id, credentialId: credential.id, operation: "validate" as const };
    const queued = await Promise.all([
      enqueueCredentialOperation({ ...taskInput, authorization: taskLeft.serviceAuthorization! }, dependencies),
      enqueueCredentialOperation({ ...taskInput, authorization: taskRight.serviceAuthorization! }, dependencies),
    ]);
    expect(queued[0].taskId).toBe(queued[1].taskId);
    expect(await owner.genericTask.count({ where: { requestToken: `credential:validate:${taskRequestId}` } })).toBe(1);
  });
});
