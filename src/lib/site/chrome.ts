import type { SiteChrome } from "@/features/public-ui/layout/SiteShell";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import type { SiteSettingSnapshot } from "@/server/site-settings/service";

export type PublicChromeCurrent = "home" | "browse";

export function chromeFromSiteSetting(
  settings: SiteSettingSnapshot,
  current?: PublicChromeCurrent,
): SiteChrome {
  const t = getPublicT(PUBLIC_SITE_LOCALE);
  const footerNote = [settings.footerCopyrightText, settings.footerDisclaimerText]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");

  return {
    brandHref: "/",
    navItems: [
      { label: t("nav.home"), href: "/", current: current === "home" },
      { label: t("nav.browse"), href: "/browse", current: current === "browse" },
    ],
    footerNote: footerNote || undefined,
  };
}
