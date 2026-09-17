import type { JSX } from "react";

import Link from "next/link";

export type TagNavTabKey = "labels" | "canonical" | "mappings";

/**
 * Shared tab bar for the three `/tags/**` screens (P2-06.5).
 *
 * A Server Component on purpose: it takes `current` as a prop instead of
 * calling `usePathname`, so a page that renders it stays a Server Component
 * too and keeps reading its list through the same server-side service call
 * every other `/tags` screen uses (see `tags/page.tsx`'s doc comment for why
 * that matters — a client-side refetch here would let this bar and its page
 * disagree about what a hand-edited URL should show).
 *
 * Three tabs, in a fixed order that mirrors the file layout: the read-only
 * source-label dictionary this replaces nothing of, the Canonical Tag
 * dictionary (P2-06.5 package 1), and the source-label mapping table
 * (P2-06.5 package 2). Active styling is `bg-blue-50 text-blue-700` — same
 * blue CPS-parity accent `AdminShell`'s sidebar already uses for the active
 * nav item — idle is `text-gray-600 hover:bg-gray-100`.
 */
const TABS: readonly { readonly key: TagNavTabKey; readonly href: string; readonly label: string }[] =
  Object.freeze([
    { key: "labels", href: "/tags", label: "来源标签字典" },
    { key: "canonical", href: "/tags/canonical", label: "Canonical Tag" },
    { key: "mappings", href: "/tags/mappings", label: "来源映射" },
  ]);

export function TagNavTabs({ current }: { current: TagNavTabKey }): JSX.Element {
  return (
    <nav
      aria-label="标签管理子导航"
      className="flex flex-wrap gap-1 rounded-xl border border-gray-200 bg-white p-1 shadow-sm"
    >
      {TABS.map((tab) => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              active ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
