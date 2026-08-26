"use server";

import {
  projectRecoveryCodes,
  projectTwoFactorSetup,
  type ErrorEnvelope,
  type RecoveryCodesOneTimeResult,
  type TwoFactorSetupResult,
} from "@/contracts";
import { AdminAccessError } from "@/lib/auth/errors";
import { revokeAdminSession } from "@/lib/auth/login";
import { confirmTwoFactorSetup, startTwoFactorSetup } from "@/lib/auth/two-factor";

import { authUnitOfWork, twoFactorStore } from "../../../api/admin/_lib/auth-deps";
import { guardDependencies } from "../../../api/admin/_lib/deps";
import { toErrorEnvelope } from "../../../api/admin/_lib/respond";
import {
  clearSessionCookie,
  clearTwoFactorChallengeCookie,
  requireActiveContext,
  requireSameOriginSubmission,
} from "../../_lib/auth-session";

export type StartSetupResult =
  | { ok: true; data: TwoFactorSetupResult }
  | { ok: false; envelope: ErrorEnvelope };

export type ConfirmSetupResult =
  | { ok: true; data: RecoveryCodesOneTimeResult }
  | { ok: false; envelope: ErrorEnvelope };

/** Generates a fresh TOTP secret and stores it pending (10-minute TTL).
 * Explicit button-triggered action, not auto-run on page load: re-running it
 * silently (a `useEffect`, a prefetch, a dev Strict-Mode double-render) would
 * regenerate the secret and invalidate whatever the operator just scanned. */
export async function startSetupAction(): Promise<StartSetupResult> {
  try {
    await requireSameOriginSubmission();
    const context = await requireActiveContext();
    if (context.identity.twoFactorEnabled) {
      throw new AdminAccessError(
        "two_factor_failed",
        403,
        "Two-factor authentication is already enabled",
      );
    }
    const { identities } = guardDependencies();
    const setup = await startTwoFactorSetup({
      identityId: context.identity.id,
      identities,
      twoFactor: twoFactorStore(),
    });
    return { ok: true, data: projectTwoFactorSetup(setup) };
  } catch (error) {
    return { ok: false, envelope: toErrorEnvelope(error) };
  }
}

/**
 * Confirms the pending secret against a submitted 6-digit code and returns
 * the one-time recovery codes.
 *
 * `confirmTwoFactorSetup` bumps the identity's `sessionVersion` — the same
 * mechanism `completeTwoFactorChallenge`'s recovery-code path uses to
 * invalidate other outstanding sessions — but unlike that path it has no
 * session in scope to re-sync, and `SessionStore` (`@/lib/auth/ports.ts`)
 * exposes no "set this session's version" primitive a caller could use to
 * keep the current one alive across the bump. The bootstrapping session this
 * action runs under is therefore stale the instant this call returns.
 * Flagged in the PR-C1 report as a service-surface gap; the safe choice here
 * is to not leave it in that half-alive state — revoke it outright and clear
 * both cookies, so the client sends the operator back through `/login`. That
 * second login is not wasted work: `identity.twoFactorEnabled` is now `true`,
 * so this time the 2FA challenge actually engages.
 */
export async function confirmSetupAction(input: { code: string }): Promise<ConfirmSetupResult> {
  try {
    await requireSameOriginSubmission();
    const context = await requireActiveContext();
    const { identities, sessions } = guardDependencies();
    const result = await confirmTwoFactorSetup({
      identityId: context.identity.id,
      code: input.code,
      identities,
      twoFactor: twoFactorStore(),
      transactions: authUnitOfWork(),
    });

    await revokeAdminSession(sessions, context.session.id);
    await clearSessionCookie();
    await clearTwoFactorChallengeCookie();

    return {
      ok: true,
      data: projectRecoveryCodes({ codes: result.recoveryCodes, generatedAt: new Date() }),
    };
  } catch (error) {
    return { ok: false, envelope: toErrorEnvelope(error) };
  }
}
