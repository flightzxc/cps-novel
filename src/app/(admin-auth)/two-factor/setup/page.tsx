import { redirect } from "next/navigation";

import { AuthCard } from "../../_components/auth-card";
import { ADMIN_LANDING_PATH, LOGIN_PATH, readActiveContext, safeNextPath } from "../../_lib/auth-session";
import { SetupFlow } from "./_components/setup-flow";

export const dynamic = "force-dynamic";

type SearchParams = { next?: string };

/**
 * Forced enrollment screen: any session whose identity has not enabled 2FA
 * lands here — from the login action directly (`login/_actions.ts`) and,
 * defensively, from every `(admin)` page too
 * (`(admin)/_lib/page-guard.ts:requireAdminPage`), so a bookmarked deep link
 * cannot skip enrollment.
 */
export default async function TwoFactorSetupPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { next } = await searchParams;
  const context = await readActiveContext();
  if (!context) redirect(LOGIN_PATH);
  // Already enrolled: nothing to force. This is reachable if a stale tab
  // still has this page open after a different tab finished setup.
  if (context.identity.twoFactorEnabled) redirect(safeNextPath(next) ?? ADMIN_LANDING_PATH);

  return (
    <AuthCard title="启用双重验证" description="首次登录需先启用双重验证（2FA），启用后才能进入后台">
      <SetupFlow next={safeNextPath(next)} />
    </AuthCard>
  );
}
