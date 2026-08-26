import { describe, expect, it } from "vitest";

import { verifyAdminPassword } from "@/lib/auth/password";
import {
  BOOTSTRAP_ADMIN_AUDIT_ACTION,
  BootstrapAdminError,
  parseBootstrapAdminCliOptions,
  runBootstrapAdminCli,
  type BootstrapAdminCliOptions,
} from "../../../scripts/bootstrap-admin-identity";

const PASSWORD = "correct horse battery staple";
const ENV = Object.freeze({
  NODE_ENV: "test",
  BOOTSTRAP_ADMIN_OPERATOR: "release-operator",
  BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
}) as unknown as NodeJS.ProcessEnv;

const BASE_OPTIONS: BootstrapAdminCliOptions = Object.freeze({
  username: "owner@example.com",
  operatorId: "release-operator",
  reason: "initial production administrator",
  requestId: "deploy-2026-08-26-admin-bootstrap",
  apply: false,
});

type IdentityRow = {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  status: string;
  sessionVersion: number;
};

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

/**
 * Transactional Prisma-shaped fake. Its callback queue models the fixed
 * advisory lock: concurrent callbacks cannot pass the lock at the same time.
 * Snapshots model PostgreSQL rollback when identity succeeds but audit fails.
 */
class FakeBootstrapAdminDb {
  readonly identities = new Map<string, IdentityRow>();
  readonly audits: AuditRow[] = [];
  readonly calls: string[] = [];
  failNextAuditCreate = false;
  private transactionTail: Promise<void> = Promise.resolve();

  private client() {
    return {
      adminIdentity: {
        count: async () => {
          this.calls.push("adminIdentity.count");
          return this.identities.size;
        },
        findUnique: async (args: { where: { id: string } }) => {
          this.calls.push("adminIdentity.findUnique");
          return this.identities.get(args.where.id) ?? null;
        },
        create: async (args: { data: IdentityRow }) => {
          this.calls.push("adminIdentity.create");
          const row = { ...args.data };
          this.identities.set(row.id, row);
          return row;
        },
      },
      operationAudit: {
        findFirst: async (args: { where: { actorType: string; action: string; requestId: string } }) => {
          this.calls.push("operationAudit.findFirst");
          return this.audits.find((audit) =>
            audit.actorType === args.where.actorType
            && audit.action === args.where.action
            && audit.requestId === args.where.requestId) ?? null;
        },
        create: async (args: { data: Omit<AuditRow, "id"> }) => {
          this.calls.push("operationAudit.create");
          if (this.failNextAuditCreate) {
            this.failNextAuditCreate = false;
            throw new Error("injected audit failure");
          }
          const row = { id: BigInt(this.audits.length + 1), ...args.data };
          this.audits.push(row);
          return row;
        },
      },
      $queryRaw: async () => {
        this.calls.push("pg_advisory_xact_lock");
        return [{ pg_advisory_xact_lock: null }];
      },
    };
  }

  asClient(): Parameters<typeof runBootstrapAdminCli>[0] {
    const root = this.client();
    return {
      ...root,
      $transaction: async <T>(callback: (tx: ReturnType<FakeBootstrapAdminDb["client"]>) => Promise<T>) => {
        this.calls.push("$transaction");
        let release!: () => void;
        const prior = this.transactionTail;
        this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
        await prior;

        const identitiesBefore = new Map([...this.identities].map(([id, row]) => [id, { ...row }]));
        const auditsBefore = this.audits.map((row) => ({ ...row }));
        try {
          return await callback(this.client());
        } catch (error) {
          this.identities.clear();
          for (const [id, row] of identitiesBefore) this.identities.set(id, row);
          this.audits.splice(0, this.audits.length, ...auditsBefore);
          throw error;
        } finally {
          release();
        }
      },
    } as unknown as Parameters<typeof runBootstrapAdminCli>[0];
  }
}

describe("bootstrap admin CLI parsing", () => {
  const argv = [
    "--username", " Owner@Example.COM ",
    "--reason", " authorized bootstrap ",
    "--request-id", " deploy-1 ",
  ];

  it("is dry-run by default, normalizes username, and never carries the password in options", () => {
    const parsed = parseBootstrapAdminCliOptions(argv, {
      NODE_ENV: "test",
      BOOTSTRAP_ADMIN_OPERATOR: " operator-1 ",
    } as unknown as NodeJS.ProcessEnv);
    expect(parsed).toEqual({
      username: "owner@example.com",
      operatorId: "operator-1",
      reason: "authorized bootstrap",
      requestId: "deploy-1",
      apply: false,
    });
    expect(JSON.stringify(parsed)).not.toContain("password");
  });

  it("requires operator, reason, username, and a stable request id", () => {
    expect(() => parseBootstrapAdminCliOptions(argv, {} as NodeJS.ProcessEnv)).toThrow(BootstrapAdminError);
    expect(() => parseBootstrapAdminCliOptions(argv.filter((value) => value !== "--reason" && value !== " authorized bootstrap "), ENV)).toThrow(/--reason/);
    expect(() => parseBootstrapAdminCliOptions(argv.filter((value) => value !== "--request-id" && value !== " deploy-1 "), ENV)).toThrow(/--request-id/);
    expect(() => parseBootstrapAdminCliOptions(argv.filter((value) => value !== "--username" && value !== " Owner@Example.COM "), ENV)).toThrow(/--username/);
  });

  it("requires a 12+ character env password for --apply and rejects argv passwords", () => {
    expect(() => parseBootstrapAdminCliOptions([...argv, "--apply"], {
      NODE_ENV: "test",
      BOOTSTRAP_ADMIN_OPERATOR: "operator-1",
    } as unknown as NodeJS.ProcessEnv)).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
    expect(() => parseBootstrapAdminCliOptions([...argv, "--apply"], {
      NODE_ENV: "test",
      BOOTSTRAP_ADMIN_OPERATOR: "operator-1",
      BOOTSTRAP_ADMIN_PASSWORD: "too-short",
    } as unknown as NodeJS.ProcessEnv)).toThrow(/at least 12/);
    expect(() => parseBootstrapAdminCliOptions([...argv, "--password", PASSWORD, "--apply"], ENV)).toThrow(/forbidden in argv/);
  });
});

describe("bootstrap admin dry-run", () => {
  it("reports eligibility and performs no transaction or write", async () => {
    const db = new FakeBootstrapAdminDb();
    const report = await runBootstrapAdminCli(db.asClient(), BASE_OPTIONS, {} as NodeJS.ProcessEnv);

    expect(report).toEqual({
      mode: "dry-run",
      outcome: "eligible",
      username: "owner@example.com",
      role: "super_admin",
      requestId: BASE_OPTIONS.requestId,
      identityId: null,
      auditId: null,
      wrote: false,
    });
    expect(db.calls).not.toContain("$transaction");
    expect(db.calls).not.toContain("adminIdentity.create");
    expect(db.calls).not.toContain("operationAudit.create");
    expect(db.identities.size).toBe(0);
    expect(db.audits).toHaveLength(0);
  });

  it("refuses whenever an unrelated identity already exists", async () => {
    const db = new FakeBootstrapAdminDb();
    db.identities.set("existing-id", {
      id: "existing-id",
      username: "someone@example.com",
      passwordHash: "scrypt$v1$fixture",
      role: "editor",
      status: "active",
      sessionVersion: 0,
    });
    await expect(runBootstrapAdminCli(db.asClient(), BASE_OPTIONS, {} as NodeJS.ProcessEnv))
      .rejects.toMatchObject({ code: "identity_table_not_empty" });
  });
});

describe("bootstrap admin apply transaction", () => {
  it("creates only one active super_admin and writes a redacted audit in the same transaction", async () => {
    const db = new FakeBootstrapAdminDb();
    const report = await runBootstrapAdminCli(db.asClient(), { ...BASE_OPTIONS, apply: true }, ENV);

    expect(report).toMatchObject({ mode: "apply", outcome: "created", role: "super_admin", wrote: true });
    expect(db.calls).toContain("pg_advisory_xact_lock");
    expect(db.identities.size).toBe(1);
    const identity = [...db.identities.values()][0];
    expect(identity).toMatchObject({
      username: BASE_OPTIONS.username,
      role: "super_admin",
      status: "active",
      sessionVersion: 0,
    });
    expect(identity.passwordHash).toMatch(/^scrypt\$v1\$/);
    expect(verifyAdminPassword(PASSWORD, identity.passwordHash)).toBe(true);

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorType: "system",
      actorId: BASE_OPTIONS.operatorId,
      action: BOOTSTRAP_ADMIN_AUDIT_ACTION,
      entityType: "AdminIdentity",
      entityId: identity.id,
      requestId: BASE_OPTIONS.requestId,
      reason: BASE_OPTIONS.reason,
      beforeSnapshot: { identityCount: 0 },
      afterSnapshot: {
        username: BASE_OPTIONS.username,
        role: "super_admin",
        status: "active",
        sessionVersion: 0,
      },
    });
    const observableOutput = JSON.stringify(
      { report, audit: db.audits[0] },
      (_key, value) => typeof value === "bigint" ? value.toString() : value,
    );
    expect(observableOutput).not.toContain(PASSWORD);
    expect(observableOutput).not.toContain("passwordHash");
    expect(observableOutput).not.toContain("scrypt$");
  });

  it("rolls back the identity if the audit insert fails", async () => {
    const db = new FakeBootstrapAdminDb();
    db.failNextAuditCreate = true;

    await expect(runBootstrapAdminCli(db.asClient(), { ...BASE_OPTIONS, apply: true }, ENV))
      .rejects.toThrow("injected audit failure");
    expect(db.identities.size).toBe(0);
    expect(db.audits).toHaveLength(0);

    const retry = await runBootstrapAdminCli(db.asClient(), { ...BASE_OPTIONS, apply: true }, ENV);
    expect(retry).toMatchObject({ outcome: "created", wrote: true });
  });

  it("returns a safe no-write replay for the same committed request id", async () => {
    const db = new FakeBootstrapAdminDb();
    const options = { ...BASE_OPTIONS, apply: true };
    const first = await runBootstrapAdminCli(db.asClient(), options, ENV);
    const second = await runBootstrapAdminCli(db.asClient(), options, ENV);

    expect(first).toMatchObject({ outcome: "created", wrote: true });
    expect(second).toEqual({ ...first, outcome: "replayed", wrote: false });
    expect(db.identities.size).toBe(1);
    expect(db.audits).toHaveLength(1);
  });

  it("refuses replay if any additional identity exists", async () => {
    const db = new FakeBootstrapAdminDb();
    const options = { ...BASE_OPTIONS, apply: true };
    await runBootstrapAdminCli(db.asClient(), options, ENV);
    db.identities.set("other-id", {
      id: "other-id",
      username: "other@example.com",
      passwordHash: "scrypt$v1$fixture",
      role: "editor",
      status: "active",
      sessionVersion: 0,
    });

    await expect(runBootstrapAdminCli(db.asClient(), options, ENV))
      .rejects.toMatchObject({ code: "identity_table_not_empty" });
    expect(db.identities.size).toBe(2);
    expect(db.audits).toHaveLength(1);
  });

  it("binds replay to username, operator, reason, and password", async () => {
    const db = new FakeBootstrapAdminDb();
    const options = { ...BASE_OPTIONS, apply: true };
    await runBootstrapAdminCli(db.asClient(), options, ENV);

    for (const changed of [
      { ...options, username: "different@example.com" },
      { ...options, operatorId: "different-operator" },
      { ...options, reason: "different reason" },
    ]) {
      await expect(runBootstrapAdminCli(db.asClient(), changed, ENV))
        .rejects.toMatchObject({ code: "request_id_conflict" });
    }
    await expect(runBootstrapAdminCli(db.asClient(), options, {
      ...ENV,
      BOOTSTRAP_ADMIN_PASSWORD: "different password value",
    })).rejects.toMatchObject({ code: "request_id_conflict" });
    expect(db.identities.size).toBe(1);
    expect(db.audits).toHaveLength(1);
  });

  it("serializes concurrent same-request applies into one create plus one replay", async () => {
    const db = new FakeBootstrapAdminDb();
    const options = { ...BASE_OPTIONS, apply: true };
    const reports = await Promise.all([
      runBootstrapAdminCli(db.asClient(), options, ENV),
      runBootstrapAdminCli(db.asClient(), options, ENV),
    ]);

    expect(reports.map((report) => report.outcome).sort()).toEqual(["created", "replayed"]);
    expect(db.identities.size).toBe(1);
    expect(db.audits).toHaveLength(1);
    expect(db.calls.filter((call) => call === "pg_advisory_xact_lock")).toHaveLength(2);
  });

  it("allows only one of two concurrent distinct-request first-user attempts", async () => {
    const db = new FakeBootstrapAdminDb();
    const results = await Promise.allSettled([
      runBootstrapAdminCli(db.asClient(), { ...BASE_OPTIONS, requestId: "request-left", apply: true }, ENV),
      runBootstrapAdminCli(db.asClient(), { ...BASE_OPTIONS, requestId: "request-right", apply: true }, ENV),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "identity_table_not_empty" } });
    expect(db.identities.size).toBe(1);
    expect(db.audits).toHaveLength(1);
  });
});
