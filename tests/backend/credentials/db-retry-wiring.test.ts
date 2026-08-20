/**
 * P0-S2 (db-retry wiring): proves `withDbRetry` is actually reached by
 * `createChannelAccount`'s `$transaction` call site in
 * `src/server/credentials/service.ts`, not merely imported (this file
 * already imported `isSerializationFailure`/`isUniqueConstraintViolation`
 * from `@/lib/db/db-retry` before this PR, but never `withDbRetry` itself).
 *
 * Two things must both be true:
 *  1. A transient Postgres failure (P1008) thrown by the first
 *     `$transaction` attempt is retried, and the second attempt's result is
 *     what the caller ultimately sees, without double-writing.
 *  2. A unique-constraint violation (P2002) — this file's own business
 *     signal for "already exists" — is rethrown on the very first attempt,
 *     never retried, and this file's existing catch-recovery path
 *     (`isUniqueConflict`) still runs exactly as before.
 *
 * Uses a minimal hand-rolled Prisma double, following the same shape as
 * `tests/backend/publish-gate/fake-db.ts` — only the call shapes
 * `createChannelAccount` actually issues.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";
import { createChannelAccount } from "@/server/credentials/service";
import { requireAdminActionAccess, type AdminServiceAuthorization } from "@/server/auth/guards";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";

const NOW = new Date("2026-08-18T00:00:00.000Z");
const ORIGIN = "https://admin.cps-novel.test";

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

type Account = { id: string; channelId: string; businessId: string; accountName: string; status: string };
type Audit = { actorType: string; actorId: string; action: string; entityType: string; entityId: string; requestId: string };

/** Minimal Prisma double for exactly the calls `createChannelAccount` issues. */
class FakeCredentialsDb {
  readonly accounts = new Map<string, Account>();
  readonly audits: Audit[] = [];
  nextId = 1;
  /** Set to a factory to make `channelAccount.create` throw instead of writing. */
  failCreateWith: (() => unknown) | null = null;

  private buildClient(): PrismaClient {
    const client = {
      operationAudit: {
        findFirst: async (args: { where: Partial<Audit> }) => {
          const found = this.audits.find((a) =>
            Object.entries(args.where).every(([k, v]) => (a as Record<string, unknown>)[k] === v),
          );
          return found ? { ...found } : null;
        },
        create: async (args: { data: Audit }) => {
          this.audits.push({ ...args.data });
          return { ...args.data };
        },
      },
      channelAccount: {
        create: async (args: { data: Omit<Account, "id"> }) => {
          if (this.failCreateWith) throw this.failCreateWith();
          const id = `account-${this.nextId++}`;
          const account = { id, ...args.data };
          this.accounts.set(id, account);
          return account;
        },
        findUnique: async (args: { where: { id: string } }) => this.accounts.get(args.where.id) ?? null,
      },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(client),
    } as unknown as PrismaClient;
    return client;
  }

  readonly client = this.buildClient();
  asPrismaClient(): PrismaClient {
    return this.client;
  }
}

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: "6.19.2" });
}

/** Injects `failures` transient rejections into `db.$transaction` before delegating to the real one. */
function withInjectedTransientFailures(db: PrismaClient, failures: number) {
  const client = db as unknown as { $transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
  const real = client.$transaction.bind(client);
  const attempts = { count: 0 };
  client.$transaction = (callback: (tx: unknown) => Promise<unknown>) => {
    attempts.count += 1;
    if (attempts.count <= failures) return Promise.reject(prismaError("P1008"));
    return real(callback);
  };
  return attempts;
}

describe("db-retry wiring: createChannelAccount", () => {
  it("retries a transient P1008 failure and succeeds on the second attempt", async () => {
    const stores = new TestOnlyInMemoryAuthStores();
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.channel_account.create", admin.token);
    const fake = new FakeCredentialsDb();
    const attempts = withInjectedTransientFailures(fake.asPrismaClient(), 1);

    const account = await createChannelAccount(
      { authorization, requestId, channelId: "ch-1", businessId: "biz-1", accountName: "Name" },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    );

    expect(attempts.count).toBe(2);
    expect(account).toMatchObject({ channelId: "ch-1", businessId: "biz-1", status: "active" });
    // Exactly one committed account and one audit row — the retry replayed
    // the whole aborted transaction from scratch, it did not double-write.
    expect(fake.accounts.size).toBe(1);
    expect(fake.audits).toHaveLength(1);
  }, 10_000);

  it("does not retry a unique-constraint violation (P2002) — rethrown on the first attempt", async () => {
    const stores = new TestOnlyInMemoryAuthStores();
    const admin = seedAdmin(stores);
    const { authorization, requestId } = await issueAuthorization(stores, "admin.channel_account.create", admin.token);
    const fake = new FakeCredentialsDb();
    fake.failCreateWith = () => prismaError("P2002");
    const attempts = withInjectedTransientFailures(fake.asPrismaClient(), 0); // wrap without injecting — just count

    // No committed row exists for this requestId, so the catch block's
    // recovery lookup also fails and the original P2002 propagates.
    await expect(
      createChannelAccount(
        { authorization, requestId, channelId: "ch-1", businessId: "biz-1", accountName: "Name" },
        { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
      ),
    ).rejects.toThrow();

    expect(attempts.count).toBe(1);
    expect(fake.accounts.size).toBe(0);
  });
});
