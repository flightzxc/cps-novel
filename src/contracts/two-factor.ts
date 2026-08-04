import type { TwoFactorChallenge, TwoFactorState } from "@/lib/auth/types";

export type TwoFactorStatus = "disabled" | "pending" | "pending_expired" | "enabled";

export type TwoFactorStateView = {
  readonly status: TwoFactorStatus;
  readonly confirmedAt: string | null;
  readonly pendingExpiresAt: string | null;
  readonly recoveryCodesRemaining: number;
  readonly recoveryCodesRotatedAt: string | null;
};

/**
 * Shown exactly once, immediately after `startTwoFactorSetup`.
 *
 * `manualKey` and `otpauthUri` both carry the raw TOTP secret. They exist in the
 * response body and nowhere else: the database only ever holds the AES-GCM
 * ciphertext, and re-reading setup state must never reproduce them.
 */
export type TwoFactorSetupResult = {
  readonly manualKey: string;
  readonly otpauthUri: string;
  readonly pendingExpiresAt: string;
};

/**
 * Shown exactly once, after setup confirmation or an explicit rotation.
 * Only bcrypt/scrypt hashes persist, so these plaintext codes are unrecoverable.
 */
export type RecoveryCodesOneTimeResult = {
  readonly codes: readonly string[];
  readonly generatedAt: string;
};

/**
 * What the challenge screen may know.
 *
 * Deliberately excludes the challenge id, its `tokenHash`, the bound
 * `sessionId` and `identityId`: the raw token lives in an httpOnly cookie and
 * the browser needs neither the handle nor the binding to render the form.
 */
export type TwoFactorChallengeView = {
  readonly expiresAt: string;
  readonly attemptsRemaining: number;
};

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Derive the four setup states.
 *
 * `pendingEncryptedSecret` is read for presence only — its value is ciphertext
 * and never leaves the server. `pending_expired` is the state that tells the UI
 * to offer "restart setup" rather than "enter the code from your app".
 */
export function projectTwoFactorState(input: {
  state: Pick<
    TwoFactorState,
    "enabled" | "confirmedAt" | "pendingEncryptedSecret" | "pendingExpiresAt" | "recoveryCodesRotatedAt"
  >;
  recoveryCodesRemaining: number;
  now: Date;
}): TwoFactorStateView {
  const { state } = input;
  const pendingAlive = Boolean(
    state.pendingEncryptedSecret &&
      state.pendingExpiresAt &&
      state.pendingExpiresAt.getTime() > input.now.getTime(),
  );
  const status: TwoFactorStatus = state.enabled
    ? "enabled"
    : pendingAlive
      ? "pending"
      : state.pendingEncryptedSecret
        ? "pending_expired"
        : "disabled";

  return Object.freeze({
    status,
    confirmedAt: toIso(state.confirmedAt),
    pendingExpiresAt: toIso(state.pendingExpiresAt),
    recoveryCodesRemaining: Math.max(0, Math.trunc(input.recoveryCodesRemaining)),
    recoveryCodesRotatedAt: toIso(state.recoveryCodesRotatedAt),
  });
}

export function projectTwoFactorSetup(input: {
  manualKey: string;
  otpauthUri: string;
  pendingExpiresAt: Date;
}): TwoFactorSetupResult {
  return Object.freeze({
    manualKey: input.manualKey,
    otpauthUri: input.otpauthUri,
    pendingExpiresAt: input.pendingExpiresAt.toISOString(),
  });
}

export function projectRecoveryCodes(input: {
  codes: readonly string[];
  generatedAt: Date;
}): RecoveryCodesOneTimeResult {
  return Object.freeze({
    codes: Object.freeze([...input.codes]),
    generatedAt: input.generatedAt.toISOString(),
  });
}

export function projectTwoFactorChallenge(input: {
  challenge: Pick<TwoFactorChallenge, "expiresAt" | "attemptCount">;
  maxAttempts: number;
}): TwoFactorChallengeView {
  return Object.freeze({
    expiresAt: input.challenge.expiresAt.toISOString(),
    attemptsRemaining: Math.max(0, input.maxAttempts - input.challenge.attemptCount),
  });
}
