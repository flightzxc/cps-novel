import type { SiteChrome } from "@/features/public-ui/layout/SiteShell";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import type { SiteSettingSnapshot } from "@/server/site-settings/service";
import type { PublicTaxonomyTag } from "./public-taxonomy";

export type PublicChromeCurrent = "home" | "browse";

export function chromeFromSiteSetting(
  settings: SiteSettingSnapshot,
  current?: PublicChromeCurrent,
  categories: readonly PublicTaxonomyTag[] = [],
): SiteChrome {
  const t = getPublicT(PUBLIC_SITE_LOCALE);
  return {
    brandHref: "/",
    // 空白/未配置时不特殊处理——`BrandLockup` 自己按 trim 后是否为空决定要不要
    // 回落到占位符，这里只做直传，不重复一遍判空逻辑。
    siteName: settings.siteName,
    navItems: [
      { label: t("nav.home"), href: "/", current: current === "home" },
      { label: t("nav.browse"), href: "/browse", current: current === "browse" },
    ],
    footerLinks: categories.slice(0, 8).map((tag) => ({ label: tag.label, href: tag.href! })),
  };
}
