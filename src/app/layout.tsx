import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "cps-novel",
  description: "海外小说内容分发站点",
  // 🔴 P1-10 全部页面都是 MOCK_ONLY 的开发预览，整体不可索引，也不进 sitemap。
  // 真实的 per-page SEO 元数据与 self-canonical 属于内容阶段，本轮不预设。
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
