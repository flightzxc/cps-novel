import { describe, expect, it } from "vitest";

import { verifyAdminPassword } from "../../../src/lib/auth/password";
import {
  ENSURE_LOCAL_ADMIN_IDENTITY_AUDIT_ACTION,
  ENSURE_LOCAL_ADMIN_IDENTITY_ROLE,
  EnsureLocalAdminIdentityError,
  parseEnsureLocalAdminIdentitiesCliOptions,
  requireLocalAdminPasswords,
  requireLocalIdentitySeedAllowed,
  runEnsureLocalAdminIdentitiesCli,
  type EnsureLocalAdminIdentitiesCliOptions,
} from "../../../scripts/ensure-local-admin-identities";

const ALLOW_ENV = Object.freeze({
  NODE_ENV: "test",
  ADMIN_LOCAL_IDENTITY_SEED: "allow",
  X8_ADMIN_PASSWORD: "short",
  X8_ADMIN2_PASSWORD: "also-short",
}) as unknown as NodeJS.ProcessEnv;

const OPTIONS: EnsureLocalAdminIdentitiesCliOptions = Object.freeze({
  operatorId: "x8-local-identity-seed",
  resetPassword: false,
});

type IdentityRow = { id: string; username: string; passwordHash: string; role: string; status: string; sessionVersion: number };
type AuditRow = { id: bigint; actorType: string; actorId: string | null; action: string; entityType: string; entityId: string; reason: string | null; beforeSnapshot: unknown; afterSnapshot: unknown };

class FakeSeedDb {
  readonly identities = new Map<string, IdentityRow>();
  readonly audits: AuditRow[] = [];
  private transactionTail: Promise<void> = Promise.resolve();

  private client() {
    return {
      adminIdentity: {
        findUnique: async (args: { where: { username: string } }) => {
          // Copy, not a live reference -- same Prisma-fidelity reasoning as
          // reset-admin-auth-state.test.ts's fake.
          for (const row of this.identities.values()) if (row.username === args.where.username) return { ...row };
          return null;
        },
        create: async (args: { data: IdentityRow }) => {
          const row = { ...args.data };
          this.identities.set(row.id, row);
          return row;
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = this.identities.get(args.where.id);
          if (!row) throw new Error("not found");
          if (typeof args.data.passwordHash === "string") row.passwordHash = args.data.passwordHash;
          const increment = args.data.sessionVersion as { increment?: number } | undefined;
          if (increment?.increment) row.sessionVersion += increment.increment;
          return { id: row.id, sessionVersion: row.sessionVersion };
        },
      },
      operationAudit: {
        create: async (args: { data: Omit<AuditRow, "id"> }) => {
          const row = { id: BigInt(this.audits.length + 1), ...args.data };
          this.audits.push(row);
          return row;
        },
      },
      $queryRaw: async () => [{ lock_result: null }],
    };
  }

  asClient(): Parameters<typeof runEnsureLocalAdminIdentitiesCli>[0] {
    const root = this.client();
    return {
      ...root,
      $transaction: async <T>(callback: (tx: ReturnType<FakeSeedDb["client"]>) => Promise<T>) => {
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
    } as unknown as Parameters<typeof runEnsureLocalAdminIdentitiesCli>[0];
  }
}

describe("ensure-local-admin-identities — fail-closed seed gate", () => {
  it("refuses when ADMIN_LOCAL_IDENTITY_SEED is unset, mistyped, or any value other than the exact 'allow'", () => {
    for (const value of [undefined, "", "true", "Allow", " allow ", "ALLOW", "1"]) {
      const env = value === undefined
        ? ({} as NodeJS.ProcessEnv)
        : ({ ADMIN_LOCAL_IDENTITY_SEED: value } as unknown as NodeJS.ProcessEnv);
      if (value === " allow ") {
        // Leading/trailing whitespace is trimmed, same as
        // two-factor-enforcement.ts's own env parsing -- this one value in
        // the loop is expected to pass, not throw.
        expect(() => requireLocalIdentitySeedAllowed(env)).not.toThrow();
        continue;
      }
      expect(() => requireLocalIdentitySeedAllowed(env)).toThrow(EnsureLocalAdminIdentityError);
    }
  });

  it("accepts the exact value 'allow'", () => {
    expect(() => requireLocalIdentitySeedAllowed({ ADMIN_LOCAL_IDENTITY_SEED: "allow" } as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("end to end: runEnsureLocalAdminIdentitiesCli refuses before touching the database when the gate is closed", async () => {
    const db = new FakeSeedDb();
    await expect(
      runEnsureLocalAdminIdentitiesCli(db.asClient(), OPTIONS, { ADMIN_LOCAL_IDENTITY_SEED: "false" } as unknown as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({ code: "seed_not_allowed" });
    expect(db.identities.size).toBe(0);
  });
});

describe("ensure-local-admin-identities — password env fail-fast", () => {
  it("requires both X8_ADMIN_PASSWORD and X8_ADMIN2_PASSWORD once the gate is open", () => {
    expect(() => requireLocalAdminPasswords({ ADMIN_LOCAL_IDENTITY_SEED: "allow" } as unknown as NodeJS.ProcessEnv))
      .toThrow(/X8_ADMIN_PASSWORD/);
    expect(() => requireLocalAdminPasswords({
      ADMIN_LOCAL_IDENTITY_SEED: "allow", X8_ADMIN_PASSWORD: "x",
    } as unknown as NodeJS.ProcessEnv)).toThrow(/X8_ADMIN2_PASSWORD/);
    expect(() => requireLocalAdminPasswords(ALLOW_ENV)).not.toThrow();
  });

  it("points at the admin-secret set subcommand in the error message", () => {
    try {
      requireLocalAdminPasswords({ ADMIN_LOCAL_IDENTITY_SEED: "allow" } as unknown as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("admin-secret set admin");
    }
  });
});

describe("ensure-local-admin-identities CLI parsing", () => {
  it("forbids a literal --password in argv", () => {
    expect(() => parseEnsureLocalAdminIdentitiesCliOptions(["--password", "x"], ALLOW_ENV)).toThrow(/forbidden in argv/);
  });

  it("reads --reset-password and defaults the operator id", () => {
    expect(parseEnsureLocalAdminIdentitiesCliOptions([], ALLOW_ENV)).toMatchObject({ resetPassword: false, operatorId: "x8-local-identity-seed" });
    expect(parseEnsureLocalAdminIdentitiesCliOptions(["--reset-password"], ALLOW_ENV)).toMatchObject({ resetPassword: true });
  });
});

describe("ensure-local-admin-identities apply", () => {
  it("creates admin and admin2 as super_admin with the short local-only passwords accepted, and audits both", async () => {
    const db = new FakeSeedDb();
    const report = await runEnsureLocalAdminIdentitiesCli(db.asClient(), OPTIONS, ALLOW_ENV);

    expect(report.users.map((u) => u.username)).toEqual(["admin", "admin2"]);
    expect(report.users.every((u) => u.outcome === "created" && u.wrote)).toBe(true);
    expect(db.identities.size).toBe(2);
    for (const [username, password] of [["admin", "short"], ["admin2", "also-short"]] as const) {
      const identity = [...db.identities.values()].find((row) => row.username === username)!;
      expect(identity).toMatchObject({ username, role: ENSURE_LOCAL_ADMIN_IDENTITY_ROLE, status: "active", sessionVersion: 0 });
      expect(verifyAdminPassword(password, identity.passwordHash)).toBe(true);
    }
    expect(db.audits).toHaveLength(2);
    expect(db.audits.every((a) => a.action === ENSURE_LOCAL_ADMIN_IDENTITY_AUDIT_ACTION)).toBe(true);
  });

  it("is idempotent: a second run with existing identities and no --reset-password skips both, writes nothing", async () => {
    const db = new FakeSeedDb();
    await runEnsureLocalAdminIdentitiesCli(db.asClient(), OPTIONS, ALLOW_ENV);
    const auditsAfterFirst = db.audits.length;

    const second = await runEnsureLocalAdminIdentitiesCli(db.asClient(), OPTIONS, ALLOW_ENV);

    expect(second.users.every((u) => u.outcome === "skipped_existing" && !u.wrote)).toBe(true);
    expect(db.identities.size).toBe(2);
    expect(db.audits).toHaveLength(auditsAfterFirst);
  });

  it("--reset-password updates the hash and bumps sessionVersion for an existing identity, and audits it", async () => {
    const db = new FakeSeedDb();
    await runEnsureLocalAdminIdentitiesCli(db.asClient(), OPTIONS, ALLOW_ENV);
    const before = { ...[...db.identities.values()].find((row) => row.username === "admin")! };

    const report = await runEnsureLocalAdminIdentitiesCli(
      db.asClient(),
      { ...OPTIONS, resetPassword: true },
      { ...ALLOW_ENV, X8_ADMIN_PASSWORD: "brand-new-short" } as unknown as NodeJS.ProcessEnv,
    );

    const adminReport = report.users.find((u) => u.username === "admin")!;
    expect(adminReport).toMatchObject({ outcome: "password_reset", wrote: true });
    const after = db.identities.get(before.id)!;
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(verifyAdminPassword("brand-new-short", after.passwordHash)).toBe(true);
    expect(verifyAdminPassword("short", after.passwordHash)).toBe(false);
  });
});
