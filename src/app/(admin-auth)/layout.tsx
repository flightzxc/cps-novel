import type { ReactNode } from "react";
import { AdminDocumentLang } from "@/features/admin-ui/admin-document-lang";

export const metadata = {
  title: "海外阅读后台",
  // Root layout (`src/app/layout.tsx`) already defaults to noindex,follow:
  // false for the whole site; this restates it explicitly, same as
  // `(admin)/layout.tsx`, so the login/2FA surface never depends on the
  // parent not changing its default later.
  robots: { index: false, follow: false },
};

/**
 * Auth bootstrapping shell (login, 2FA challenge, 2FA setup).
 *
 * Same light palette as `(admin)/layout.tsx` — this is the backend, and
 * P1_ADMIN_PARITY_SPEC §0 keeps the backend light while the public site
 * (`.site` on `<body>`) stays dark. Centers a single card rather than
 * composing `<AdminShell>`: there is no sidebar, no capability snapshot and
 * no session to show until one of these flows produces one.
 */
export default function AdminAuthLayout({ children }: { children: ReactNode }) {
  return (
    <div lang="zh-CN" className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10 text-gray-900">
      <AdminDocumentLang />
      {children}
    </div>
  );
}
