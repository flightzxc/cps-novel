import type { ContentReadCapability } from "@/contracts";
import type { AdminAuthContext } from "@/lib/auth/types";

import { hasContentReadCapability } from "../../../api/admin/_lib/content-capabilities";
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
 * No 2FA check, deliberately — reads never demand a step-up.
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
  capability: ContentReadCapability,
): Promise<ContentPageAccess> {
  const context = await requireAdminPage(pathname);
  return { context, granted: hasContentReadCapability(context, capability) };
}
