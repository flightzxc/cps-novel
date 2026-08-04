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
import { ADMIN_IDLE_TIMEOUT_MS } from "@/lib/auth/session";
import type { AdminAuthContext } from "@/lib/auth/types";
import { requireAdminPageAccess } from "@/server/auth/guards";

import { guardDependencies, readSessionToken } from "../../api/admin/_lib/deps";

const ALL_CAPABILITIES = Object.keys(ADMIN_CAPABILITY_CONFIG) as AdminCapability[];

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
 */
export async function requireAdminPage(pathname: string): Promise<AdminAuthContext> {
  return requireAdminPageAccess(
    { pathname, sessionToken: await readSessionToken() },
    guardDependencies(),
  );
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
