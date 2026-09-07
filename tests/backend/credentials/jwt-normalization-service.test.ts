/**
 * D-6 (Phase E rework, 2026-09-07), service-level regression: a
 * `Bearer <jwt>`-prefixed submission to `addOrReplaceCredential` must
 * persist the exact same `secret_fingerprint` that a plain, bare-token
 * submission would — otherwise the stored fingerprint no longer matches the
 * token the operator meant to store, and a second identical intake
 * (deliberately re-pasted bare) would look like a *different* credential.
 * This is the service-level counterpart to `jwt-normalization.test.ts`'s
 * pure-function coverage of `normalizeCredentialJwtInput`.
 *
 * Root-cause context: the real incident this work order fixes was an
 * operator pasting a full `Authorization: Bearer <jwt>` (or `Bearer <jwt>`)
 * header into the intake form. Before D-6, `addOrReplaceCredential` passed
 * `input.secret` — prefix and all — straight to `validateCredentialJwtLocally`
 * (which only checks three-segment shape + `exp`, so it silently passed),
 * `fingerprintNewCredentialSecret`, and `encryptNewCredentialSecret`. The
 * worker's adapter re-added its own `Bearer ` prefix on top at call time,
 * doubling it, and every upstream call failed with HTTP 401.
 *
 * Uses a minimal hand-rolled Prisma double for exactly the raw-SQL and
 * model call shapes `addOrReplaceCredential` issues — same convention as
 * `tests/backend/credentials/db-retry-wiring.test.ts`'s `FakeCredentialsDb`
 * and `tests/backend/publish-gate/fake-db.ts`. `Prisma.sql` tagged
 * templates expose their bound values positionally via `.values`, which is
 * what lets this fake capture the exact `secret_fingerprint` /
 * `fingerprint_prefix` parameters passed to the `INSERT INTO
 * channel_account_credential` statement without a real Postgres connection.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";
import { addOrReplaceCredential } from "@/server/credentials/service";
import { fingerprintNewCredentialSecret } from "@/lib/credentials/web-ingress-crypto";
import { requireAdminActionAccess, type AdminServiceAuthorization } from "@/server/auth/guards";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";

const NOW = new Date("2026-08-18T00:00:00.000Z");
const ORIGIN = "https://admin.cps-novel.test";

function keyFiles(): { env: NodeJS.ProcessEnv; cleanup(): void } {
  const directory = mkdtempSync(path.join(tmpdir(), "cps-novel-credential-keys-"));
  const v1 = path.join(directory, "v1");
  const fingerprint = path.join(directory, "fingerprint");
  writeFileSync(v1, randomBytes(32).toString("base64"), { mode: 0o600 });
  writeFileSync(fingerprint, randomBytes(32).toString("base64"), { mode: 0o600 });
  return {
    env: {
      NODE_ENV: "test",
      CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
      CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: v1,
      CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: fingerprint,
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function seedAdmin(stores: TestOnlyInMemoryAuthStores): { token: string } {
  const identityId = "admin-1";
  const token = `token-${identityId}`;
  const identity: AdminIdentity = {
    id: identityId,
    username: identityId,
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const issuedAt = new Date(NOW.getTime() - 60_000);
  const session: AdminSessionRecord = {
    id: `session-${identityId}`,
    tokenHash: hashAdminSessionToken(token),
    identityId,
    sessionVersion: 1,
    issuedAt,
    lastSeenAt: NOW,
    absoluteExpiresAt: new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: NOW,
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return { token };
}

async function issueAuthorization(
  stores: TestOnlyInMemoryAuthStores,
  actionId: string,
  token: string,
): Promise<{ authorization: AdminServiceAuthorization; requestId: string }> {
  const requestId = crypto.randomUUID();
  const { serviceAuthorization } = await requireAdminActionAccess(
    { actionId, sessionToken: token, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId },
    { identities: stores, sessions: stores, registry: P1_08B_ADMIN_REGISTRY, now: NOW },
  );
  if (!serviceAuthorization) throw new Error(`expected a serviceAuthorization for ${actionId}`);
  return { authorization: serviceAuthorization, requestId };
}

function makeJwt(expEpochSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test-subject", exp: expEpochSeconds })).toString("base64url");
  const signature = Buffer.from("deterministic-test-signature-bytes").toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Reads the raw-SQL text a `Prisma.sql` tagged-template call produced, so
 * this fake can dispatch on statement shape without a real query engine.
 */
function sqlText(query: Prisma.Sql): string {
  return query.strings.join("?");
}

/**
 * Minimal Prisma double for exactly the calls `addOrReplaceCredential`
 * issues on its happy path: no prior committed replacement, an active
 * channel account, no pre-existing active credential for the type. Not a
 * general query engine — each branch pattern-matches the one real call site
 * that produces it.
 */
class FakeAddOrReplaceCredentialDb {
  /** Captured positional `.values` of the `INSERT INTO channel_account_credential` statement. */
  insertedCredentialValues: unknown[] | null = null;
  readonly calls: string[] = [];

  private buildClient(): PrismaClient {
    const operationAudit = {
      findFirst: async () => {
        this.calls.push("operationAudit.findFirst");
        return null; // no prior committed replacement for this requestId
      },
      create: async (args: { data: Record<string, unknown> }) => {
        this.calls.push("operationAudit.create");
        return { id: "audit-1", ...args.data };
      },
    };
    const channelAccount = {
      update: async (args: { where: { id: string } }) => {
        this.calls.push("channelAccount.update");
        return { id: args.where.id };
      },
    };
    const credentialChangeLog = {
      create: async (args: { data: Record<string, unknown> }) => {
        this.calls.push("credentialChangeLog.create");
        return { id: "changelog-1", ...args.data };
      },
    };

    const queryRaw = async (query: Prisma.Sql) => {
      const text = sqlText(query);
      this.calls.push(`$queryRaw:${text.slice(0, 40).trim()}`);
      if (text.includes("SELECT status") && text.includes("FROM channel_account")) {
        return [{ status: "active" }];
      }
      if (text.includes("SELECT id, fingerprint_prefix")) {
        return []; // no pre-existing active credential — this is a first-time add
      }
      throw new Error(`FakeAddOrReplaceCredentialDb: unexpected $queryRaw shape: ${text}`);
    };

    const executeRaw = async (query: Prisma.Sql) => {
      const text = sqlText(query);
      this.calls.push(`$executeRaw:${text.slice(0, 40).trim()}`);
      if (text.includes("INSERT INTO channel_account_credential")) {
        this.insertedCredentialValues = [...query.values];
        return 1;
      }
      // INSERT INTO channel_credential_active_fingerprint / UPDATE .../ DELETE ...:
      // not inspected by this test, just acknowledged as a 1-row write.
      return 1;
    };

    const client = {
      operationAudit,
      channelAccount,
      credentialChangeLog,
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      $transaction: async (
        callback: (tx: unknown) => Promise<unknown>,
      ) => callback(client),
    } as unknown as PrismaClient;
    return client;
  }

  readonly client = this.buildClient();
  asPrismaClient(): PrismaClient {
    return this.client;
  }
}

describe("addOrReplaceCredential: Bearer-prefixed intake normalization (D-6)", () => {
  it("stores the fingerprint of the bare token, identical to a bare-token submission", async () => {
    const keys = keyFiles();
    try {
      const bareJwt = makeJwt(Math.floor(NOW.getTime() / 1000) + 3600);
      const expectedFingerprint = fingerprintNewCredentialSecret(bareJwt, keys.env);

      const stores = new TestOnlyInMemoryAuthStores();
      const admin = seedAdmin(stores);
      const { authorization, requestId } = await issueAuthorization(stores, "admin.credential.replace", admin.token);
      const fake = new FakeAddOrReplaceCredentialDb();

      const metadata = await addOrReplaceCredential(
        {
          authorization,
          requestId,
          channelAccountId: "channel-account-1",
          secret: `Bearer ${bareJwt}`,
          reason: "D-6 regression test: Bearer-prefixed intake",
        },
        { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW, env: keys.env },
      );

      // The service's own returned metadata carries only the prefix; confirm
      // it already matches the bare-token fingerprint's prefix ...
      expect(metadata.fingerprintPrefix).toBe(expectedFingerprint.prefix);

      // ... and, more strongly, confirm what was actually about to be
      // persisted: the raw SQL parameters bound to the INSERT statement's
      // `secret_fingerprint` (index 5) and `fingerprint_prefix` (index 6)
      // columns, per the column list at
      // `src/server/credentials/service.ts`'s `addOrReplaceCredential`
      // (`secret_fingerprint, fingerprint_prefix` follow `key_version`).
      expect(fake.insertedCredentialValues).not.toBeNull();
      const insertedValues = fake.insertedCredentialValues as unknown[];
      expect(insertedValues[5]).toBe(expectedFingerprint.full);
      expect(insertedValues[6]).toBe(expectedFingerprint.prefix);
    } finally {
      keys.cleanup();
    }
  });

  it("bare-token and Authorization-header submissions produce the same fingerprint as each other", async () => {
    const keys = keyFiles();
    try {
      const bareJwt = makeJwt(Math.floor(NOW.getTime() / 1000) + 3600);
      const expectedFingerprint = fingerprintNewCredentialSecret(bareJwt, keys.env);

      const submissions = [bareJwt, `Bearer ${bareJwt}`, `Authorization: Bearer ${bareJwt}`, `bearer ${bareJwt}`];
      for (const [index, secret] of submissions.entries()) {
        const stores = new TestOnlyInMemoryAuthStores();
        const admin = seedAdmin(stores);
        const { authorization, requestId } = await issueAuthorization(stores, "admin.credential.replace", admin.token);
        const fake = new FakeAddOrReplaceCredentialDb();

        const metadata = await addOrReplaceCredential(
          {
            authorization,
            requestId,
            channelAccountId: `channel-account-${index}`,
            secret,
            reason: "D-6 regression test: cross-shape parity",
          },
          { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW, env: keys.env },
        );

        expect(metadata.fingerprintPrefix).toBe(expectedFingerprint.prefix);
      }
    } finally {
      keys.cleanup();
    }
  });
});
