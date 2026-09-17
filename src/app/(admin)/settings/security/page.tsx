import { getTwoFactorSecurityState } from "@/lib/auth/two-factor";

import { recoveryCodeStore, twoFactorStore } from "../../../api/admin/_lib/auth-deps";
import { guardDependencies } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { requireAdminPage, sessionView } from "../../_lib/page-guard";
import { SecurityPanel } from "./_components/security-panel";

export const dynamic = "force-dynamic";

/**
 * CPS v8.3.6 four-state security surface. It remains reachable when local-UAT
 * enforcement is disabled, allowing voluntary setup without making setup a
 * login requirement. No disable action exists; reset remains CLI-only.
 */
export default async function SecuritySettingsPage() {
  const context = await requireAdminPage("/settings/security");
  const state = await getTwoFactorSecurityState({
    identityId: context.identity.id,
    identities: guardDependencies().identities,
    twoFactor: twoFactorStore(),
    recoveryCodes: recoveryCodeStore(),
  });
  return <AdminShell session={sessionView(context)} title="账号安全" description="管理当前账号的双重验证与一次性恢复码。"><SecurityPanel initialState={state} /></AdminShell>;
}
