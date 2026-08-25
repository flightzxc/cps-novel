"use server";

import { redirect } from "next/navigation";

import { revokeAdminSession } from "@/lib/auth/login";
import { hashAdminSessionToken } from "@/lib/auth/session";

import { guardDependencies, readSessionToken } from "../../api/admin/_lib/deps";
import { clearSessionCookie, clearTwoFactorChallengeCookie, LOGIN_PATH } from "./auth-session";

/**
 * Bound directly to a `<form action={logoutAction}>` — no client component or
 * fetch involved, so it works even without JS.
 *
 * No same-origin check here, unlike every mutating action under
 * `two-factor/*`: `ADMIN_SESSION_COOKIE_CONTRACT.sameSite` is `"strict"`, so a
 * genuine cross-site request never carries the session cookie in the first
 * place — `readSessionToken()` already reads `null` and this degrades to a
 * harmless no-op redirect. Logout is also intentionally forgiving: an
 * already-expired or already-revoked session must still "succeed" (clear the
 * cookie, land on `/login`) rather than surface an error the user can do
 * nothing about.
 *
 * Revokes by looking the session up directly (`findByTokenHash` +
 * `sessions.revoke`) instead of `requireAdminSession`, which would throw on
 * exactly the sessions logout most needs to handle gracefully — idle/absolute
 * timeout, or a session already revoked from another tab.
 */
export async function logoutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    const { sessions } = guardDependencies();
    const session = await sessions.findByTokenHash(hashAdminSessionToken(token));
    if (session) await revokeAdminSession(sessions, session.id);
  }
  await clearSessionCookie();
  await clearTwoFactorChallengeCookie();
  redirect(LOGIN_PATH);
}
