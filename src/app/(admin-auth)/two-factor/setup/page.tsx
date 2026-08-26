import { redirect } from "next/navigation";

import { ADMIN_LANDING_PATH, LOGIN_PATH, hasSessionCookie, readActiveContext, safeNextPath } from "../../_lib/auth-session";
import { SetupFlow } from "./_components/setup-flow";

export const dynamic = "force-dynamic";

type SearchParams = { next?: string };

/**
 * Forced enrollment screen: any session whose identity has not enabled 2FA
 * lands here — from the login action directly (`login/_actions.ts`) and,
 * defensively, from every `(admin)` page too
 * (`(admin)/_lib/page-guard.ts:requireAdminPage`), so a bookmarked deep link
 * cannot skip enrollment.
 *
 * After a successful confirm the bootstrap session is version-stale, so
 * `readActiveContext()` returns null. Redirecting to `/login` in that case is
 * what skipped the one-time recovery-code view (X8 R1). A leftover session
 * cookie means this tab was mid-flow: keep rendering `SetupFlow` so React can
 * preserve the `done` step. A truly anonymous visit has no cookie and still
 * goes to `/login`.
 */
export default async function TwoFactorSetupPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { next } = await searchParams;
  const context = await readActiveContext();
  if (!context) {
    if (!(await hasSessionCookie())) redirect(LOGIN_PATH);
    return <SetupFlow next={safeNextPath(next)} />;
  }
  // Already enrolled: nothing to force. This is reachable if a stale tab
  // still has this page open after a different tab finished setup.
  if (context.identity.twoFactorEnabled) redirect(safeNextPath(next) ?? ADMIN_LANDING_PATH);

  return <SetupFlow next={safeNextPath(next)} />;
}
