/**
 * MOCK_ONLY —— 开发预览用的页头 / 页脚链接。
 *
 * 🔴 正式 URL 结构尚未冻结（语种段的取舍仍是待决项），因此这里的地址**全部指向
 * 开发预览路由**，不代表任何永久路由决定。屏幕组件本身与路由无关，链接一律由
 * 调用方注入。
 */

import type { SiteChrome } from "@/features/public-ui/layout/SiteShell";
import { getPublicT } from "@/lib/locale/messages";

export function mockChrome(current?: string): SiteChrome {
  const t = getPublicT();
  return {
    brandHref: "/dev-preview/home",
    navItems: [
      { label: t("nav.home"), href: "/dev-preview/home", current: current === "home" },
      { label: t("nav.genres"), href: "/dev-preview/collection", current: current === "collection" },
    ],
    // 语言入口只在确实存在多个可发布语种时才传入。首发语种白名单尚未定案，
    // 这里刻意不传，验证「单语种时该入口不出现」。
    footerLinks: [
      { label: t("nav.about"), href: "/dev-preview/home" },
      { label: t("nav.copyright"), href: "/dev-preview/home" },
    ],
    footerNote: t("nav.footerNote"),
  };
}
