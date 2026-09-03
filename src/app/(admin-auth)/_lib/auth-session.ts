import { cookies, headers } from "next/headers";

import { requireAdminSession } from "@/lib/auth/session";
import type { AdminAuthContext } from "@/lib/auth/types";
import { isTwoFactorEnforced } from "@/lib/auth/two-factor-enforcement";
import {
  ADMIN_SESSION_COOKIE_CONTRACT,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_TWO_FACTOR_COOKIE_CONTRACT,
  ADMIN_TWO_FACTOR_COOKIE_NAME,
} from "@/server/auth/cookie-contract";
import { requireSameOrigin } from "@/server/auth/origin";
import { resolveAdminPage } from "@/server/auth/registry";

import { canonicalOrigin, guardDependencies, readSessionToken } from "../../api/admin/_lib/deps";

/**
 * Auth bootstrapping surface (login, 2FA challenge, 2FA setup, logout).
 *
 * Deliberately outside the `(admin)` registry gate: `requireAdminPageAccess`
 * (via `(admin)/_lib/page-guard.ts`) demands a path already listed in the
 * frozen `ADMIN_PAGE_ROOTS` (14 entries — `tests/backend/auth/
 * security-boundaries.test.ts` pins the count, `tests/ui/admin-nav-parity
 * .test.tsx` requires every `page.tsx` under `(admin)` to call that guard
 * with a registered root). `/login` and `/two-factor/*` are intentionally
 * NOT in that list — a login page cannot demand the session it exists to
 * create — so these pages live in a sibling `(admin-auth)` route group and
 * never call `requireAdminPage`. Nothing here is registry-gated; the
 * perimeter is instead: a valid, non-revoked session (checked per action via
 * `requireAdminSession`) plus a same-origin check on every mutation.
 */

export const LOGIN_PATH = "/login";
export const TWO_FACTOR_CHALLENGE_PATH = "/two-factor/challenge";
export const TWO_FACTOR_SETUP_PATH = "/two-factor/setup";

/** Landing page once a session is fully authenticated. No `/dashboard` page
 * exists yet (only `/channel-accounts`, `/novels`, `/tags` are built —
 * `ADMIN_IMPLEMENTED_PAGES` in `@/features/admin-ui/nav-items`), so this
 * points at the primary content surface instead of a route that would 404. */
export const ADMIN_LANDING_PATH = "/novels";

/**
 * First client IP from forwarded headers, for the login rate limiter.
 *
 * Small deliberate duplicate of `src/app/go/_lib/redirect-safety.ts`'s
 * `getRequestIp` rather than an import: that helper is private (`_lib`) to
 * the promo-link redirect feature, and reaching across features for four
 * lines of header parsing would be the wrong coupling.
 */
export function requestIp(requestHeaders: Headers): string {
  return (
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim()
    || requestHeaders.get("x-real-ip")?.trim()
    || requestHeaders.get("cf-connecting-ip")?.trim()
    || ""
  );
}

export async function currentHeaders(): Promise<Headers> {
  return headers();
}

/** CSRF perimeter for every mutating auth action (mirrors `requireSameOrigin`
 * as used by `requireAdminRouteAccess` / `requireAdminActionAccess`, just
 * invoked directly since these actions never go through the registry). */
export async function requireSameOriginSubmission(): Promise<void> {
  const requestHeaders = await currentHeaders();
  requireSameOrigin(requestHeaders.get("origin"), await canonicalOrigin());
}

/** Session lookup that never throws — for read-only "am I already logged
 * in" branches (e.g. redirecting a signed-in visitor away from `/login`). */
export async function readActiveContext(): Promise<AdminAuthContext | null> {
  try {
    return await requireActiveContext();
  } catch {
    return null;
  }
}

/**
 * Whether the browser still sent a session cookie, even if that session is
 * already stale (`sessionVersion` mismatch after 2FA setup, idle timeout,
 * revoked in another tab). Used by `/two-factor/setup` so a Server Action
 * refresh does not `redirect("/login")` and unmount the one-time recovery
 * codes still sitting in client state.
 *
 * Presence-only on purpose. A garbage cookie (wrong value, other env) will
 * render the idle enrollment form; `startSetupAction` still goes through
 * `requireActiveContext` and fails, and idle/started already show logout.
 * Distinguishing "version-stale real session" from "garbage cookie" would
 * need `findByTokenHash`, but U5's recovery-code preserve path is exactly
 * "cookie still here, sessionVersion already bumped" — a row lookup would
 * change that signal for a case that cannot complete enrollment anyway.
 */
export async function hasSessionCookie(): Promise<boolean> {
  return Boolean(await readSessionToken());
}

/** Session lookup that throws `AdminAccessError` (jwt_missing / jwt_invalid /
 * jwt_expired) when there is no valid session — for mutations that require
 * one (2FA challenge completion, 2FA setup, logout). */
export async function requireActiveContext(): Promise<AdminAuthContext> {
  const token = await readSessionToken();
  return requireAdminSession(token, guardDependencies());
}

export async function writeSessionCookie(token: string): Promise<void> {
  (await cookies()).set(ADMIN_SESSION_COOKIE_NAME, token, ADMIN_SESSION_COOKIE_CONTRACT);
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(ADMIN_SESSION_COOKIE_NAME, "", { ...ADMIN_SESSION_COOKIE_CONTRACT, maxAge: 0 });
}

export async function writeTwoFactorChallengeCookie(token: string): Promise<void> {
  (await cookies()).set(ADMIN_TWO_FACTOR_COOKIE_NAME, token, ADMIN_TWO_FACTOR_COOKIE_CONTRACT);
}

export async function clearTwoFactorChallengeCookie(): Promise<void> {
  (await cookies()).set(ADMIN_TWO_FACTOR_COOKIE_NAME, "", {
    ...ADMIN_TWO_FACTOR_COOKIE_CONTRACT,
    maxAge: 0,
  });
}

export async function readTwoFactorChallengeToken(): Promise<string | null> {
  return (await cookies()).get(ADMIN_TWO_FACTOR_COOKIE_NAME)?.value ?? null;
}

/**
 * Validate a `?next=` deep-link target against the same registry the page
 * guard resolves against, so a crafted `next` can never become an open
 * redirect or point somewhere unregistered. Only the query/hash-stripped
 * pathname is kept, and only if it resolves to one of the 14 frozen page
 * roots.
 */
export function safeNextPath(value: string | string[] | undefined | null): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  const pathname = raw.split(/[?#]/)[0] ?? "";
  return resolveAdminPage(pathname) ? pathname : null;
}

/**
 * Where a session should land right now, given its 2FA state.
 *
 * The same three-way branch the login action, the challenge page and the
 * setup page each need: no 2FA enrolled yet -> forced setup; enrolled but
 * this session has not completed a challenge -> challenge; otherwise the
 * deep link (if it validated) or the default landing page.
 *
 * RC-10: when `ADMIN_TWO_FACTOR_ENFORCEMENT=disabled` (local UAT only — see
 * `@/lib/auth/two-factor-enforcement.ts`), this collapses straight to the
 * third branch regardless of `identity.twoFactorEnabled` /
 * `twoFactorCompleted` — an already-authenticated visit to `/login` must not
 * force an unenrolled local-UAT operator into `/two-factor/setup`. When
 * enforcement is `required` (the fail-closed default), behaviour is
 * unchanged.
 */
export function postAuthDestination(
  context: Pick<AdminAuthContext, "identity" | "twoFactorCompleted">,
  next?: string | string[] | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isTwoFactorEnforced(env)) return safeNextPath(next) ?? ADMIN_LANDING_PATH;
  if (!context.identity.twoFactorEnabled) return TWO_FACTOR_SETUP_PATH;
  if (!context.twoFactorCompleted) return TWO_FACTOR_CHALLENGE_PATH;
  return safeNextPath(next) ?? ADMIN_LANDING_PATH;
}
