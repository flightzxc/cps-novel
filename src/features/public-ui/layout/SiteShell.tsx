import type { ReactNode } from "react";
import type { NavItem } from "@/features/public-ui/types";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

export interface SiteChrome {
  brandHref?: string;
  navItems?: NavItem[];
  localeNav?: NavItem[];
  footerLinks?: NavItem[];
  footerNote?: string;
}

/**
 * 页面壳：页头 + 主内容 + 页脚。
 *
 * 与路由无关——所有链接由调用方注入。跳过导航的锚点放在最前面，键盘与读屏用户
 * 第一个 Tab 就能直接进正文。
 */
export function SiteShell({
  children,
  chrome = {},
}: {
  children: ReactNode;
  chrome?: SiteChrome;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-novel-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-novel-md focus:bg-novel-accent focus:px-4 focus:py-2 focus:text-sm focus:text-novel-on-accent"
      >
        跳到主要内容
      </a>

      <SiteHeader
        brandHref={chrome.brandHref}
        navItems={chrome.navItems}
        localeNav={chrome.localeNav}
      />

      <main id="main" className="flex-1">
        {children}
      </main>

      <SiteFooter
        links={chrome.footerLinks}
        brandHref={chrome.brandHref}
        note={chrome.footerNote}
      />
    </div>
  );
}
