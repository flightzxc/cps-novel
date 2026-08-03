import { describe, expect, it } from "vitest";

import { AdminAccessError } from "@/lib/auth/errors";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "@/lib/auth/recovery-codes";
import { decryptTotpSecret, encryptTotpSecret, TotpSecretCryptoError } from "@/lib/auth/totp-crypto";
import { generateTotpCode, generateTotpSecret, verifyTotpCode } from "@/lib/auth/totp";
import {
  completeTwoFactorChallenge,
  confirmTwoFactorSetup,
  createTwoFactorChallenge,
  startTwoFactorSetup,
} from "@/lib/auth/two-factor";

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
      recoveryCodes: memory,
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
    const secret = generateTotpSecret();
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
    const challenge = await createTwoFactorChallenge({ identityId: "admin-1", twoFactor: memory, now: NOW });
    await expect(
      completeTwoFactorChallenge({
        token: challenge.token,
        code: "000000",
        twoFactor: memory,
        recoveryCodes: memory,
        encryptionKey: KEY,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "two_factor_failed" });
    expect([...memory.challenges.values()][0].attemptCount).toBe(1);

    const result = await completeTwoFactorChallenge({
      token: challenge.token,
      code: generateTotpCode(secret, NOW.getTime()),
      twoFactor: memory,
      recoveryCodes: memory,
      encryptionKey: KEY,
      now: NOW,
    });
    expect(result.method).toBe("totp");
    expect([...memory.challenges.values()][0].consumedAt).toEqual(NOW);
    await expect(
      completeTwoFactorChallenge({
        token: challenge.token,
        code: generateTotpCode(secret, NOW.getTime()),
        twoFactor: memory,
        recoveryCodes: memory,
        encryptionKey: KEY,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AdminAccessError);
  });

  it("consumes a recovery code exactly once", async () => {
    const memory = stores();
    const secret = generateTotpSecret();
    const recoveryCode = "ABCD-1234-EF56";
    memory.identities.get("admin-1")!.twoFactorEnabled = true;
    memory.twoFactorStates.set("admin-1", {
      identityId: "admin-1",
      enabled: true,
      encryptedSecret: encryptTotpSecret(secret, KEY),
      confirmedAt: NOW,
      pendingEncryptedSecret: null,
      pendingExpiresAt: null,
      recoveryCodesRotatedAt: NOW,
    });
    await memory.replaceForIdentity(
      "admin-1",
      [{ id: "recovery-1", codeHash: hashRecoveryCode(recoveryCode, { cost: 1024 }) }],
      NOW,
    );
    const first = await createTwoFactorChallenge({ identityId: "admin-1", twoFactor: memory, now: NOW });
    await expect(
      completeTwoFactorChallenge({
        token: first.token,
        recoveryCode,
        twoFactor: memory,
        recoveryCodes: memory,
        encryptionKey: KEY,
        now: NOW,
      }),
    ).resolves.toMatchObject({ method: "recovery_code" });
    expect(memory.recovery.get("recovery-1")?.usedAt).toEqual(NOW);

    const second = await createTwoFactorChallenge({ identityId: "admin-1", twoFactor: memory, now: NOW });
    await expect(
      completeTwoFactorChallenge({
        token: second.token,
        recoveryCode,
        twoFactor: memory,
        recoveryCodes: memory,
        encryptionKey: KEY,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "two_factor_failed" });
  });
});
