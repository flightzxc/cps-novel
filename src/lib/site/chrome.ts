import type { SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { SiteSettingSnapshot } from "@/server/site-settings/service";

export type PublicChromeCurrent = "home" | "browse";

export function chromeFromSiteSetting(
  settings: SiteSettingSnapshot,
  current?: PublicChromeCurrent,
): SiteChrome {
  const footerNote = [settings.footerCopyrightText, settings.footerDisclaimerText]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");

  return {
    brandHref: "/",
    navItems: [
      { label: "首页", href: "/", current: current === "home" },
      { label: "全部作品", href: "/browse", current: current === "browse" },
    ],
    footerNote: footerNote || undefined,
  };
}
