import { redirect } from "next/navigation";

import {
  projectAdminCapability,
  projectAdminSession,
  type AdminCapabilityView,
  type AdminSessionView,
} from "@/contracts";
import {
  ADMIN_CAPABILITY_CONFIG,
  hasAdminCapability,
  type AdminCapability,
} from "@/lib/auth/capabilities";
import { isAdminAccessError, type AdminAccessErrorCode } from "@/lib/auth/errors";
import { ADMIN_IDLE_TIMEOUT_MS } from "@/lib/auth/session";
import type { AdminAuthContext } from "@/lib/auth/types";
import { requireAdminPageAccess } from "@/server/auth/guards";
import { resolveAdminPage } from "@/server/auth/registry";

import { guardDependencies, readSessionToken } from "../../api/admin/_lib/deps";

const ALL_CAPABILITIES = Object.keys(ADMIN_CAPABILITY_CONFIG) as AdminCapability[];

/** The three codes `requireAdminSession` throws for "no usable session" —
 * as opposed to `admin_route_not_registered`, which means the path itself
 * is not a real admin page and must keep surfacing as a 404. */
const UNAUTHENTICATED_CODES: ReadonlySet<AdminAccessErrorCode> = new Set([
  "jwt_missing",
  "jwt_invalid",
  "jwt_expired",
]);

/**
 * Every admin page must call this with its own literal pathname.
 *
 * Default-deny lives in `requireAdminPageAccess`: an unregistered path throws
 * `admin_route_not_registered` (404) before any session work. Pages are AuthN
 * only — authorisation belongs to the Route Handler and is re-checked in the
 * mutation service, so a page never becomes the sole gate.
 *
 * `tests/backend/admin-ui/page-registration.test.ts` asserts that every
 * `page.tsx` under `(admin)` calls this with a path in `ADMIN_PAGE_ROOTS`, so a
 * new page cannot silently skip it.
 *
 * PR-C1 adds two UX-layer redirects on top of that unchanged security
 * boundary — neither one relaxes what `requireAdminPageAccess` already
 * enforces, both just replace what used to be an uncaught `AdminAccessError`
 * (rendered by e.g. `novels/error.tsx` as an opaque "read failed" boundary)
 * with a landing spot the operator can actually act on:
 *
 * 1. No usable session (`jwt_missing` / `jwt_invalid` / `jwt_expired`) sends
 *    the browser to `/login?next=<registered root>`, instead of throwing.
 *    `/login` itself is outside `ADMIN_PAGE_ROOTS` by design — see
 *    `(admin-auth)/_lib/auth-session.ts` — so this never loops.
 * 2. A valid session whose identity has not enabled 2FA is redirected to the
 *    forced-enrollment screen at `/two-factor/setup`. This does not gate
 *    reads that never demanded 2FA in the first place (`content:view` /
 *    `content:read` stay `requiresTwoFactor: false` in
 *    `ADMIN_CAPABILITY_CONFIG`, and `requireContentPage` still deliberately
 *    skips any step-up check) — it only guarantees an account that has never
 *    gone through 2FA setup cannot browse the backend indefinitely on a
 *    password-only session.
 */
export async function requireAdminPage(pathname: string): Promise<AdminAuthContext> {
  let context: AdminAuthContext;
  try {
    context = await requireAdminPageAccess(
      { pathname, sessionToken: await readSessionToken() },
      guardDependencies(),
    );
  } catch (error) {
    if (isAdminAccessError(error) && UNAUTHENTICATED_CODES.has(error.code)) {
      // `pathname` may be a route *pattern* (`/novels/[novelId]`), not a
      // navigable URL — `content-page-guard.ts` documents why content pages
      // pass the pattern. `resolveAdminPage` collapses either shape back to
      // its real, navigable root.
      const root = resolveAdminPage(pathname) ?? "/login";
      redirect(`/login?next=${encodeURIComponent(root)}`);
    }
    throw error;
  }
  if (!context.identity.twoFactorEnabled) {
    redirect("/two-factor/setup");
  }
  return context;
}

export function capabilityViews(context: AdminAuthContext): readonly AdminCapabilityView[] {
  return ALL_CAPABILITIES.map((capability) =>
    projectAdminCapability({
      capability,
      granted: hasAdminCapability(context, capability),
      requiresTwoFactor: ADMIN_CAPABILITY_CONFIG[capability].requiresTwoFactor,
      twoFactorCompleted: context.twoFactorCompleted,
    }),
  );
}

export function sessionView(context: AdminAuthContext): AdminSessionView {
  return projectAdminSession({
    identity: context.identity,
    session: context.session,
    twoFactorCompleted: context.twoFactorCompleted,
    idleTimeoutMs: ADMIN_IDLE_TIMEOUT_MS,
    capabilities: capabilityViews(context),
  });
}
