"use server";

import type { ErrorEnvelope } from "@/contracts";
import { authenticateAdminLogin } from "@/lib/auth/login";
import { createTwoFactorChallenge } from "@/lib/auth/two-factor";

import { guardDependencies } from "../../api/admin/_lib/deps";
import { loginAttemptStore, twoFactorStore } from "../../api/admin/_lib/auth-deps";
import { toErrorEnvelope } from "../../api/admin/_lib/respond";
import {
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
 */
export async function loginAction(input: {
  username: string;
  password: string;
  next?: string;
}): Promise<LoginActionResult> {
  try {
    await requireSameOriginSubmission();
    const { identities, sessions } = guardDependencies();
    const { token, context } = await authenticateAdminLogin({
      username: input.username,
      password: input.password,
      ip: requestIp(await currentHeaders()),
      identities,
      sessions,
      attempts: loginAttemptStore(),
    });
    await writeSessionCookie(token);

    // Both destinations carry the validated deep link forward as `?next=` so
    // it survives the detour and still applies once 2FA is satisfied (see
    // `two-factor/challenge/page.tsx` and `two-factor/setup/page.tsx`).
    const next = safeNextPath(input.next);
    const query = next ? `?next=${encodeURIComponent(next)}` : "";

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
