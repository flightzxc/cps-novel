import type { ReactNode } from "react";
import { AdminDocumentLang } from "@/features/admin-ui/admin-document-lang";

export const metadata = {
  // 绝对标题：根布局有 `%s | 站点名` 模板（TKD 对齐 CPS，2026-09-30），后台标题
  // 不该带公开站的品牌后缀。写成字符串会被模板套一次，见 `src/app/layout.tsx`
  // 头注释与 `tests/ui/seo/real-metadata-merge.test.ts`。
  title: { absolute: "海外阅读后台" },
  robots: { index: false, follow: false },
};

/**
 * Admin surface.
 *
 * The backend stays light while the public site is dark (P1_ADMIN_PARITY_SPEC
 * §0), so this paints its own light background rather than inheriting the
 * `--novel-*` dark body — those tokens belong to P1-10 and are not touched here.
 *
 * Deliberately thin: the sidebar needs the capability snapshot, which only
 * exists once a page has authenticated, and a layout cannot read the pathname
 * that default-deny checks against. Pages compose `<AdminShell>` themselves.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div lang="zh-CN" className="min-h-screen bg-gray-50 text-gray-900" style={{ colorScheme: "light" }}>
      <AdminDocumentLang />
      {children}
    </div>
  );
}
