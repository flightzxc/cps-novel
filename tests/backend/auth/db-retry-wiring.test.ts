/**
 * P0-S2 (db-retry wiring): proves `withDbRetry` is actually reached by the
 * Postgres-backed admin-session/2FA write paths in `src/lib/auth/postgres.ts`
 * — the concrete adapters `src/lib/auth/session.ts`'s `requireAdminSession`
 * (via `sessions.touchLastSeen`) and `src/lib/auth/two-factor.ts` (via
 * `twoFactor.savePendingSetup`/`createChallenge` and
 * `transactions.confirmTwoFactorSetup`/`completeTwoFactorChallenge`) call
 * through the `SessionStore`/`TwoFactorStore`/`AuthUnitOfWork` ports.
 * `session.ts`/`two-factor.ts` themselves hold no Prisma calls — they are
 * exercised elsewhere (`session-capabilities.test.ts`, `two-factor.test.ts`)
 * against `TestOnlyInMemoryAuthStores`, a non-Postgres double — so this
 * suite targets `postgres.ts`'s classes directly with a minimal Prisma
 * double, the same way `db-retry-wiring.test.ts` in `tests/backend/tasks`
 * and `tests/backend/credentials` do for their respective files.
 *
 * `incrementChallengeAttempts` is deliberately NOT covered here: it is
 * deliberately NOT wrapped in `withDbRetry` in `postgres.ts` (see that
 * method's doc comment) because it is a plain, non-idempotent increment.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { PostgreSQLAuthUnitOfWork, PostgreSQLSessionStore, PostgreSQLTwoFactorStore } from "@/lib/auth/postgres";

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: "6.19.2" });
}

describe("db-retry wiring: PostgreSQLSessionStore.touchLastSeen", () => {
  it("retries a transient P1008 failure on the single UPDATE statement and succeeds", async () => {
    const executeRaw = vi.fn()
      .mockRejectedValueOnce(prismaError("P1008"))
      .mockResolvedValueOnce(1);
    const db = { $executeRaw: executeRaw } as unknown as PrismaClient;
    const store = new PostgreSQLSessionStore(db);

    const ok = await store.touchLastSeen({
      sessionId: "session-1", identityId: "admin-1", sessionVersion: 1, seenAt: new Date("2026-08-18T00:00:00Z"),
    });

    expect(ok).toBe(true);
    expect(executeRaw).toHaveBeenCalledTimes(2);
  }, 10_000);
});

describe("db-retry wiring: PostgreSQLTwoFactorStore", () => {
  it("savePendingSetup retries a transient P1008 failure on its upsert and succeeds", async () => {
    const upsert = vi.fn()
      .mockRejectedValueOnce(prismaError("P1008"))
      .mockResolvedValueOnce({ identityId: "admin-1" });
    const db = { adminTwoFactor: { upsert } } as unknown as PrismaClient;
    const store = new PostgreSQLTwoFactorStore(db);

    await store.savePendingSetup("admin-1", "encrypted-secret", new Date("2026-08-18T01:00:00Z"));

    expect(upsert).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("createChallenge retries a transient P1008 failure on its create and succeeds", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(prismaError("P1008"))
      .mockResolvedValueOnce({});
    const db = { adminTwoFactorChallenge: { create } } as unknown as PrismaClient;
    const store = new PostgreSQLTwoFactorStore(db);

    await store.createChallenge({
      id: "challenge-1", identityId: "admin-1", sessionId: "session-1", tokenHash: "hash",
      expiresAt: new Date("2026-08-18T00:05:00Z"), consumedAt: null, attemptCount: 0,
      createdAt: new Date("2026-08-18T00:00:00Z"),
    });

    expect(create).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("createChallenge does not retry a unique-constraint violation (P2002) — rethrown on the first attempt", async () => {
    const create = vi.fn().mockRejectedValueOnce(prismaError("P2002"));
    const db = { adminTwoFactorChallenge: { create } } as unknown as PrismaClient;
    const store = new PostgreSQLTwoFactorStore(db);

    await expect(
      store.createChallenge({
        id: "challenge-1", identityId: "admin-1", sessionId: "session-1", tokenHash: "hash",
        expiresAt: new Date("2026-08-18T00:05:00Z"), consumedAt: null, attemptCount: 0,
        createdAt: new Date("2026-08-18T00:00:00Z"),
      }),
    ).rejects.toThrow();

    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("db-retry wiring: PostgreSQLAuthUnitOfWork", () => {
  function fakeTransactionDb(tx: Record<string, unknown>, failures: number) {
    const attempts = { count: 0 };
    const db = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        attempts.count += 1;
        if (attempts.count <= failures) throw prismaError("P1008");
        return callback(tx);
      }),
    } as unknown as PrismaClient;
    return { db, attempts };
  }

  it("confirmTwoFactorSetup retries a transient P1008 failure and succeeds on the second attempt", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ session_version: 1 }]), // guard SELECT ... FOR UPDATE
      adminTwoFactor: { update: vi.fn().mockResolvedValue({}) },
      adminRecoveryCode: { deleteMany: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
      adminIdentity: { update: vi.fn().mockResolvedValue({ sessionVersion: 2 }) },
    };
    const { db, attempts } = fakeTransactionDb(tx, 1);
    const unitOfWork = new PostgreSQLAuthUnitOfWork(db);

    const result = await unitOfWork.confirmTwoFactorSetup({
      identityId: "admin-1", expectedSessionVersion: 1, expectedPendingEncryptedSecret: "pending-secret",
      confirmedAt: new Date("2026-08-18T00:00:00Z"), recoveryCodes: [{ id: "code-1", codeHash: "hash-1" }],
    });

    expect(attempts.count).toBe(2);
    expect(result).toEqual({ status: "committed", nextSessionVersion: 2 });
    // Exactly one real pass through the callback — the failed first attempt
    // never reached it, so no double-write of the recovery codes.
    expect((tx.adminRecoveryCode.createMany as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("confirmTwoFactorSetup does not retry a conflict (guard SELECT finds no matching row) — one attempt only", async () => {
    // Simulates the ambiguous-commit case documented on this method in
    // `postgres.ts`: the guard SELECT no longer matches (e.g. the pending
    // secret was already cleared by an earlier, ack-lost commit), so the
    // callback returns `{ status: "conflict" }` without throwing — that is
    // not a Prisma error at all, so there is nothing for `withDbRetry` to
    // retry regardless.
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]), // no row matches
      adminTwoFactor: { update: vi.fn() },
      adminRecoveryCode: { deleteMany: vi.fn(), createMany: vi.fn() },
      adminIdentity: { update: vi.fn() },
    };
    const { db, attempts } = fakeTransactionDb(tx, 0);
    const unitOfWork = new PostgreSQLAuthUnitOfWork(db);

    const result = await unitOfWork.confirmTwoFactorSetup({
      identityId: "admin-1", expectedSessionVersion: 1, expectedPendingEncryptedSecret: "pending-secret",
      confirmedAt: new Date("2026-08-18T00:00:00Z"), recoveryCodes: [{ id: "code-1", codeHash: "hash-1" }],
    });

    expect(result).toEqual({ status: "conflict" });
    expect(attempts.count).toBe(1);
    expect((tx.adminTwoFactor.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("completeTwoFactorChallenge retries a transient P1008 failure and succeeds on the second attempt", async () => {
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ attempt_count: 0 }]) // challenge guard
        .mockResolvedValueOnce([{ session_version: 1 }]), // session guard
      adminRecoveryCode: { updateMany: vi.fn() },
      adminTwoFactorChallenge: { update: vi.fn().mockResolvedValue({}) },
      adminIdentity: { update: vi.fn() },
      adminSession: { update: vi.fn().mockResolvedValue({}) },
    };
    const { db, attempts } = fakeTransactionDb(tx, 1);
    const unitOfWork = new PostgreSQLAuthUnitOfWork(db);

    const result = await unitOfWork.completeTwoFactorChallenge({
      challengeId: "challenge-1", identityId: "admin-1", sessionId: "session-1",
      completedAt: new Date("2026-08-18T00:00:00Z"), recoveryCodeId: null,
    });

    expect(attempts.count).toBe(2);
    expect(result).toEqual({ status: "committed", sessionVersion: 1 });
    expect((tx.adminTwoFactorChallenge.update as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("completeTwoFactorChallenge does not retry an already-consumed challenge — one attempt only", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValueOnce([]), // consumed_at IS NULL no longer matches
      adminRecoveryCode: { updateMany: vi.fn() },
      adminTwoFactorChallenge: { update: vi.fn() },
      adminIdentity: { update: vi.fn() },
      adminSession: { update: vi.fn() },
    };
    const { db, attempts } = fakeTransactionDb(tx, 0);
    const unitOfWork = new PostgreSQLAuthUnitOfWork(db);

    const result = await unitOfWork.completeTwoFactorChallenge({
      challengeId: "challenge-1", identityId: "admin-1", sessionId: "session-1",
      completedAt: new Date("2026-08-18T00:00:00Z"), recoveryCodeId: null,
    });

    expect(result).toEqual({ status: "challenge_unavailable" });
    expect(attempts.count).toBe(1);
  });
});
