import { describe, expect, it } from "vitest";

import { AdminAccessError } from "@/lib/auth/errors";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "@/lib/auth/recovery-codes";
import { validateAdminSession } from "@/lib/auth/session";
import { decryptTotpSecret, encryptTotpSecret, TotpSecretCryptoError } from "@/lib/auth/totp-crypto";
import { generateTotpCode, generateTotpSecret, verifyTotpCode } from "@/lib/auth/totp";
import {
  completeTwoFactorChallenge,
  confirmTwoFactorSetup,
  createTwoFactorChallenge,
  startTwoFactorSetup,
} from "@/lib/auth/two-factor";
import type { AdminAuthContext, AdminSessionRecord } from "@/lib/auth/types";

import { TestOnlyInMemoryAuthStores } from "./test-only-in-memory-stores";

const NOW = new Date("2026-08-03T12:00:00.000Z");
const KEY = Buffer.alloc(32, 7).toString("base64");
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function stores() {
  const value = new TestOnlyInMemoryAuthStores();
  value.identities.set("admin-1", {
    id: "admin-1",
    username: "admin",
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: false,
  });
  return value;
}

function sessionContext(
  memory: TestOnlyInMemoryAuthStores,
  sessionId = "session-1",
): AdminAuthContext {
  const identity = memory.identities.get("admin-1")!;
  const issuedAt = new Date(NOW.getTime() - 60_000);
  const session: AdminSessionRecord = {
    id: sessionId,
    identityId: identity.id,
    tokenHash: `token-hash-${sessionId}`,
    sessionVersion: identity.sessionVersion,
    issuedAt,
    lastSeenAt: issuedAt,
    absoluteExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    twoFactorCompletedAt: null,
    revokedAt: null,
  };
  memory.sessions.set(session.id, session);
  return {
    identity: { ...identity },
    session: { ...session },
    twoFactorCompleted: false,
  };
}

function enableTwoFactor(memory: TestOnlyInMemoryAuthStores, secret = generateTotpSecret()) {
  memory.identities.get("admin-1")!.twoFactorEnabled = true;
  memory.twoFactorStates.set("admin-1", {
    identityId: "admin-1",
    enabled: true,
    encryptedSecret: encryptTotpSecret(secret, KEY),
    confirmedAt: NOW,
    pendingEncryptedSecret: null,
    pendingExpiresAt: null,
    recoveryCodesRotatedAt: null,
  });
  return secret;
}

describe("TOTP and recovery primitives", () => {
  it("matches the RFC 6238 SHA1 vector reduced to six digits", () => {
    expect(generateTotpCode(RFC_SECRET, 59_000)).toBe("287082");
    expect(verifyTotpCode(RFC_SECRET, "287082", { timestamp: 59_000, window: 0 })).toBe(true);
    expect(verifyTotpCode(RFC_SECRET, "287082", { timestamp: 119_000, window: 0 })).toBe(false);
  });

  it("generates base32 secrets and accepts only the +/- one-step window", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const code = generateTotpCode(secret, NOW.getTime() - 30_000);
    expect(verifyTotpCode(secret, code, { timestamp: NOW.getTime() })).toBe(true);
    const stale = generateTotpCode(secret, NOW.getTime() - 60_000);
    expect(verifyTotpCode(secret, stale, { timestamp: NOW.getTime() })).toBe(false);
  });

  it("encrypts TOTP secrets with authenticated AES-GCM and fails closed", () => {
    const payload = encryptTotpSecret(RFC_SECRET, KEY);
    expect(payload).not.toContain(RFC_SECRET);
    expect(decryptTotpSecret(payload, KEY)).toBe(RFC_SECRET);
    const parts = payload.split(":");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    expect(() => decryptTotpSecret(parts.join(":"), KEY)).toThrow(TotpSecretCryptoError);
    expect(() => encryptTotpSecret(RFC_SECRET, "bad-key")).toThrow(TotpSecretCryptoError);
  });

  it("stores recovery codes as salted scrypt hashes", () => {
    const [code, other] = generateRecoveryCodes(2);
    const firstHash = hashRecoveryCode(code, { cost: 1024 });
    const secondHash = hashRecoveryCode(code, { cost: 1024 });
    expect(firstHash).not.toBe(secondHash);
    expect(firstHash).not.toContain(code);
    expect(verifyRecoveryCode(code, firstHash)).toBe(true);
    expect(verifyRecoveryCode(other, firstHash)).toBe(false);
  });
});

describe("two-factor service", () => {
  it("sets up TOTP and returns recovery codes only once", async () => {
    const memory = stores();
    const setup = await startTwoFactorSetup({
      identityId: "admin-1",
      identities: memory,
      twoFactor: memory,
      encryptionKey: KEY,
      now: NOW,
    });
    expect(setup.otpauthUri).toContain("otpauth://totp/");
    const result = await confirmTwoFactorSetup({
      identityId: "admin-1",
      code: generateTotpCode(setup.manualKey, NOW.getTime()),
      identities: memory,
      twoFactor: memory,
      transactions: memory,
      encryptionKey: KEY,
      recoveryHashCost: 1024,
      now: NOW,
    });
    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.nextSessionVersion).toBe(2);
    expect(memory.twoFactorStates.get("admin-1")?.enabled).toBe(true);
    expect([...memory.recovery.values()].some((row) => result.recoveryCodes.includes(row.codeHash))).toBe(false);
  });

  it("records failed challenge attempts and consumes a valid TOTP challenge", async () => {
    const memory = stores();
    const secret = enableTwoFactor(memory);
    const context = sessionContext(memory);
    const challenge = await createTwoFactorChallenge({ context, twoFactor: memory, now: NOW });
    await expect(
      completeTwoFactorChallenge({
        context,
        token: challenge.token,
        code: "000000",
        twoFactor: memory,
        recoveryCodes: memory,
        transactions: memory,
        encryptionKey: KEY,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "two_factor_failed" });
    expect([...memory.challenges.values()][0].attemptCount).toBe(1);

    const result = await completeTwoFactorChallenge({
      context,
      token: challenge.token,
      code: generateTotpCode(secret, NOW.getTime()),
      twoFactor: memory,
      recoveryCodes: memory,
      transactions: memory,
      encryptionKey: KEY,
      now: NOW,
    });
    expect(result.method).toBe("totp");
    expect(result.sessionId).toBe(context.session.id);
    expect([...memory.challenges.values()][0].consumedAt).toEqual(NOW);
    expect(memory.sessions.get(context.session.id)?.twoFactorCompletedAt).toEqual(NOW);
    await expect(
      completeTwoFactorChallenge({
        context,
        token: challenge.token,
        code: generateTotpCode(secret, NOW.getTime()),
        twoFactor: memory,
        recoveryCodes: memory,
        transactions: memory,
        encryptionKey: KEY,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AdminAccessError);
  });

  it("consumes a recovery code exactly once", async () => {
    const memory = stores();
    const recoveryCode = "ABCD-1234-EF56";
    enableTwoFactor(memory);
    memory.recovery.set("recovery-1", {
      id: "recovery-1",
      identityId: "admin-1",
      codeHash: hashRecoveryCode(recoveryCode, { cost: 1024 }),
      usedAt: null,
    });
    const oldContext = sessionContext(memory, "session-old");
    const context = sessionContext(memory, "session-bound");
    const first = await createTwoFactorChallenge({ context, twoFactor: memory, now: NOW });
    const result = await completeTwoFactorChallenge({
      context,
      token: first.token,
      recoveryCode,
      twoFactor: memory,
      recoveryCodes: memory,
      transactions: memory,
      encryptionKey: KEY,
      now: NOW,
    });
    expect(result).toMatchObject({ method: "recovery_code", sessionVersion: 2 });
    expect(memory.recovery.get("recovery-1")?.usedAt).toEqual(NOW);
    expect(memory.identities.get("admin-1")?.sessionVersion).toBe(2);
    expect(memory.sessions.get(context.session.id)).toMatchObject({
      sessionVersion: 2,
      twoFactorCompletedAt: NOW,
    });
    expect(() =>
      validateAdminSession(
        memory.sessions.get(oldContext.session.id)!,
        memory.identities.get("admin-1")!,
        NOW,
      ),
    ).toThrowError(expect.objectContaining({ code: "jwt_invalid" }));
    expect(() =>
      validateAdminSession(
        memory.sessions.get(context.session.id)!,
        memory.identities.get("admin-1")!,
        NOW,
      ),
    ).not.toThrow();

    const refreshedContext = validateAdminSession(
      memory.sessions.get(context.session.id)!,
      memory.identities.get("admin-1")!,
      NOW,
    );
    const second = await createTwoFactorChallenge({
      context: refreshedContext,
      twoFactor: memory,
      now: NOW,
    });
    await expect(
      completeTwoFactorChallenge({
        context: refreshedContext,
        token: second.token,
        recoveryCode,
        twoFactor: memory,
        recoveryCodes: memory,
        transactions: memory,
        encryptionKey: KEY,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "two_factor_failed" });
  });

  it("binds a challenge to exactly one session for an identity", async () => {
    const memory = stores();
    const secret = enableTwoFactor(memory);
    const boundContext = sessionContext(memory, "session-bound");
    const otherContext = sessionContext(memory, "session-other");
    const challenge = await createTwoFactorChallenge({
      context: boundContext,
      twoFactor: memory,
      now: NOW,
    });

    await expect(
      completeTwoFactorChallenge({
        context: otherContext,
        token: challenge.token,
        code: generateTotpCode(secret, NOW.getTime()),
        twoFactor: memory,
        recoveryCodes: memory,
        transactions: memory,
        encryptionKey: KEY,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "two_factor_failed", status: 403 });
    expect([...memory.challenges.values()][0].consumedAt).toBeNull();
    expect(memory.sessions.get("session-other")?.twoFactorCompletedAt).toBeNull();

    await expect(
      completeTwoFactorChallenge({
        context: boundContext,
        token: challenge.token,
        code: generateTotpCode(secret, NOW.getTime()),
        twoFactor: memory,
        recoveryCodes: memory,
        transactions: memory,
        encryptionKey: KEY,
        now: NOW,
      }),
    ).resolves.toMatchObject({ sessionId: "session-bound", method: "totp" });
  });

  it("rolls back every setup mutation when its transaction cannot commit", async () => {
    for (const failure of ["enable", "recovery", "session_version"] as const) {
      const memory = stores();
      const setup = await startTwoFactorSetup({
        identityId: "admin-1",
        identities: memory,
        twoFactor: memory,
        encryptionKey: KEY,
        now: NOW,
      });
      memory.recovery.set("existing", {
        id: "existing",
        identityId: "admin-1",
        codeHash: hashRecoveryCode("AABB-CCDD-1122", { cost: 1024 }),
        usedAt: null,
      });
      memory.failNextSetupTransactionAt = failure;

      await expect(
        confirmTwoFactorSetup({
          identityId: "admin-1",
          code: generateTotpCode(setup.manualKey, NOW.getTime()),
          identities: memory,
          twoFactor: memory,
          transactions: memory,
          encryptionKey: KEY,
          recoveryHashCost: 1024,
          now: NOW,
        }),
      ).rejects.toThrow("state changed concurrently");
      expect(memory.identities.get("admin-1")).toMatchObject({
        sessionVersion: 1,
        twoFactorEnabled: false,
      });
      expect(memory.twoFactorStates.get("admin-1")).toMatchObject({
        enabled: false,
        encryptedSecret: null,
        pendingEncryptedSecret: expect.any(String),
      });
      expect([...memory.recovery.keys()]).toEqual(["existing"]);
    }
  });

  it("does not burn a recovery code or partially complete a session on transaction failure", async () => {
    for (const failure of [
      "challenge_unavailable",
      "session_unavailable",
      "recovery_code_unavailable",
    ] as const) {
      const memory = stores();
      enableTwoFactor(memory);
      const recoveryCode = "ABCD-1234-EF56";
      memory.recovery.set("recovery-1", {
        id: "recovery-1",
        identityId: "admin-1",
        codeHash: hashRecoveryCode(recoveryCode, { cost: 1024 }),
        usedAt: null,
      });
      const context = sessionContext(memory);
      const challenge = await createTwoFactorChallenge({ context, twoFactor: memory, now: NOW });
      memory.failNextChallengeTransaction = failure;

      await expect(
        completeTwoFactorChallenge({
          context,
          token: challenge.token,
          recoveryCode,
          twoFactor: memory,
          recoveryCodes: memory,
          transactions: memory,
          encryptionKey: KEY,
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(AdminAccessError);
      expect(memory.recovery.get("recovery-1")?.usedAt).toBeNull();
      expect([...memory.challenges.values()][0].consumedAt).toBeNull();
      expect(memory.sessions.get(context.session.id)?.twoFactorCompletedAt).toBeNull();
    }
  });

  it("rolls back all recovery-code effects at every atomic transaction stage", async () => {
    for (const failure of [
      "recovery_code",
      "challenge",
      "identity_session_version",
      "bound_session_version",
      "two_factor_completed",
    ] as const) {
      const memory = stores();
      enableTwoFactor(memory);
      const recoveryCode = "ABCD-1234-EF56";
      memory.recovery.set("recovery-1", {
        id: "recovery-1",
        identityId: "admin-1",
        codeHash: hashRecoveryCode(recoveryCode, { cost: 1024 }),
        usedAt: null,
      });
      const context = sessionContext(memory, `session-${failure}`);
      const challenge = await createTwoFactorChallenge({ context, twoFactor: memory, now: NOW });
      memory.failNextRecoveryTransactionAt = failure;

      await expect(
        completeTwoFactorChallenge({
          context,
          token: challenge.token,
          recoveryCode,
          twoFactor: memory,
          recoveryCodes: memory,
          transactions: memory,
          encryptionKey: KEY,
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "two_factor_failed" });
      expect(memory.recovery.get("recovery-1")?.usedAt).toBeNull();
      expect([...memory.challenges.values()][0].consumedAt).toBeNull();
      expect(memory.identities.get("admin-1")?.sessionVersion).toBe(1);
      expect(memory.sessions.get(context.session.id)).toMatchObject({
        sessionVersion: 1,
        twoFactorCompletedAt: null,
      });
    }
  });
});
