import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashAdminPassword, verifyAdminPassword } from "@/lib/auth/password";
import {
  ADD_ADMIN_AUDIT_ACTION, AddAdminError, parseAddAdminCliOptions, runAddAdminCli,
  type AddAdminCliOptions,
} from "../../../scripts/add-admin-identity";

const PASSWORD = "correct horse battery staple";
const REASON = "Owner approved secondary preproduction admin account with independent 2FA and equivalent admin permissions";
const REQUEST_ID = "preprod-2026-09-25-add-admin2";
let secretDir: string;
let passwordFile: string;
const env = (): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ADD_ADMIN_OPERATOR: "owner", ADD_ADMIN_PASSWORD_FILE: passwordFile });
const options = (overrides: Partial<AddAdminCliOptions> = {}): AddAdminCliOptions => ({
  username: "admin2", referenceUsername: "admin", operatorId: "owner",
  reason: REASON, requestId: REQUEST_ID, apply: false, ...overrides,
});

type Identity = { id: string; username: string; passwordHash: string; role: string; status: string; sessionVersion: number };
type Audit = {
  id: bigint; actorType: string; actorId: string; action: string; entityType: string;
  entityId: string; requestId: string; reason: string; beforeSnapshot: unknown; afterSnapshot: unknown;
};

class FakeDb {
  identities = new Map<string, Identity>();
  audits: Audit[] = [];
  calls: string[] = [];
  failNextAudit = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(reference: Partial<Identity> = {}) {
    this.identities.set("admin", {
      id: "admin-id", username: "admin", passwordHash: hashAdminPassword(PASSWORD),
      role: "super_admin", status: "active", sessionVersion: 3, ...reference,
    });
  }

  private client() {
    return {
      adminIdentity: {
        findUnique: async (args: { where: { username?: string; id?: string } }) => {
          this.calls.push("adminIdentity.findUnique");
          const row = [...this.identities.values()].find((value) =>
            args.where.username !== undefined ? value.username === args.where.username : value.id === args.where.id);
          return row ? { ...row } : null;
        },
        create: async (args: { data: Identity }) => {
          this.calls.push("adminIdentity.create");
          const row = { ...args.data };
          this.identities.set(row.username, row);
          return { ...row };
        },
      },
      operationAudit: {
        findFirst: async (args: { where: { actorType: string; action: string; requestId: string } }) => {
          this.calls.push("operationAudit.findFirst");
          return this.audits.find((row) => row.actorType === args.where.actorType
            && row.action === args.where.action && row.requestId === args.where.requestId) ?? null;
        },
        create: async (args: { data: Omit<Audit, "id"> }) => {
          this.calls.push("operationAudit.create");
          if (this.failNextAudit) { this.failNextAudit = false; throw new Error("injected audit failure"); }
          const row = { id: BigInt(this.audits.length + 1), ...args.data };
          this.audits.push(row);
          return { id: row.id };
        },
      },
      $queryRaw: async () => { this.calls.push("pg_advisory_xact_lock"); return [{ lock_result: "" }]; },
      get adminTwoFactor(): never { throw new Error("2FA must not be accessed"); },
      get adminRecoveryCode(): never { throw new Error("recovery codes must not be accessed"); },
      get adminSession(): never { throw new Error("sessions must not be accessed"); },
    };
  }

  asClient(): Parameters<typeof runAddAdminCli>[0] {
    const root = this.client();
    return {
      adminIdentity: root.adminIdentity,
      operationAudit: root.operationAudit,
      get adminTwoFactor(): never { throw new Error("2FA must not be accessed"); },
      get adminRecoveryCode(): never { throw new Error("recovery codes must not be accessed"); },
      get adminSession(): never { throw new Error("sessions must not be accessed"); },
      $transaction: async <T>(callback: (tx: ReturnType<FakeDb["client"]>) => Promise<T>) => {
        this.calls.push("$transaction");
        let release!: () => void;
        const previous = this.tail;
        this.tail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        const identities = new Map([...this.identities].map(([key, value]) => [key, { ...value }]));
        const audits = this.audits.map((row) => ({ ...row }));
        try { return await callback(this.client()); }
        catch (error) {
          this.identities = identities;
          this.audits = audits;
          throw error;
        } finally { release(); }
      },
    } as unknown as Parameters<typeof runAddAdminCli>[0];
  }
}

beforeAll(async () => {
  secretDir = await mkdtemp(path.join(os.tmpdir(), "add-admin-test-"));
  passwordFile = path.join(secretDir, "password");
  await writeFile(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
});
afterAll(async () => { await rm(secretDir, { recursive: true, force: true }); });

describe("add admin CLI arguments and password file", () => {
  const argv = ["--username", " ADMIN2 ", "--same-password-as", " ADMIN ", "--reason", REASON, "--request-id", REQUEST_ID];
  it("requires each argument and normalizes usernames", () => {
    const parsed = parseAddAdminCliOptions(argv, { NODE_ENV: "test", ADD_ADMIN_OPERATOR: " owner " });
    expect(parsed).toEqual(options());
    for (const flag of ["--username", "--same-password-as", "--reason", "--request-id"]) {
      const index = argv.indexOf(flag);
      const missing = argv.filter((_, i) => i !== index && i !== index + 1);
      expect(() => parseAddAdminCliOptions(missing, env())).toThrow(AddAdminError);
    }
  });
  it("rejects password argv, missing operator and self-reference", () => {
    expect(() => parseAddAdminCliOptions([...argv, "--password", PASSWORD], env()))
      .toThrowError(expect.objectContaining({ code: "password_forbidden_in_argv" }));
    expect(() => parseAddAdminCliOptions(argv, { NODE_ENV: "test" })).toThrowError(expect.objectContaining({ code: "invalid_operator" }));
    expect(() => parseAddAdminCliOptions(["--username", "ADMIN", "--same-password-as", "admin", "--reason", REASON, "--request-id", REQUEST_ID], env()))
      .toThrowError(expect.objectContaining({ code: "self_reference" }));
  });
  it("rejects --password=value without echoing the supplied value", () => {
    const secret = "distinct-password-that-must-not-appear";
    let error: unknown;
    try { parseAddAdminCliOptions([...argv, `--password=${secret}`], env()); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "password_forbidden_in_argv" });
    expect(String(error)).not.toContain(secret);
  });
  it("rejects missing, relative, multiline, empty and short password files", async () => {
    const db = new FakeDb();
    for (const file of ["relative", path.join(secretDir, "missing")]) {
      await expect(runAddAdminCli(db.asClient(), options(), { NODE_ENV: "test", ADD_ADMIN_PASSWORD_FILE: file }))
        .rejects.toMatchObject({ code: "invalid_password" });
    }
    for (const value of ["", "too-short", `${PASSWORD}\nsecond line`]) {
      const file = path.join(secretDir, `bad-${value.length}`);
      await writeFile(file, value);
      await expect(runAddAdminCli(db.asClient(), options(), { NODE_ENV: "test", ADD_ADMIN_PASSWORD_FILE: file }))
        .rejects.toMatchObject({ code: "invalid_password" });
    }
  });
});

describe("add admin CLI behavior", () => {
  it("rejects missing or disabled reference accounts", async () => {
    for (const reference of [{ status: "disabled" }, { username: "other" }]) {
      const db = new FakeDb(reference);
      await expect(runAddAdminCli(db.asClient(), options(), env()))
        .rejects.toMatchObject({ code: "reference_identity_not_found" });
    }
  });
  it("rejects a mismatched password in dry-run and apply without writes", async () => {
    const db = new FakeDb({ passwordHash: hashAdminPassword("another correct password") });
    for (const apply of [false, true]) {
      await expect(runAddAdminCli(db.asClient(), options({ apply }), env()))
        .rejects.toMatchObject({ code: "reference_password_mismatch" });
    }
    expect(db.identities.size).toBe(1);
    expect(db.audits).toHaveLength(0);
  });
  it("dry-runs every eligibility check without a write", async () => {
    const db = new FakeDb();
    const report = await runAddAdminCli(db.asClient(), options(), env());
    expect(report).toMatchObject({ mode: "dry-run", outcome: "eligible", wrote: false, identityId: null });
    expect(db.calls).not.toContain("adminIdentity.create");
    expect(db.calls).not.toContain("operationAudit.create");
  });
  it("creates with an independent hash and redacted audit, without touching 2FA or sessions", async () => {
    const db = new FakeDb();
    const report = await runAddAdminCli(db.asClient(), options({ apply: true }), env());
    const created = db.identities.get("admin2")!;
    expect(report).toMatchObject({ outcome: "created", wrote: true, identityId: created.id });
    expect(created).toMatchObject({ role: "super_admin", status: "active", sessionVersion: 0 });
    expect(verifyAdminPassword(PASSWORD, created.passwordHash)).toBe(true);
    expect(created.passwordHash).not.toBe(db.identities.get("admin")!.passwordHash);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorType: "system", actorId: "owner", action: ADD_ADMIN_AUDIT_ACTION,
      entityType: "AdminIdentity", entityId: created.id, requestId: REQUEST_ID, reason: REASON,
      beforeSnapshot: { username: "admin2", existed: false },
      afterSnapshot: { username: "admin2", role: "super_admin", status: "active", sessionVersion: 0, samePasswordAs: "admin", twoFactor: "not_enrolled" },
    });
    const visible = JSON.stringify({ report, audit: db.audits[0] }, (_, value) => typeof value === "bigint" ? value.toString() : value);
    expect(visible).not.toContain(PASSWORD);
    expect(visible).not.toContain("scrypt$");
  });
  it("never accesses 2FA, recovery-code or session tables while adding an identity", async () => {
    const db = new FakeDb();
    await expect(runAddAdminCli(db.asClient(), options({ apply: true }), env()))
      .resolves.toMatchObject({ outcome: "created", wrote: true });
    expect(db.calls).toEqual(expect.not.arrayContaining([
      "adminTwoFactor", "adminRecoveryCode", "adminSession",
    ]));
  });
  it("rolls back the identity if the audit insert fails", async () => {
    const db = new FakeDb(); db.failNextAudit = true;
    await expect(runAddAdminCli(db.asClient(), options({ apply: true }), env())).rejects.toThrow("injected audit failure");
    expect(db.identities.size).toBe(1);
    expect(db.audits).toHaveLength(0);
  });
  it("replays the same request after the new account completes 2FA", async () => {
    const db = new FakeDb();
    await runAddAdminCli(db.asClient(), options({ apply: true }), env());
    db.identities.get("admin2")!.sessionVersion = 1;
    const report = await runAddAdminCli(db.asClient(), options({ apply: true }), env());
    expect(report).toMatchObject({ outcome: "replayed", wrote: false });
    expect(db.identities.size).toBe(2);
    expect(db.audits).toHaveLength(1);
  });
  it("refuses replay of the same request id with a different password file", async () => {
    const db = new FakeDb();
    await runAddAdminCli(db.asClient(), options({ apply: true }), env());
    const changedFile = path.join(secretDir, "changed-password");
    await writeFile(changedFile, "a different password for replay\n", { mode: 0o600 });
    for (const apply of [false, true]) {
      await expect(runAddAdminCli(db.asClient(), options({ apply }), {
        ...env(), ADD_ADMIN_PASSWORD_FILE: changedFile,
      })).rejects.toMatchObject({ code: "request_id_conflict" });
    }
    expect(db.identities.size).toBe(2);
    expect(db.audits).toHaveLength(1);
  });
  it("rejects changed request bindings", async () => {
    const db = new FakeDb();
    await runAddAdminCli(db.asClient(), options({ apply: true }), env());
    for (const changed of [{ operatorId: "someone" }, { reason: "different" }, { username: "admin3" }, { referenceUsername: "other" }]) {
      await expect(runAddAdminCli(db.asClient(), options({ apply: true, ...changed }), env()))
        .rejects.toMatchObject({ code: "request_id_conflict" });
    }
  });
  it("rejects a duplicate username on another request", async () => {
    const db = new FakeDb();
    await runAddAdminCli(db.asClient(), options({ apply: true }), env());
    await expect(runAddAdminCli(db.asClient(), options({ apply: true, requestId: "another" }), env()))
      .rejects.toMatchObject({ code: "username_exists" });
    expect(db.identities.size).toBe(2);
  });
  it("rejects a second create after the fake transaction queue commits", async () => {
    const db = new FakeDb();
    const results = await Promise.allSettled([
      runAddAdminCli(db.asClient(), options({ apply: true, requestId: "first" }), env()),
      runAddAdminCli(db.asClient(), options({ apply: true, requestId: "second" }), env()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "username_exists" });
    expect(db.identities.size).toBe(2);
  });
});
