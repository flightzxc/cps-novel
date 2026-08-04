import type { ReactNode } from "react";

import type { AdminSessionView } from "@/contracts";
import { AdminSidebar } from "@/features/admin-ui/sidebar";

const BUILD_VERSION = process.env.NEXT_PUBLIC_BUILD_VERSION?.trim() || "v0.1.0-dev";

/**
 * Sidebar + header + content. Takes the already-projected session so the shell
 * never touches an `AdminAuthContext`; only browser-safe fields reach the tree.
 */
export function AdminShell({
  session,
  title,
  description,
  actions,
  children,
}: {
  session: AdminSessionView;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <AdminSidebar capabilities={session.capabilities} version={BUILD_VERSION} />
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between gap-4 border-b border-gray-200 bg-white px-6 py-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-gray-900">{title}</h1>
            {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {actions}
            <span className="text-xs text-gray-500">
              {session.username}
              <span className="ml-1 text-gray-400">({session.role})</span>
            </span>
          </div>
        </header>
        <main className="px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
