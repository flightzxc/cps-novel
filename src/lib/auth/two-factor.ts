import { createHash, randomBytes, randomUUID } from "node:crypto";

import { AdminAccessError } from "./errors";
import type {
  AdminIdentityStore,
  AuthUnitOfWork,
  RecoveryCodeStore,
  TwoFactorStore,
} from "./ports";
import { generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode } from "./recovery-codes";
import { validateAdminSession } from "./session";
import { decryptTotpSecret, encryptTotpSecret } from "./totp-crypto";
import { createTotpUri, generateTotpSecret, verifyTotpCode } from "./totp";
import type { AdminAuthContext, TwoFactorChallenge } from "./types";

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
  transactions: AuthUnitOfWork;
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
  const transaction = await input.transactions.confirmTwoFactorSetup({
    identityId: identity.id,
    expectedSessionVersion: identity.sessionVersion,
    expectedPendingEncryptedSecret: state.pendingEncryptedSecret,
    confirmedAt: now,
    recoveryCodes: plainCodes.map((code) => ({
      id: randomUUID(),
      codeHash: hashRecoveryCode(code, { cost: input.recoveryHashCost }),
    })),
  });
  if (transaction.status !== "committed") {
    throw new Error("Two-factor setup state changed concurrently");
  }
  return { recoveryCodes: plainCodes, nextSessionVersion: transaction.nextSessionVersion };
}

export async function createTwoFactorChallenge(input: {
  context: AdminAuthContext;
  twoFactor: TwoFactorStore;
  now?: Date;
}): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const now = input.now ?? new Date();
  const context = validateAdminSession(input.context.session, input.context.identity, now);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + TWO_FACTOR_CHALLENGE_TTL_MS);
  await input.twoFactor.createChallenge({
    id: randomUUID(),
    identityId: context.identity.id,
    sessionId: context.session.id,
    tokenHash: hashTwoFactorChallengeToken(token),
    expiresAt,
    consumedAt: null,
    attemptCount: 0,
    createdAt: now,
  });
  return { token, expiresAt, sessionId: context.session.id };
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
  context: AdminAuthContext;
  token: string;
  code?: string;
  recoveryCode?: string;
  twoFactor: TwoFactorStore;
  recoveryCodes: RecoveryCodeStore;
  transactions: AuthUnitOfWork;
  encryptionKey?: string;
  now?: Date;
}): Promise<{
  identityId: string;
  sessionId: string;
  completedAt: Date;
  method: "totp" | "recovery_code";
  sessionVersion: number;
}> {
  const now = input.now ?? new Date();
  const context = validateAdminSession(input.context.session, input.context.identity, now);
  const challenge = validateChallenge(
    await input.twoFactor.findChallengeByTokenHash(hashTwoFactorChallengeToken(input.token)),
    now,
  );
  if (
    challenge.identityId !== context.identity.id ||
    challenge.sessionId !== context.session.id
  ) {
    throw new AdminAccessError(
      "two_factor_failed",
      403,
      "Two-factor challenge is bound to another session",
    );
  }
  const state = await input.twoFactor.findByIdentityId(challenge.identityId);
  if (!state?.enabled || !state.encryptedSecret) {
    throw new AdminAccessError("two_factor_failed", 403, "Two-factor authentication is unavailable");
  }

  let method: "totp" | "recovery_code" | null = null;
  let recoveryCodeId: string | null = null;
  if (input.code) {
    const secret = decryptTotpSecret(state.encryptedSecret, input.encryptionKey);
    if (verifyTotpCode(secret, input.code, { timestamp: now.getTime() })) method = "totp";
  } else if (input.recoveryCode) {
    for (const record of await input.recoveryCodes.listUnused(challenge.identityId)) {
      if (verifyRecoveryCode(input.recoveryCode, record.codeHash)) {
        method = "recovery_code";
        recoveryCodeId = record.id;
        break;
      }
    }
  }

  if (!method) {
    await input.twoFactor.incrementChallengeAttempts({
      challengeId: challenge.id,
      now,
      maxAttempts: TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS,
    });
    throw new AdminAccessError("two_factor_failed", 403, "Invalid two-factor or recovery code");
  }
  const transaction = await input.transactions.completeTwoFactorChallenge({
    challengeId: challenge.id,
    identityId: challenge.identityId,
    sessionId: challenge.sessionId,
    completedAt: now,
    recoveryCodeId,
  });
  if (transaction.status === "challenge_unavailable") {
    throw new AdminAccessError("two_factor_expired", 403, "Two-factor challenge already consumed");
  }
  if (transaction.status !== "committed") {
    throw new AdminAccessError("two_factor_failed", 403, "Two-factor transaction could not commit");
  }
  return {
    identityId: challenge.identityId,
    sessionId: challenge.sessionId,
    completedAt: now,
    method,
    sessionVersion: transaction.sessionVersion,
  };
}
