import { createHash, randomBytes, randomUUID } from "node:crypto";

import { AdminAccessError } from "./errors";
import type { AdminIdentityStore, RecoveryCodeStore, TwoFactorStore } from "./ports";
import { generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode } from "./recovery-codes";
import { decryptTotpSecret, encryptTotpSecret } from "./totp-crypto";
import { createTotpUri, generateTotpSecret, verifyTotpCode } from "./totp";
import type { TwoFactorChallenge } from "./types";

export const TWO_FACTOR_PENDING_SETUP_TTL_MS = 10 * 60 * 1000;
export const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS = 5;

export function hashTwoFactorChallengeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function startTwoFactorSetup(input: {
  identityId: string;
  identities: AdminIdentityStore;
  twoFactor: TwoFactorStore;
  encryptionKey?: string;
  now?: Date;
}): Promise<{ manualKey: string; otpauthUri: string; pendingExpiresAt: Date }> {
  const identity = await input.identities.findById(input.identityId);
  if (!identity || identity.status !== "active") throw new Error("Admin identity not found");
  if (identity.twoFactorEnabled) throw new Error("Two-factor authentication is already enabled");
  const now = input.now ?? new Date();
  const secret = generateTotpSecret();
  const pendingExpiresAt = new Date(now.getTime() + TWO_FACTOR_PENDING_SETUP_TTL_MS);
  await input.twoFactor.savePendingSetup(
    identity.id,
    encryptTotpSecret(secret, input.encryptionKey),
    pendingExpiresAt,
  );
  return {
    manualKey: secret,
    otpauthUri: createTotpUri(identity.username, secret),
    pendingExpiresAt,
  };
}

export async function confirmTwoFactorSetup(input: {
  identityId: string;
  code: string;
  identities: AdminIdentityStore;
  twoFactor: TwoFactorStore;
  recoveryCodes: RecoveryCodeStore;
  encryptionKey?: string;
  now?: Date;
  recoveryHashCost?: number;
}): Promise<{ recoveryCodes: string[]; nextSessionVersion: number }> {
  const now = input.now ?? new Date();
  const identity = await input.identities.findById(input.identityId);
  const state = await input.twoFactor.findByIdentityId(input.identityId);
  if (!identity || !state?.pendingEncryptedSecret || !state.pendingExpiresAt) {
    throw new Error("Two-factor setup is not pending");
  }
  if (state.pendingExpiresAt.getTime() <= now.getTime()) {
    throw new AdminAccessError("two_factor_expired", 403, "Two-factor setup expired");
  }
  const secret = decryptTotpSecret(state.pendingEncryptedSecret, input.encryptionKey);
  if (!verifyTotpCode(secret, input.code, { timestamp: now.getTime() })) {
    throw new AdminAccessError("two_factor_failed", 403, "Invalid two-factor code");
  }
  const plainCodes = generateRecoveryCodes();
  await input.recoveryCodes.replaceForIdentity(
    identity.id,
    plainCodes.map((code) => ({
      id: randomUUID(),
      codeHash: hashRecoveryCode(code, { cost: input.recoveryHashCost }),
    })),
    now,
  );
  if (!(await input.twoFactor.enableFromPending(identity.id, now))) {
    throw new Error("Two-factor setup state changed concurrently");
  }
  const nextSessionVersion = await input.identities.advanceSessionVersion(
    identity.id,
    identity.sessionVersion,
  );
  if (nextSessionVersion === null) throw new Error("Admin identity changed concurrently");
  return { recoveryCodes: plainCodes, nextSessionVersion };
}

export async function createTwoFactorChallenge(input: {
  identityId: string;
  twoFactor: TwoFactorStore;
  now?: Date;
}): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + TWO_FACTOR_CHALLENGE_TTL_MS);
  await input.twoFactor.createChallenge({
    id: randomUUID(),
    identityId: input.identityId,
    tokenHash: hashTwoFactorChallengeToken(token),
    expiresAt,
    consumedAt: null,
    attemptCount: 0,
    createdAt: now,
  });
  return { token, expiresAt };
}

function validateChallenge(challenge: TwoFactorChallenge | null, now: Date): TwoFactorChallenge {
  if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() <= now.getTime()) {
    throw new AdminAccessError("two_factor_expired", 403, "Two-factor challenge expired");
  }
  if (challenge.attemptCount >= TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS) {
    throw new AdminAccessError("two_factor_locked", 403, "Two-factor challenge locked");
  }
  return challenge;
}

export async function completeTwoFactorChallenge(input: {
  token: string;
  code?: string;
  recoveryCode?: string;
  twoFactor: TwoFactorStore;
  recoveryCodes: RecoveryCodeStore;
  encryptionKey?: string;
  now?: Date;
}): Promise<{ identityId: string; completedAt: Date; method: "totp" | "recovery_code" }> {
  const now = input.now ?? new Date();
  const challenge = validateChallenge(
    await input.twoFactor.findChallengeByTokenHash(hashTwoFactorChallengeToken(input.token)),
    now,
  );
  const state = await input.twoFactor.findByIdentityId(challenge.identityId);
  if (!state?.enabled || !state.encryptedSecret) {
    throw new AdminAccessError("two_factor_failed", 403, "Two-factor authentication is unavailable");
  }

  let method: "totp" | "recovery_code" | null = null;
  if (input.code) {
    const secret = decryptTotpSecret(state.encryptedSecret, input.encryptionKey);
    if (verifyTotpCode(secret, input.code, { timestamp: now.getTime() })) method = "totp";
  } else if (input.recoveryCode) {
    for (const record of await input.recoveryCodes.listUnused(challenge.identityId)) {
      if (
        verifyRecoveryCode(input.recoveryCode, record.codeHash) &&
        (await input.recoveryCodes.consumeIfUnused(record.id, now))
      ) {
        method = "recovery_code";
        break;
      }
    }
  }

  if (!method) {
    await input.twoFactor.incrementChallengeAttempts(challenge.id);
    throw new AdminAccessError("two_factor_failed", 403, "Invalid two-factor or recovery code");
  }
  if (!(await input.twoFactor.consumeChallenge(challenge.id, now))) {
    throw new AdminAccessError("two_factor_expired", 403, "Two-factor challenge already consumed");
  }
  return { identityId: challenge.identityId, completedAt: now, method };
}
