import { PublicStatusPanel } from "./PublicStatusPanel";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/** Shared copy + layout for the root 404 and `/dev-preview/status/not-found`. */
export function PublicNotFoundStatus() {
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
