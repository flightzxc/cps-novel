import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgreSQLAdminIdentityStore, PostgreSQLAuthUnitOfWork, PostgreSQLLoginAttemptStore,
  PostgreSQLSessionStore, PostgreSQLTwoFactorStore, PostgreSQLRecoveryCodeStore,
  authenticateAdminLogin, completeTwoFactorChallenge, confirmTwoFactorSetup,
  createTwoFactorChallenge, encryptTotpSecret, generateTotpCode, generateTotpSecret,
  hashLoginAttemptIdentifier, hashRecoveryCode, requireAdminSession, startTwoFactorSetup,
} from "@/lib/auth";
import { runAddAdminCli, type AddAdminCliOptions } from "../../../scripts/add-admin-identity";
import { runBootstrapAdminCli, type BootstrapAdminCliOptions } from "../../../scripts/bootstrap-admin-identity";
import { runResetAdminAuthStateCli, type ResetAdminAuthStateCliOptions } from "../../../scripts/reset-admin-auth-state";

const enabled = process.env.ADD_ADMIN_IDENTITY_DATABASE_TEST === "1";
function url(name: string): string | undefined {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
}
const owner = new PrismaClient({ datasourceUrl: url("ADD_ADMIN_IDENTITY_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: url("ADD_ADMIN_IDENTITY_WEB_DATABASE_URL") });
const concurrentWeb = new PrismaClient({ datasourceUrl: url("ADD_ADMIN_IDENTITY_WEB_DATABASE_URL") });
const PASSWORD = "correct horse battery staple";
const REASON = "Owner approved secondary preproduction admin account with independent 2FA and equivalent admin permissions";
const REQUEST_ID = "preprod-2026-09-25-add-admin2";
const KEY = randomBytes(32).toString("base64");
let secretDir: string;
let passwordFile: string;
const addOptions = (overrides: Partial<AddAdminCliOptions> = {}): AddAdminCliOptions => ({
  username: "admin2", referenceUsername: "admin", operatorId: "owner", reason: REASON,
  requestId: REQUEST_ID, apply: true, ...overrides,
});
const addEnv = (): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ADD_ADMIN_PASSWORD_FILE: passwordFile, ADD_ADMIN_OPERATOR: "owner" });

describe.skipIf(!enabled).sequential("add admin identity with real PostgreSQL and web_app grants", () => {
  beforeAll(async () => {
    const [{ database_name: name, version }] = await owner.$queryRawUnsafe<Array<{ database_name: string; version: string }>>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS version",
    );
    if (!name.includes("add_admin_identity")) throw new Error(`Refusing add-admin tests against ${name}`);
    if (!version.startsWith("16.14")) throw new Error(`PostgreSQL 16.14 required, got ${version}`);
    secretDir = await mkdtemp(path.join(os.tmpdir(), "add-admin-pg-test-"));
    passwordFile = path.join(secretDir, "password");
    await writeFile(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
  });
  afterAll(async () => {
    await Promise.all([owner, web, concurrentWeb].map((client) => client.$disconnect()));
    if (secretDir) await rm(secretDir, { recursive: true, force: true });
  });

  it("uses web_app to create, independently enroll, replay and deactivate admin2", async () => {
    expect((await web.$queryRawUnsafe<Array<{ current_user: string }>>("SELECT current_user"))[0].current_user).toBe("web_app");
    const bootstrap: BootstrapAdminCliOptions = {
      username: "admin", operatorId: "owner", reason: "initial administrator for test",
      requestId: "add-admin-test-bootstrap", apply: true,
    };
    const first = await runBootstrapAdminCli(owner, bootstrap, { NODE_ENV: "test", BOOTSTRAP_ADMIN_PASSWORD: PASSWORD });
    expect(first.outcome).toBe("created");
    const adminId = first.identityId!;
    const adminSecret = generateTotpSecret();
    await owner.adminTwoFactor.create({ data: {
      identityId: adminId, enabled: true, encryptedSecret: encryptTotpSecret(adminSecret, KEY),
      keyVersion: 1, confirmedAt: new Date(), recoveryCodesRotatedAt: new Date(),
    } });
    await owner.adminRecoveryCode.create({ data: { identityId: adminId, codeHash: hashRecoveryCode("ABCD-EF01-2345") } });

    const identities = new PostgreSQLAdminIdentityStore(web);
    const sessions = new PostgreSQLSessionStore(web);
    const attempts = new PostgreSQLLoginAttemptStore(web);
    const twoFactor = new PostgreSQLTwoFactorStore(web);
    const recoveryCodes = new PostgreSQLRecoveryCodeStore(web);
    const transactions = new PostgreSQLAuthUnitOfWork(web);
    const adminLogin = await authenticateAdminLogin({ username: "admin", password: PASSWORD, ip: "192.0.2.10", identities, sessions, attempts });
    const adminBefore = await owner.adminIdentity.findUniqueOrThrow({ where: { id: adminId }, include: { twoFactor: true } });
    const adminRecoveryBefore = await owner.adminRecoveryCode.count({ where: { identityId: adminId, usedAt: null } });
    const adminSessionBefore = await owner.adminSession.findUniqueOrThrow({ where: { id: adminLogin.context.session.id } });
    const adminSecretDigest = createHash("sha256").update(adminBefore.twoFactor!.encryptedSecret!).digest("hex");

    const dryRun = await runAddAdminCli(web, addOptions({ apply: false }), addEnv());
    expect(dryRun).toMatchObject({ outcome: "eligible", wrote: false });
    expect(await owner.adminIdentity.count()).toBe(1);
    const created = await runAddAdminCli(web, addOptions(), addEnv());
    expect(created).toMatchObject({ outcome: "created", wrote: true });
    const admin2Id = created.identityId!;
    const admin2 = await owner.adminIdentity.findUniqueOrThrow({ where: { id: admin2Id } });
    expect(admin2).toMatchObject({ username: "admin2", role: "super_admin", sessionVersion: 0 });
    expect(admin2.passwordHash).not.toBe(adminBefore.passwordHash);
    expect(await owner.adminTwoFactor.count({ where: { identityId: admin2Id } })).toBe(0);
    expect(await owner.adminRecoveryCode.count({ where: { identityId: admin2Id } })).toBe(0);
    expect(await owner.adminSession.count({ where: { identityId: admin2Id } })).toBe(0);

    await expect(authenticateAdminLogin({ username: "admin2", password: "wrong-password", ip: "192.0.2.20", identities, sessions, attempts }))
      .rejects.toMatchObject({ code: "jwt_invalid", status: 401 });
    expect(await owner.adminLoginAttempt.count({ where: { identifierHash: hashLoginAttemptIdentifier("user", "admin2") } })).toBe(1);
    expect(await owner.adminLoginAttempt.count({ where: { identifierHash: hashLoginAttemptIdentifier("user", "admin") } })).toBe(0);
    expect(await owner.adminLoginAttempt.count({ where: { identifierHash: hashLoginAttemptIdentifier("ip", "192.0.2.20") } })).toBe(1);
    const login = await authenticateAdminLogin({ username: "admin2", password: PASSWORD, ip: "192.0.2.20", identities, sessions, attempts });
    expect(admin2.status).toBe("active");
    expect(login.context.identity.twoFactorEnabled).toBe(false);
    const pending = await startTwoFactorSetup({ identityId: admin2Id, identities, twoFactor, encryptionKey: KEY });
    expect(await owner.adminTwoFactor.findUniqueOrThrow({ where: { identityId: adminId } })).toEqual(adminBefore.twoFactor);
    const confirmed = await confirmTwoFactorSetup({
      identityId: admin2Id, code: generateTotpCode(pending.manualKey), identities,
      twoFactor, transactions, encryptionKey: KEY,
    });
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(confirmed.nextSessionVersion).toBe(1);
    expect(await owner.adminRecoveryCode.count({ where: { identityId: admin2Id, usedAt: null } })).toBe(10);
    expect((await owner.adminTwoFactor.findUniqueOrThrow({ where: { identityId: admin2Id } })).enabled).toBe(true);

    const secondLogin = await authenticateAdminLogin({ username: "admin2", password: PASSWORD, ip: "192.0.2.20", identities, sessions, attempts });
    const challenge = await createTwoFactorChallenge({ context: secondLogin.context, twoFactor });
    await expect(completeTwoFactorChallenge({
      context: adminLogin.context, token: challenge.token, code: generateTotpCode(pending.manualKey),
      twoFactor, recoveryCodes, transactions, encryptionKey: KEY,
    })).rejects.toMatchObject({ code: "two_factor_failed", status: 403 });
    const completed = await completeTwoFactorChallenge({
      context: secondLogin.context, token: challenge.token, code: generateTotpCode(pending.manualKey),
      twoFactor, recoveryCodes, transactions, encryptionKey: KEY,
    });
    expect(completed.identityId).toBe(admin2Id);
    expect(completed.method).toBe("totp");
    expect((await requireAdminSession(secondLogin.token, { identities, sessions })).twoFactorCompleted).toBe(true);

    const adminAfter = await owner.adminIdentity.findUniqueOrThrow({ where: { id: adminId }, include: { twoFactor: true } });
    expect(adminAfter.sessionVersion).toBe(adminBefore.sessionVersion);
    expect(adminAfter.twoFactor).toMatchObject({
      enabled: adminBefore.twoFactor!.enabled, confirmedAt: adminBefore.twoFactor!.confirmedAt,
      keyVersion: adminBefore.twoFactor!.keyVersion,
      recoveryCodesRotatedAt: adminBefore.twoFactor!.recoveryCodesRotatedAt,
    });
    expect(createHash("sha256").update(adminAfter.twoFactor!.encryptedSecret!).digest("hex")).toBe(adminSecretDigest);
    expect(await owner.adminRecoveryCode.count({ where: { identityId: adminId, usedAt: null } })).toBe(adminRecoveryBefore);
    expect(await owner.adminSession.findUniqueOrThrow({ where: { id: adminLogin.context.session.id } })).toEqual(adminSessionBefore);
    expect((await requireAdminSession(adminLogin.token, { identities, sessions })).identity.id).toBe(adminId);

    expect(await runAddAdminCli(web, addOptions(), addEnv())).toMatchObject({ outcome: "replayed", wrote: false });
    expect(await owner.adminIdentity.count()).toBe(2);
    expect(await owner.operationAudit.count({ where: { action: "admin_identity.add" } })).toBe(1);
    await expect(runAddAdminCli(web, addOptions({ requestId: "different-request" }), addEnv()))
      .rejects.toMatchObject({ code: "username_exists" });
    const audit = await owner.operationAudit.findFirstOrThrow({ where: { action: "admin_identity.add" } });
    expect(audit).toMatchObject({ actorType: "system", actorId: "owner", entityId: admin2Id, requestId: REQUEST_ID, reason: REASON });
    expect(JSON.stringify(audit, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("scrypt$");
    const adminAudit = await owner.operationAudit.findFirstOrThrow({ where: { action: "admin_identity.bootstrap" } });
    expect(adminAudit.entityId).toBe(adminId);
    expect(audit.entityId).not.toBe(adminAudit.entityId);

    const resetOptions: ResetAdminAuthStateCliOptions = {
      username: "admin2", operatorId: "owner", reason: "test rollback", requestId: "add-admin-test-disable",
      ip: null, deactivate: true, apply: true, breakGlass: false,
    };
    const reset = await runResetAdminAuthStateCli(owner, resetOptions, { NODE_ENV: "test" });
    expect(reset.outcome).toBe("reset");
    expect((await owner.adminIdentity.findUniqueOrThrow({ where: { id: admin2Id } })).status).toBe("disabled");
    expect(await owner.adminTwoFactor.findUniqueOrThrow({ where: { identityId: admin2Id } }))
      .toMatchObject({ enabled: false, encryptedSecret: null, confirmedAt: null, pendingEncryptedSecret: null });
    expect(await owner.adminRecoveryCode.count({ where: { identityId: admin2Id } })).toBe(0);
    expect(await owner.adminSession.count({ where: { identityId: admin2Id, revokedAt: null } })).toBe(0);
    await expect(authenticateAdminLogin({ username: "admin2", password: PASSWORD, ip: "192.0.2.20", identities, sessions, attempts }))
      .rejects.toMatchObject({ code: "jwt_invalid", status: 401 });
    expect((await owner.adminIdentity.findUniqueOrThrow({ where: { id: adminId } })).status).toBe("active");
  });

  it("serializes two overlapping web_app transactions for one username", async () => {
    const username = "race-admin2";
    let releaseStart!: () => void;
    let releaseReads!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseStart = resolve; });
    const bothReadTarget = new Promise<void>((resolve) => { releaseReads = resolve; });
    let entered = 0;
    let active = 0;
    let maxActive = 0;
    let lockAttempts = 0;
    let unlockedTargetReads = 0;
    type AddDb = Parameters<typeof runAddAdminCli>[0];

    const withBarrier = (client: PrismaClient): AddDb => ({
      adminIdentity: client.adminIdentity,
      operationAudit: client.operationAudit,
      $transaction: async <T>(callback: (tx: AddDb) => Promise<T>) => client.$transaction(async (tx) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        entered += 1;
        if (entered === 2) releaseStart();
        try {
          await bothStarted;
          let lockSeen = false;
          const identity = {
            findUnique: async (args: { where: { username?: string; id?: string }; select?: unknown }) => {
              const found = await tx.adminIdentity.findUnique(args as never);
              // If the advisory lock is deleted, hold both absent-name reads
              // until they have happened. Both inserts then race in PostgreSQL.
              if (args.where.username === username && !lockSeen) {
                unlockedTargetReads += 1;
                if (unlockedTargetReads === 2) releaseReads();
                await bothReadTarget;
              }
              return found;
            },
            create: (args: Parameters<typeof tx.adminIdentity.create>[0]) => tx.adminIdentity.create(args),
          };
          const wrappedTx = {
            adminIdentity: identity,
            operationAudit: tx.operationAudit,
            $queryRaw: async (sql: Prisma.Sql) => {
              const ordinal = ++lockAttempts;
              lockSeen = true;
              const result = await tx.$queryRaw(sql);
              // Hold the first lock while the second transaction attempts it.
              if (ordinal === 1) await new Promise((resolve) => setTimeout(resolve, 100));
              return result;
            },
          } as unknown as AddDb;
          return await callback(wrappedTx);
        } finally {
          active -= 1;
        }
      }),
    } as unknown as AddDb);

    const results = await Promise.allSettled([
      runAddAdminCli(withBarrier(web), addOptions({ username, requestId: "race-first" }), addEnv()),
      runAddAdminCli(withBarrier(concurrentWeb), addOptions({ username, requestId: "race-second" }), addEnv()),
    ]);
    const created = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof runAddAdminCli>>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(maxActive).toBe(2);
    expect(created).toHaveLength(1);
    expect(created[0].value.outcome).toBe("created");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "username_exists" });
    expect(lockAttempts).toBe(2);
    expect(await owner.adminIdentity.count({ where: { username } })).toBe(1);
  }, 20_000);
});
