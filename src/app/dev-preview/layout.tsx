import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  // 根布局已设 noindex；这里再显式声明一次，避免将来有人只改根布局就以为放开了。
  robots: { index: false, follow: false },
};

/**
 * 开发预览路由的外壳。
 *
 * 🔴 这组路由是临时的：正式 URL 结构（尤其是语种段）尚未冻结，本轮不自行决定
 * 任何永久路由。屏幕组件本身与路由无关，这里只负责喂假数据和挂标记。
 */
export default function DevPreviewLayout({ children }: { children: ReactNode }) {
  return (
    <div data-mock-only="true">
      {children}
      {/* 低干扰的角标：既让审稿人知道这是假数据，又不影响对版面的判断 */}
      <p
        className="pointer-events-none fixed bottom-3 left-3 z-50 rounded-novel-sm border border-novel-border bg-novel-bg-elevated px-2 py-1 text-[0.6875rem] tracking-wide text-novel-fg-subtle"
        data-testid="mock-only-badge"
      >
        MOCK_ONLY
      </p>
    </div>
  );
}
