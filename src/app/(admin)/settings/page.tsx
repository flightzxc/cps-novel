import { getAdminSiteSetting, type AdminSiteSettingView } from "@/server/site-settings";
import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { getSiteUrl } from "@/lib/seo/site-url";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, requireAdminPage, sessionView } from "../_lib/page-guard";
import { SiteSettingsClient } from "./_components/site-settings-client";

export const dynamic = "force-dynamic";

/**
 * IndexNow operator guidance (acceptance ⑤): `indexNowHost` must equal the
 * deployment's `SITE_URL` host and `indexNowKeyLocation` must resolve to this
 * deployment's `/indexnow-key.txt`, exactly as `validateMergedValues` in
 * `@/server/site-settings/service.ts` enforces server-side. Computed here,
 * not duplicated client-side, so the hint can never drift from the rule that
 * actually rejects the write. `SITE_URL` may be unset in a local/dev
 * environment — that is not this page's failure, so the hint degrades to
 * `null` rather than throwing and taking the whole settings screen down.
 */
function resolveIndexNowGuidance(): { host: string | null; keyLocation: string | null } {
  try {
    const origin = getSiteUrl();
    return { host: new URL(origin).host, keyLocation: new URL("/indexnow-key.txt", origin).href };
  } catch {
    return { host: null, keyLocation: null };
  }
}

/**
 * Reads through `getAdminSiteSetting` directly rather than calling this
 * page's own `/api/admin/site-settings` GET route — same rationale as
 * `novels/page.tsx`: a server component fetching its own origin would add a
 * round trip and a second cookie hop for no gain. The Route Handler exists
 * for the browser (see `SiteSettingsClient`'s PATCH and its post-conflict
 * refetch); both entry points share the same `getAdminSiteSetting` /
 * `AdminSiteSettingView` projection, so neither can drift into showing a
 * different set of fields.
 *
 * Unlike `/channel-accounts`, the read here is capability-gated: the
 * `admin.api.site_settings` route registration requires `settings:manage`
 * for GET, not only PATCH (`ADMIN_SITE_SETTING_ROUTES` in
 * `@/server/site-settings/registry`). Bypassing that by unconditionally
 * calling `getAdminSiteSetting` would leak `indexNowKey` etc. to any
 * authenticated admin regardless of capability, so the read only runs when
 * `settings:manage` resolves to `granted` — mirroring
 * `requireContentPage`'s "page decides whether to fetch, service still
 * enforces it" split.
 */
export default async function SettingsPage() {
  const context = await requireAdminPage("/settings");
  const capabilities = capabilityViews(context);
  const settingsManage = findCapabilityState(capabilities, "settings:manage");

  const setting: AdminSiteSettingView | null =
    settingsManage === "granted" ? await getAdminSiteSetting(prisma) : null;
  const indexNowGuidance = resolveIndexNowGuidance();

  return (
    <AdminShell
      session={sessionView(context)}
      title="站点设置"
      description="维护 OG 兜底图与 IndexNow 推送前置配置。每次改动都要求填写原因，并写入操作审计。"
    >
      <SiteSettingsClient
        setting={setting}
        settingsManage={settingsManage}
        expectedIndexNowHost={indexNowGuidance.host}
        expectedIndexNowKeyLocation={indexNowGuidance.keyLocation}
      />
    </AdminShell>
  );
}
