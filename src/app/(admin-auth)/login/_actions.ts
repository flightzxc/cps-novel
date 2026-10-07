"use server";

import type { ErrorEnvelope } from "@/contracts";
import { createAdminLoginHumanVerification } from "@/lib/auth/admin-login-turnstile";
import { authenticateAdminLogin } from "@/lib/auth/login";
import { createTwoFactorChallenge } from "@/lib/auth/two-factor";
import { isTwoFactorEnforced } from "@/lib/auth/two-factor-enforcement";

import { guardDependencies } from "../../api/admin/_lib/deps";
import { loginAttemptStore, twoFactorStore } from "../../api/admin/_lib/auth-deps";
import { toErrorEnvelope } from "../../api/admin/_lib/respond";
import {
  ADMIN_LANDING_PATH,
  currentHeaders,
  requestIp,
  requireSameOriginSubmission,
  safeNextPath,
  TWO_FACTOR_CHALLENGE_PATH,
  TWO_FACTOR_SETUP_PATH,
  writeSessionCookie,
  writeTwoFactorChallengeCookie,
} from "../_lib/auth-session";

export type LoginActionResult = { ok: true; next: string } | { ok: false; envelope: ErrorEnvelope };

/**
 * The one action in this whole PR that cannot go through `requireAdminSession`
 * or the registry — there is no session yet, that is the entire point.
 * `authenticateAdminLogin` (Codex, `@/lib/auth/login.ts`) owns the actual
 * decision (rate limit -> credential check -> session issue); this wires its
 * result to a cookie and picks where the browser goes next.
 *
 * Never distinguishes "unknown username" from "wrong password": both surface
 * as `authenticateAdminLogin`'s single `jwt_invalid` (401), and
 * `errorEnvelopeCopy` renders one fixed string for it — nothing username-shaped
 * ever reaches the client.
 *
 * B-39: when `ADMIN_LOGIN_TURNSTILE_ENABLED=true`, the Turnstile token from the
 * form is verified server-side inside `authenticateAdminLogin` — after the
 * lockout check, before any identity lookup / password check, and without ever
 * counting a refusal as a failed login (see `verifyHuman` there). When the
 * switch is off (the default), `createAdminLoginHumanVerification` returns
 * `undefined`, no `verifyHuman` key is passed, and this action calls
 * `authenticateAdminLogin` exactly as it did before B-39. The 2FA branches
 * below are untouched either way.
 *
 * RC-10: when `ADMIN_TWO_FACTOR_ENFORCEMENT=disabled` (local UAT only — see
 * `@/lib/auth/two-factor-enforcement.ts`), a successful login goes straight
 * to the deep link or landing page instead of detouring through
 * `/two-factor/setup` or `/two-factor/challenge` — no challenge cookie is
 * written either. When enforcement is `required` (the fail-closed default),
 * this branch never runs and the two-way `twoFactorEnabled` split below is
 * unchanged.
 */
export async function loginAction(input: {
  username: string;
  password: string;
  next?: string;
  /** Only sent by the form when Turnstile is on; untrusted client input either way. */
  turnstileToken?: string;
}): Promise<LoginActionResult> {
  try {
    await requireSameOriginSubmission();
    const { identities, sessions } = guardDependencies();
    const ip = requestIp(await currentHeaders());
    const verifyHuman = createAdminLoginHumanVerification({ token: input.turnstileToken, remoteIp: ip });
    const { token, context } = await authenticateAdminLogin({
      username: input.username,
      password: input.password,
      ip,
      identities,
      sessions,
      attempts: loginAttemptStore(),
      ...(verifyHuman ? { verifyHuman } : {}),
    });
    await writeSessionCookie(token);

    // Both destinations carry the validated deep link forward as `?next=` so
    // it survives the detour and still applies once 2FA is satisfied (see
    // `two-factor/challenge/page.tsx` and `two-factor/setup/page.tsx`).
    const next = safeNextPath(input.next);
    const query = next ? `?next=${encodeURIComponent(next)}` : "";

    if (!isTwoFactorEnforced()) {
      return { ok: true, next: next ?? ADMIN_LANDING_PATH };
    }

    if (!context.identity.twoFactorEnabled) {
      return { ok: true, next: `${TWO_FACTOR_SETUP_PATH}${query}` };
    }

    const challenge = await createTwoFactorChallenge({ context, twoFactor: twoFactorStore() });
    await writeTwoFactorChallengeCookie(challenge.token);
    return { ok: true, next: `${TWO_FACTOR_CHALLENGE_PATH}${query}` };
  } catch (error) {
    return { ok: false, envelope: toErrorEnvelope(error) };
  }
}
