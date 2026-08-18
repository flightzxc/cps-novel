import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "cps-novel",
  description: "海外小说内容分发站点",
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
