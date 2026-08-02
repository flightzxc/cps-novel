/**
 * MOCK_ONLY —— 开发预览用的页头 / 页脚链接。
 *
 * 🔴 正式 URL 结构尚未冻结（语种段的取舍仍是待决项），因此这里的地址**全部指向
 * 开发预览路由**，不代表任何永久路由决定。屏幕组件本身与路由无关，链接一律由
 * 调用方注入。
 */

import type { SiteChrome } from "@/features/public-ui/layout/SiteShell";

export function mockChrome(current?: string): SiteChrome {
  return {
    brandHref: "/dev-preview/home",
    navItems: [
      { label: "首页", href: "/dev-preview/home", current: current === "home" },
      { label: "题材", href: "/dev-preview/collection", current: current === "collection" },
    ],
    // 语言入口只在确实存在多个可发布语种时才传入。首发语种白名单尚未定案，
    // 这里刻意不传，验证「单语种时该入口不出现」。
    footerLinks: [
      { label: "关于本站", href: "/dev-preview/home" },
      { label: "内容与版权", href: "/dev-preview/home" },
    ],
    footerNote:
      "本站提供作品的免费试读章节；完整内容由原平台提供。",
  };
}
