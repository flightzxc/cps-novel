import type { Metadata } from "next";
import { PublicStatusPanel } from "@/features/public-ui/status/PublicStatusPanel";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Root 404. No chrome data is available here, so this is the headless shell
 * of UnavailableScreen — same type, no header or footer.
 */
export default function NotFoundPage() {
  const t = getPublicT(PUBLIC_SITE_LOCALE);

  return (
    <PublicStatusPanel
      bare
      testId="public-not-found-panel"
      title={t("notFoundPage.title")}
      body={t("notFoundPage.body")}
      homeLabel={t("unavailable.returnHome")}
    />
  );
}
