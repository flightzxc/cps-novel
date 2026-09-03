import { describe, expect, it } from "vitest";

import { hashLoginAttemptIdentifier } from "../../../src/lib/auth/login-attempts";
import {
  parseResetAdminAuthStateCliOptions,
  requireBreakGlassIfNeeded,
  RESET_ADMIN_AUTH_AUDIT_ACTION,
  ResetAdminAuthStateError,
  runResetAdminAuthStateCli,
  type ResetAdminAuthStateCliOptions,
} from "../../../scripts/reset-admin-auth-state";

const ENV = Object.freeze({
  NODE_ENV: "test",
  RESET_ADMIN_OPERATOR: "release-operator",
}) as unknown as NodeJS.ProcessEnv;

const BASE_OPTIONS: ResetAdminAuthStateCliOptions = Object.freeze({
  username: "x8-owner",
  operatorId: "release-operator",
  reason: "owner lost the authenticator and recovery codes for the reused X8 volume identity",
  requestId: "x8-2026-09-04-owner-reset",
  ip: null,
  deactivate: false,
  apply: false,
  breakGlass: false,
});

type IdentityRow = { id: string; username: string; status: string; sessionVersion: number };
type SessionRow = { id: string; identityId: string; revokedAt: Date | null };
type TwoFactorRow = {
  identityId: string;
  enabled: boolean;
  encryptedSecret: string | null;
  keyVersion: number | null;
  confirmedAt: Date | null;
  pendingEncryptedSecret: string | null;
  pendingKeyVersion: number | null;
  pendingExpiresAt: Date | null;
  recoveryCodesRotatedAt: Date | null;
};
type ChallengeRow = { id: string; identityId: string };
type RecoveryCodeRow = { id: string; identityId: string };
type LoginAttemptRow = { identifierHash: string };
type AuditRow = {
  id: bigint;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string | null;
  reason: string | null;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
};

/** Transactional Prisma-shaped fake, same discipline as
 * bootstrap-admin-identity.test.ts's FakeBootstrapAdminDb: a callback queue
 * models the fixed advisory lock, and snapshots model PostgreSQL rollback if
 * a write after the lock throws. */
class FakeResetDb {
  readonly identities = new Map<string, IdentityRow>();
  readonly sessions = new Map<string, SessionRow>();
  readonly twoFactor = new Map<string, TwoFactorRow>();
  readonly challenges = new Map<string, ChallengeRow>();
  readonly recoveryCodes = new Map<string, RecoveryCodeRow>();
  readonly loginAttempts = new Map<string, LoginAttemptRow>();
  readonly audits: AuditRow[] = [];
  private transactionTail: Promise<void> = Promise.resolve();

  seedIdentity(row: IdentityRow) {
    this.identities.set(row.id, row);
  }

  private client() {
    return {
      adminIdentity: {
        findUnique: async (args: { where: { username: string } }) => {
          // Prisma always materializes a fresh plain object per query, never
          // a live reference into whatever this fake stores -- return a copy
          // so a later mutation (e.g. the sessionVersion increment below)
          // cannot retroactively change a value the caller already read.
          for (const row of this.identities.values()) if (row.username === args.where.username) return { ...row };
          return null;
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = this.identities.get(args.where.id);
          if (!row) throw new Error("identity not found");
          if (typeof args.data.status === "string") row.status = args.data.status;
          const increment = args.data.sessionVersion as { increment?: number } | undefined;
          if (increment?.increment) row.sessionVersion += increment.increment;
          return { sessionVersion: row.sessionVersion, status: row.status };
        },
      },
      adminSession: {
        count: async (args: { where: { identityId: string; revokedAt: null } }) =>
          [...this.sessions.values()].filter((s) => s.identityId === args.where.identityId && s.revokedAt === null).length,
        updateMany: async (args: { where: { identityId: string; revokedAt: null }; data: { revokedAt: Date } }) => {
          let count = 0;
          for (const row of this.sessions.values()) {
            if (row.identityId === args.where.identityId && row.revokedAt === null) {
              row.revokedAt = args.data.revokedAt;
              count += 1;
            }
          }
          return { count };
        },
      },
      adminTwoFactor: {
        findUnique: async (args: { where: { identityId: string } }) => this.twoFactor.get(args.where.identityId) ?? null,
        updateMany: async (args: { where: { identityId: string }; data: Record<string, unknown> }) => {
          const row = this.twoFactor.get(args.where.identityId);
          if (!row) return { count: 0 };
          Object.assign(row, args.data);
          return { count: 1 };
        },
      },
      adminTwoFactorChallenge: {
        count: async (args: { where: { identityId: string } }) =>
          [...this.challenges.values()].filter((c) => c.identityId === args.where.identityId).length,
        deleteMany: async (args: { where: { identityId: string } }) => {
          let count = 0;
          for (const [id, row] of [...this.challenges]) {
            if (row.identityId === args.where.identityId) { this.challenges.delete(id); count += 1; }
          }
          return { count };
        },
      },
      adminRecoveryCode: {
        count: async (args: { where: { identityId: string } }) =>
          [...this.recoveryCodes.values()].filter((c) => c.identityId === args.where.identityId).length,
        deleteMany: async (args: { where: { identityId: string } }) => {
          let count = 0;
          for (const [id, row] of [...this.recoveryCodes]) {
            if (row.identityId === args.where.identityId) { this.recoveryCodes.delete(id); count += 1; }
          }
          return { count };
        },
      },
      adminLoginAttempt: {
        count: async (args: { where: { identifierHash: { in: string[] } } }) =>
          args.where.identifierHash.in.filter((hash) => this.loginAttempts.has(hash)).length,
        deleteMany: async (args: { where: { identifierHash: { in: string[] } } }) => {
          let count = 0;
          for (const hash of args.where.identifierHash.in) {
            if (this.loginAttempts.delete(hash)) count += 1;
          }
          return { count };
        },
      },
      operationAudit: {
        findFirst: async (args: { where: { actorType: string; action: string; requestId: string } }) =>
          this.audits.find((a) => a.actorType === args.where.actorType && a.action === args.where.action && a.requestId === args.where.requestId) ?? null,
        create: async (args: { data: Omit<AuditRow, "id"> }) => {
          const row = { id: BigInt(this.audits.length + 1), ...args.data };
          this.audits.push(row);
          return row;
        },
      },
      $queryRaw: async () => [{ lock_result: null }],
    };
  }

  asClient(): Parameters<typeof runResetAdminAuthStateCli>[0] {
    const root = this.client();
    return {
      ...root,
      $transaction: async <T>(callback: (tx: ReturnType<FakeResetDb["client"]>) => Promise<T>) => {
        let release!: () => void;
        const prior = this.transactionTail;
        this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
        await prior;
        try {
          return await callback(this.client());
        } finally {
          release();
        }
      },
    } as unknown as Parameters<typeof runResetAdminAuthStateCli>[0];
  }
}

function seedFullBinding(db: FakeResetDb, identityId: string) {
  db.sessions.set("s1", { id: "s1", identityId, revokedAt: null });
  db.sessions.set("s2", { id: "s2", identityId, revokedAt: null });
  db.twoFactor.set(identityId, {
    identityId, enabled: true, encryptedSecret: "v1:iv:tag:ct", keyVersion: 1,
    confirmedAt: new Date(), pendingEncryptedSecret: null, pendingKeyVersion: null,
    pendingExpiresAt: null, recoveryCodesRotatedAt: new Date(),
  });
  db.challenges.set("c1", { id: "c1", identityId });
  db.recoveryCodes.set("r1", { id: "r1", identityId });
  db.recoveryCodes.set("r2", { id: "r2", identityId });
}

describe("reset-admin-auth-state CLI parsing", () => {
  const argv = ["--username", " X8-Owner ", "--reason", " authorized reset ", "--request-id", " req-1 "];

  it("is dry-run by default and normalizes the username", () => {
    const parsed = parseResetAdminAuthStateCliOptions(argv, ENV);
    expect(parsed).toMatchObject({ username: "x8-owner", reason: "authorized reset", requestId: "req-1", apply: false, deactivate: false, breakGlass: false });
  });

  it("requires operator, reason, username, and request id", () => {
    expect(() => parseResetAdminAuthStateCliOptions(argv, {} as NodeJS.ProcessEnv)).toThrow(ResetAdminAuthStateError);
    expect(() => parseResetAdminAuthStateCliOptions(argv.filter((v) => v !== "--reason" && v !== " authorized reset "), ENV)).toThrow(/--reason/);
    expect(() => parseResetAdminAuthStateCliOptions(argv.filter((v) => v !== "--username" && v !== " X8-Owner "), ENV)).toThrow(/--username/);
  });

  it("picks up --deactivate, --apply, --break-glass, and --ip", () => {
    const parsed = parseResetAdminAuthStateCliOptions([...argv, "--deactivate", "--apply", "--break-glass", "--ip", "203.0.113.9"], ENV);
    expect(parsed).toMatchObject({ deactivate: true, apply: true, breakGlass: true, ip: "203.0.113.9" });
  });
});

describe("requireBreakGlassIfNeeded — production gate", () => {
  it("does nothing for a dry-run, regardless of environment", () => {
    expect(() => requireBreakGlassIfNeeded(
      { NODE_ENV: "production", ADMIN_TWO_FACTOR_ENFORCEMENT: "true" } as unknown as NodeJS.ProcessEnv,
      { apply: false, breakGlass: false },
    )).not.toThrow();
  });

  it("does nothing outside NODE_ENV=production", () => {
    expect(() => requireBreakGlassIfNeeded(
      { NODE_ENV: "development", ADMIN_TWO_FACTOR_ENFORCEMENT: "true" } as unknown as NodeJS.ProcessEnv,
      { apply: true, breakGlass: false },
    )).not.toThrow();
  });

  it("does nothing when 2FA enforcement is disabled (X8_LEVEL=uat), even in production", () => {
    expect(() => requireBreakGlassIfNeeded(
      { NODE_ENV: "production", ADMIN_TWO_FACTOR_ENFORCEMENT: "false" } as unknown as NodeJS.ProcessEnv,
      { apply: true, breakGlass: false },
    )).not.toThrow();
  });

  it("refuses production + enforcement required + apply without --break-glass", () => {
    expect(() => requireBreakGlassIfNeeded(
      { NODE_ENV: "production", ADMIN_TWO_FACTOR_ENFORCEMENT: "true" } as unknown as NodeJS.ProcessEnv,
      { apply: true, breakGlass: false },
    )).toThrow(ResetAdminAuthStateError);
  });

  it("allows it once --break-glass is passed", () => {
    expect(() => requireBreakGlassIfNeeded(
      { NODE_ENV: "production", ADMIN_TWO_FACTOR_ENFORCEMENT: "true" } as unknown as NodeJS.ProcessEnv,
      { apply: true, breakGlass: true },
    )).not.toThrow();
  });
});

describe("reset-admin-auth-state dry-run", () => {
  it("previews the exact counts that --apply would change, without writing", async () => {
    const db = new FakeResetDb();
    db.seedIdentity({ id: "id-1", username: "x8-owner", status: "active", sessionVersion: 3 });
    seedFullBinding(db, "id-1");
    db.loginAttempts.set(hashLoginAttemptIdentifier("user", "x8-owner"), { identifierHash: hashLoginAttemptIdentifier("user", "x8-owner") });

    const report = await runResetAdminAuthStateCli(db.asClient(), BASE_OPTIONS, ENV);

    expect(report.mode).toBe("dry-run");
    expect(report.outcome).toBe("eligible");
    expect(report.wrote).toBe(false);
    expect(report.counts).toMatchObject({
      sessionsRevoked: 2,
      twoFactorChallengesDeleted: 1,
      recoveryCodesDeleted: 2,
      twoFactorReset: true,
      loginAttemptRowsCleared: 1,
    });
    expect(db.sessions.get("s1")!.revokedAt).toBeNull();
    expect(db.challenges.size).toBe(1);
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an unknown username instead of silently reporting zero counts", async () => {
    const db = new FakeResetDb();
    await expect(runResetAdminAuthStateCli(db.asClient(), BASE_OPTIONS, ENV))
      .rejects.toMatchObject({ code: "identity_not_found" });
  });
});

describe("reset-admin-auth-state apply", () => {
  it("clears every 2FA binding, all sessions, the challenge, recovery codes, and the login-attempt lockout in one transaction, with an audit row that carries no secret material", async () => {
    const db = new FakeResetDb();
    db.seedIdentity({ id: "id-1", username: "x8-owner", status: "active", sessionVersion: 3 });
    seedFullBinding(db, "id-1");
    db.loginAttempts.set(hashLoginAttemptIdentifier("user", "x8-owner"), { identifierHash: hashLoginAttemptIdentifier("user", "x8-owner") });

    const report = await runResetAdminAuthStateCli(db.asClient(), { ...BASE_OPTIONS, apply: true }, ENV);

    expect(report).toMatchObject({ mode: "apply", outcome: "reset", wrote: true, sessionVersionBefore: 3, sessionVersionAfter: 4 });
    expect(report.counts).toEqual({
      sessionsRevoked: 2, twoFactorChallengesDeleted: 1, recoveryCodesDeleted: 2, twoFactorReset: true, loginAttemptRowsCleared: 1,
    });

    expect(db.sessions.get("s1")!.revokedAt).not.toBeNull();
    expect(db.sessions.get("s2")!.revokedAt).not.toBeNull();
    expect(db.challenges.size).toBe(0);
    expect(db.recoveryCodes.size).toBe(0);
    expect(db.loginAttempts.size).toBe(0);
    const tf = db.twoFactor.get("id-1")!;
    expect(tf).toMatchObject({ enabled: false, encryptedSecret: null, keyVersion: null, confirmedAt: null, pendingEncryptedSecret: null, recoveryCodesRotatedAt: null });
    expect(db.identities.get("id-1")!.sessionVersion).toBe(4);
    expect(db.identities.get("id-1")!.status).toBe("active");

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorType: "system", actorId: "release-operator", action: RESET_ADMIN_AUTH_AUDIT_ACTION,
      entityType: "AdminIdentity", entityId: "id-1", reason: BASE_OPTIONS.reason,
    });
    const serialized = JSON.stringify(db.audits[0], (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    // Field *names* like "recoveryCodesDeleted" are fine (they are counts);
    // only actual secret-shaped values are forbidden: a scrypt password
    // hash, an otpauth:// URI, a "v1:iv:tag:ct" encrypted TOTP secret
    // payload, or a plaintext XXXX-XXXX-XXXX recovery code.
    expect(serialized).not.toMatch(/scrypt\$|otpauth:\/\/|v1:[^"]+:[^"]+:[^"]+|\b[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}\b/);
  });

  it("sets status to disabled only when --deactivate is passed", async () => {
    const db = new FakeResetDb();
    db.seedIdentity({ id: "id-1", username: "x8-owner", status: "active", sessionVersion: 0 });

    const report = await runResetAdminAuthStateCli(db.asClient(), { ...BASE_OPTIONS, apply: true, deactivate: true }, ENV);

    expect(report.deactivated).toBe(true);
    expect(db.identities.get("id-1")!.status).toBe("disabled");
  });

  it("is a safe no-op counts-wise on an identity that was never enrolled", async () => {
    const db = new FakeResetDb();
    db.seedIdentity({ id: "id-1", username: "x8-owner", status: "active", sessionVersion: 0 });

    const report = await runResetAdminAuthStateCli(db.asClient(), { ...BASE_OPTIONS, apply: true }, ENV);

    expect(report.counts).toEqual({ sessionsRevoked: 0, twoFactorChallengesDeleted: 0, recoveryCodesDeleted: 0, twoFactorReset: false, loginAttemptRowsCleared: 0 });
    expect(report.sessionVersionAfter).toBe(1);
  });

  it("replays the first outcome for a repeated request id instead of writing again", async () => {
    const db = new FakeResetDb();
    db.seedIdentity({ id: "id-1", username: "x8-owner", status: "active", sessionVersion: 0 });
    seedFullBinding(db, "id-1");
    const options = { ...BASE_OPTIONS, apply: true };

    const first = await runResetAdminAuthStateCli(db.asClient(), options, ENV);
    // Re-seed a fresh session as if the operator logged in again between runs.
    db.sessions.set("s3", { id: "s3", identityId: "id-1", revokedAt: null });
    const second = await runResetAdminAuthStateCli(db.asClient(), options, ENV);

    expect(first).toMatchObject({ outcome: "reset", wrote: true });
    expect(second).toEqual({ ...first, outcome: "replayed", wrote: false });
    expect(db.audits).toHaveLength(1);
    // The replay must not have touched the session created after the first run.
    expect(db.sessions.get("s3")!.revokedAt).toBeNull();
  });

  it("clears both the username- and ip-scoped login-attempt buckets when --ip is given, and only the username one otherwise", async () => {
    const userHash = hashLoginAttemptIdentifier("user", "x8-owner");
    const ipHash = hashLoginAttemptIdentifier("ip", "203.0.113.9");

    const withoutIp = new FakeResetDb();
    withoutIp.seedIdentity({ id: "id-1", username: "x8-owner", status: "active", sessionVersion: 0 });
    withoutIp.loginAttempts.set(userHash, { identifierHash: userHash });
    withoutIp.loginAttempts.set(ipHash, { identifierHash: ipHash });
    const reportWithoutIp = await runResetAdminAuthStateCli(withoutIp.asClient(), { ...BASE_OPTIONS, apply: true }, ENV);
    expect(reportWithoutIp.counts.loginAttemptRowsCleared).toBe(1);
    expect(withoutIp.loginAttempts.has(userHash)).toBe(false);
    expect(withoutIp.loginAttempts.has(ipHash)).toBe(true);

    const withIp = new FakeResetDb();
    withIp.seedIdentity({ id: "id-1", username: "x8-owner", status: "active", sessionVersion: 0 });
    withIp.loginAttempts.set(userHash, { identifierHash: userHash });
    withIp.loginAttempts.set(ipHash, { identifierHash: ipHash });
    const reportWithIp = await runResetAdminAuthStateCli(
      withIp.asClient(),
      { ...BASE_OPTIONS, apply: true, ip: "203.0.113.9" },
      ENV,
    );
    expect(reportWithIp.counts.loginAttemptRowsCleared).toBe(2);
    expect(withIp.loginAttempts.size).toBe(0);
  });
});
