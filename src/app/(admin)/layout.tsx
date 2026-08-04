import type { ReactNode } from "react";

export const metadata = {
  title: "海外阅读后台",
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
  return <div className="min-h-screen bg-gray-50 text-gray-900">{children}</div>;
}
