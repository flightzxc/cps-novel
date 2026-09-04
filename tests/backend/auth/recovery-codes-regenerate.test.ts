import { describe, expect, it } from "vitest";

import { regenerateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode } from "@/lib/auth/recovery-codes";
import { encryptTotpSecret } from "@/lib/auth/totp-crypto";
import { generateTotpCode } from "@/lib/auth/totp";
import { TestOnlyInMemoryAuthStores } from "./test-only-in-memory-stores";

const NOW = new Date("2026-09-05T00:00:00Z");
const KEY = Buffer.alloc(32, 9).toString("base64");
const SECRET = "JBSWY3DPEHPK3PXP";

function stores() {
  const memory = new TestOnlyInMemoryAuthStores();
  memory.identities.set("admin-1", { id: "admin-1", username: "admin", role: "viewer", status: "active", sessionVersion: 4, twoFactorEnabled: true });
  memory.twoFactorStates.set("admin-1", { identityId: "admin-1", enabled: true, encryptedSecret: encryptTotpSecret(SECRET, KEY), confirmedAt: NOW, pendingEncryptedSecret: null, pendingExpiresAt: null, recoveryCodesRotatedAt: NOW });
  memory.recovery.set("old", { id: "old", identityId: "admin-1", codeHash: hashRecoveryCode("ABCD-1234-EF56", { cost: 1024 }), usedAt: null });
  return memory;
}

describe("regenerateRecoveryCodes · CPS transaction semantics", () => {
  it("requires current TOTP, replaces old codes, and increments sessionVersion", async () => {
    const memory = stores();
    const result = await regenerateRecoveryCodes({ identityId: "admin-1", code: generateTotpCode(SECRET, NOW.getTime()), identities: memory, twoFactor: memory, transactions: memory, encryptionKey: KEY, now: NOW, recoveryHashCost: 1024 });
    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.nextSessionVersion).toBe(5);
    expect(memory.recovery.has("old")).toBe(false);
    expect(memory.identities.get("admin-1")?.sessionVersion).toBe(5);
    const hashes = [...memory.recovery.values()].map((row) => row.codeHash);
    expect(hashes.some((hash) => verifyRecoveryCode(result.recoveryCodes[0]!, hash))).toBe(true);
  });

  it("invalid TOTP performs no rotation and no session invalidation", async () => {
    const memory = stores();
    await expect(regenerateRecoveryCodes({ identityId: "admin-1", code: "000000", identities: memory, twoFactor: memory, transactions: memory, encryptionKey: KEY, now: NOW, recoveryHashCost: 1024 })).rejects.toMatchObject({ code: "two_factor_failed" });
    expect(memory.recovery.has("old")).toBe(true);
    expect(memory.identities.get("admin-1")?.sessionVersion).toBe(4);
  });
});
