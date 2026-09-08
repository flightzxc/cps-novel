import type { SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import type { SiteSettingSnapshot } from "@/server/site-settings/service";
import type { PublicTaxonomyTag } from "./public-taxonomy";

export type PublicChromeCurrent = "home" | "browse";

/**
 * WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.3): `locale` is now
 * a required second argument (inserted right after `settings`, no default —
 * P0-S14's "no default locale" rule, see `messages/index.ts`'s
 * `getPublicT` doc comment). Every call site must now pass it explicitly.
 * Link fields below (`brandHref`, nav `href`s) stay bare-path literals on
 * purpose — locale-prefixing those is WO-2's job, not this one's; only the
 * text lookup (`getPublicT`) reacts to `locale` in this pass.
 */
export function chromeFromSiteSetting(
  settings: SiteSettingSnapshot,
  locale: SiteLocale,
  current?: PublicChromeCurrent,
  categories: readonly PublicTaxonomyTag[] = [],
): SiteChrome {
  const t = getPublicT(locale);
  const footerNote = [settings.footerCopyrightText, settings.footerDisclaimerText]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
  const friendLinks = Array.isArray(settings.friendLinks)
    ? settings.friendLinks.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.name !== "string" || typeof row.url !== "string") return [];
        const label = row.name.trim();
        const href = row.url.trim();
        if (!label || !/^https:\/\//i.test(href)) return [];
        return [{ label, href, external: true, nofollow: row.nofollow !== false }];
      })
    : [];

  return {
    brandHref: "/",
    // 空白/未配置时不特殊处理——`BrandLockup` 自己按 trim 后是否为空决定要不要
    // 回落到占位符，这里只做直传，不重复一遍判空逻辑。
    siteName: settings.siteName,
    navItems: [
      { label: t("nav.home"), href: "/", current: current === "home" },
      { label: t("nav.browse"), href: "/browse", current: current === "browse" },
    ],
    footerLinks: [
      ...categories.slice(0, 8).map((tag) => ({ label: tag.label, href: tag.href! })),
      ...friendLinks,
    ],
    footerNote: footerNote || undefined,
  };
}
