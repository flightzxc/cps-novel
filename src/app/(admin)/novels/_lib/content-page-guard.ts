import { hasAdminCapability, type AdminCapability } from "@/lib/auth/capabilities";
import type { AdminAuthContext } from "@/lib/auth/types";

import { requireAdminPage } from "../../_lib/page-guard";

export type ContentPageAccess = {
  readonly context: AdminAuthContext;
  readonly granted: boolean;
};

/**
 * Page-level access for the content screens.
 *
 * `requireAdminPage` still throws for an unregistered path or an invalid
 * session — those are not this function's business. What it adds is the read
 * grant, and it *returns* the verdict instead of throwing: a denied operator
 * should land on the page and be told which capability they are missing, not get
 * an opaque 403 that reads like the feature does not exist.
 *
 * That is a UX affordance, not the security boundary. The data still comes from
 * routes and services that enforce the capability themselves, and the page
 * simply declines to fetch when `granted` is false.
 *
 * No *capability-level* 2FA check here, deliberately — this function never
 * calls `requireAdminTwoFactor` itself, and `content:view` / `content:read`
 * stay `requiresTwoFactor: false` in `ADMIN_CAPABILITY_CONFIG`, so *mutating*
 * those two capabilities never demands a completed step-up. That is a
 * different axis from `requireAdminPage`'s own *session-level* gate (PR-C1b):
 * it still redirects to `/two-factor/challenge` when the identity has 2FA
 * enabled but this session hasn't completed a challenge, before this
 * function's `hasAdminCapability` check ever runs — so a content page still
 * cannot render on a password-only session, it just isn't this function
 * that enforces it.
 *
 * `pathname` is the **route pattern**, dynamic segments and all
 * (`/novels/[novelId]`), not the resolved URL. `resolveAdminPage` only needs the
 * registered root, and declaring the pattern lets
 * `tests/ui/admin-nav-parity.test.tsx` check the literal against the directory
 * the file actually lives in — a resolved path built from request params would
 * be unverifiable, which is exactly how a page ends up guarding a route it does
 * not serve.
 */
export async function requireContentPage(
  pathname: string,
  capability: AdminCapability,
): Promise<ContentPageAccess> {
  const context = await requireAdminPage(pathname);
  return { context, granted: hasAdminCapability(context, capability) };
}
