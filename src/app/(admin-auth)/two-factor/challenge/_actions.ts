"use server";

import type { ErrorEnvelope } from "@/contracts";
import { AdminAccessError } from "@/lib/auth/errors";
import { completeTwoFactorChallenge, createTwoFactorChallenge } from "@/lib/auth/two-factor";

import { authUnitOfWork, recoveryCodeStore, twoFactorStore } from "../../../api/admin/_lib/auth-deps";
import { toErrorEnvelope } from "../../../api/admin/_lib/respond";
import {
  ADMIN_LANDING_PATH,
  clearTwoFactorChallengeCookie,
  readTwoFactorChallengeToken,
  requireActiveContext,
  requireSameOriginSubmission,
  safeNextPath,
  writeTwoFactorChallengeCookie,
} from "../../_lib/auth-session";

export type ChallengeActionResult = { ok: true; next: string } | { ok: false; envelope: ErrorEnvelope };
export type ResendChallengeResult = { ok: true } | { ok: false; envelope: ErrorEnvelope };

/**
 * Submits either a 6-digit TOTP code or a recovery code against the pending
 * challenge. Requires a valid session (`requireActiveContext` — the same
 * primitive `requireAdminPage` uses, just not registry-gated: see
 * `_lib/auth-session.ts`) plus the raw challenge token from the httpOnly 2FA
 * cookie; `completeTwoFactorChallenge` (Codex, `@/lib/auth/two-factor.ts`)
 * cross-checks the challenge is bound to that exact session and identity.
 */
export async function completeChallengeAction(input: {
  code?: string;
  recoveryCode?: string;
  next?: string | null;
}): Promise<ChallengeActionResult> {
  try {
    await requireSameOriginSubmission();
    const context = await requireActiveContext();
    const token = await readTwoFactorChallengeToken();
    if (!token) {
      throw new AdminAccessError("two_factor_expired", 403, "Two-factor challenge expired");
    }
    await completeTwoFactorChallenge({
      context,
      token,
      code: input.code,
      recoveryCode: input.recoveryCode,
      twoFactor: twoFactorStore(),
      recoveryCodes: recoveryCodeStore(),
      transactions: authUnitOfWork(),
    });
    await clearTwoFactorChallengeCookie();
    return { ok: true, next: safeNextPath(input.next) ?? ADMIN_LANDING_PATH };
  } catch (error) {
    return { ok: false, envelope: toErrorEnvelope(error) };
  }
}

/** Issues a fresh challenge (new token, new 5-minute window) when the
 * previous one expired or was never received. The page re-reads the cookie
 * server-side on the next render, so the client only needs `router.refresh()`. */
export async function resendChallengeAction(): Promise<ResendChallengeResult> {
  try {
    await requireSameOriginSubmission();
    const context = await requireActiveContext();
    if (!context.identity.twoFactorEnabled) {
      throw new AdminAccessError("two_factor_failed", 403, "Two-factor is not enabled for this account");
    }
    const challenge = await createTwoFactorChallenge({ context, twoFactor: twoFactorStore() });
    await writeTwoFactorChallengeCookie(challenge.token);
    return { ok: true };
  } catch (error) {
    return { ok: false, envelope: toErrorEnvelope(error) };
  }
}
