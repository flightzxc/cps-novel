"use server";

import { redirect } from "next/navigation";

import {
  projectRecoveryCodes,
  projectTwoFactorSetup,
  type ErrorEnvelope,
  type RecoveryCodesOneTimeResult,
  type TwoFactorSetupResult,
} from "@/contracts";
import { AdminAccessError } from "@/lib/auth/errors";
import { revokeAdminSession } from "@/lib/auth/login";
import { hashAdminSessionToken } from "@/lib/auth/session";
import { confirmTwoFactorSetup, startTwoFactorSetup } from "@/lib/auth/two-factor";

import { authUnitOfWork, twoFactorStore } from "../../../api/admin/_lib/auth-deps";
import { guardDependencies, readSessionToken } from "../../../api/admin/_lib/deps";
import { toErrorEnvelope } from "../../../api/admin/_lib/respond";
import {
  clearSessionCookie,
  clearTwoFactorChallengeCookie,
  LOGIN_PATH,
  requireActiveContext,
  requireSameOriginSubmission,
  safeNextPath,
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
 * `confirmTwoFactorSetup` bumps the identity's `sessionVersion` immediately —
 * the bootstrap session therefore fails `requireAdminSession` the instant this
 * returns, so no admin API stays privileged. That invalidation is the security
 * design and is not weakened here.
 *
 * Explicit `revokeAdminSession` + cookie clear + `/login` redirect used to run
 * in this action too. Clearing cookies made the follow-up RSC render of
 * `/two-factor/setup` see no session and `redirect("/login")`, which unmounted
 * the recovery-code view before the operator could save codes that are shown
 * only once (X8 R1). Revoke, cookie clear and re-login now live in
 * `finishSetupAction`, after the operator clicks "我已保存，继续".
 *
 * Recovery codes leave this function only in the typed action result. They
 * must not be written to a cookie, URL, `localStorage`, or a log line.
 */
export async function confirmSetupAction(input: { code: string }): Promise<ConfirmSetupResult> {
  try {
    await requireSameOriginSubmission();
    const context = await requireActiveContext();
    const { identities } = guardDependencies();
    const result = await confirmTwoFactorSetup({
      identityId: context.identity.id,
      code: input.code,
      identities,
      twoFactor: twoFactorStore(),
      transactions: authUnitOfWork(),
    });

    return {
      ok: true,
      data: projectRecoveryCodes({ codes: result.recoveryCodes, generatedAt: new Date() }),
    };
  } catch (error) {
    return { ok: false, envelope: toErrorEnvelope(error) };
  }
}

/**
 * Ends the bootstrap session after the operator has seen the recovery codes.
 *
 * Mirrors `logoutAction`'s forgiving lookup (`findByTokenHash` rather than
 * `requireAdminSession`) because `confirmTwoFactorSetup` already bumped
 * `sessionVersion` — the cookie is stale by design. Same-origin is still
 * required: unlike logout, this runs from a page that just displayed secrets.
 *
 * `next` is a post-login deep link only. Recovery codes are never accepted
 * as input and never placed on the redirect URL.
 */
export async function finishSetupAction(input: { next?: string | null } = {}): Promise<void> {
  await requireSameOriginSubmission();
  const token = await readSessionToken();
  if (token) {
    const { sessions } = guardDependencies();
    const session = await sessions.findByTokenHash(hashAdminSessionToken(token));
    if (session) await revokeAdminSession(sessions, session.id);
  }
  await clearSessionCookie();
  await clearTwoFactorChallengeCookie();
  const next = safeNextPath(input.next);
  redirect(next ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH);
}
