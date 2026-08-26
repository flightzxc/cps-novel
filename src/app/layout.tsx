import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles/globals.css";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

// 根布局不是逐语种路由（没有 [locale] 路由段），本仓库首发也只有 en 一个
// 可发布语种，因此这里是站点唯一的语种硬编码锚点——D-8 定案语种段路由结构
// 之后，这一行是需要跟着改的地方。其余调用点一律从这里或各页面自己的
// PUBLIC_SITE_LOCALE 显式往下传，不再各自默认。
const t = getPublicT(PUBLIC_SITE_LOCALE);

export const metadata: Metadata = {
  title: "cps-novel",
  description: t("meta.siteDescription"),
  // Public pages override this from generateMetadata (innermost wins).
  // `dev-preview` and `(admin)` keep noindex via their own layouts.
  robots: { index: false, follow: false },
};

/**
 * 根布局。
 *
 * .site 加在 body 上：站点作用域恒为深色，不跟随系统。
 * 阅读作用域（.reader）只包住章节正文，由章节页自己开。
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="site">{children}</body>
    </html>
  );
}
