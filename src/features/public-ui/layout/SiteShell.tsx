import type { ReactNode } from "react";
import type { NavItem } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT, loadMessages } from "@/lib/locale/messages";
import { MessagesProvider } from "@/lib/locale/messages/MessagesProvider";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
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
  headerOverlay = false,
  locale = PUBLIC_SITE_LOCALE,
}: {
  children: ReactNode;
  chrome?: SiteChrome;
  /**
   * 页头浮在主视觉之上（首页有 Hero 时）。页头脱离文档流，主内容顶到视口顶端，
   * Hero 因此能从视口最上沿开始出血。滚出 Hero 后页头自动恢复底色与分隔线。
   */
  headerOverlay?: boolean;
  locale?: SiteLocale;
}) {
  const messages = loadMessages(locale);
  const t = getPublicT(locale);

  return (
    <MessagesProvider locale={locale} messages={messages}>
      <div className="relative flex min-h-screen flex-col bg-novel-bg">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-novel-md focus:bg-novel-accent focus:px-4 focus:py-2 focus:text-sm focus:text-novel-on-accent"
        >
          {t("nav.skipToContent")}
        </a>

        <SiteHeader
          brandHref={chrome.brandHref}
          navItems={chrome.navItems}
          localeNav={chrome.localeNav}
          overlay={headerOverlay}
        />

        <main id="main" className="flex-1">
          {children}
        </main>

        <SiteFooter
          links={chrome.footerLinks}
          brandHref={chrome.brandHref}
          note={chrome.footerNote}
          navAriaLabel={t("nav.footerNav")}
        />
      </div>
    </MessagesProvider>
  );
}
