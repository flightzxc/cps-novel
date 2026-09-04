import type { AdminCapability } from "@/lib/auth/capabilities";

import type { AdminIconName } from "./icons";

/**
 * Menu tree frozen by `docs/p1/P1_ADMIN_PARITY_SPEC.md` §1.
 *
 * Order and labels mirror CPS `sidebar.tsx:39-72` deliberately: operator muscle
 * memory is an asset, so entries are not resorted for looks. Three CPS items are
 * intentionally absent — see {@link OMITTED_CPS_NAV_ITEMS}, which exists so the
 * "why it is not built" answer lives next to the menu instead of in a doc nobody
 * opens.
 */
export type AdminNavItem = {
  readonly href: string;
  readonly label: string;
  readonly icon: AdminIconName;
  /** Rendered but disabled until the capability is granted. */
  readonly capability?: AdminCapability;
  /** Registered yet inert this phase; shown greyed with a reason on hover. */
  readonly placeholder?: string;
  readonly children?: readonly AdminNavItem[];
};

export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = Object.freeze([
  { href: "/dashboard", label: "仪表盘", icon: "dashboard" },
  { href: "/novels", label: "书目管理", icon: "book" },
  { href: "/catalog-sync", label: "目录同步", icon: "sync" },
  // `capability` added in PR-C5: `GET /api/admin/promo-links` is registered
  // under `task:manage` (`ADMIN_TASK_ROUTES`), same as every `/tasks`
  // route — without this the sidebar would show the link as always usable
  // and let an operator without the grant click through to a
  // capability-denied page instead of a greyed, self-explaining entry.
  { href: "/promo-links", label: "推广链接", icon: "link", capability: "task:manage" },
  { href: "/previews", label: "试读管理", icon: "preview" },
  { href: "/home-carousel", label: "首页轮播", icon: "carousel" },
  { href: "/templates", label: "模板管理", icon: "template" },
  { href: "/articles", label: "文章管理", icon: "article" },
  { href: "/categories", label: "分类管理", icon: "category" },
  { href: "/tags", label: "标签管理", icon: "tag" },
  { href: "/tasks", label: "任务中心", icon: "task", capability: "task:manage" },
  {
    href: "/revenue",
    label: "数据看板",
    icon: "revenue",
    capability: "revenue:view",
    placeholder: "子项待 P4",
  },
  {
    href: "/settings",
    label: "站点设置",
    icon: "settings",
    capability: "settings:manage",
    children: [
      { href: "/settings/api-config", label: "API 配置", icon: "settings" },
      { href: "/settings/security", label: "账号安全", icon: "shield" },
    ],
  },
  {
    href: "/channel-accounts",
    label: "渠道账户",
    icon: "key",
    capability: "credential:manage",
  },
]);

/**
 * CPS menu entries deliberately not built, with the reason. Acceptance criterion
 * ① of P1-09 requires the "why not" to be auditable, not just the omission.
 */
export const OMITTED_CPS_NAV_ITEMS: readonly { readonly cps: string; readonly reason: string }[] =
  Object.freeze([
    { cps: "批量导入", reason: "表格通道已废弃" },
    { cps: "分类规则", reason: "Post-V1" },
    { cps: "畅读链接", reason: "并入推广链接" },
  ]);

/**
 * Pages that actually exist. Everything else in the menu is a registered shell
 * route and renders greyed, so the sidebar never links to a 404.
 *
 * `/novels` joined the list in P2-04 (read-only content management).
 * `/tags` joined in P2-06 (read-only source-label dictionary).
 * `/catalog-sync` joined in P0-S13 (the `NovelSourceItem` → `Novel`/`Article`
 * content-creation trigger — dry-run preview and apply, gated separately).
 * `/tasks` and `/promo-links` joined in PR-C5: the read side for X9's
 * task-admin API (task list/detail/items, the manual-review queue, and the
 * retry-failed / resolve-manual-review mutations) plus the promo-link
 * status screen. Both still gate on `task:manage` at the route level
 * (`ADMIN_TASK_ROUTES`, `src/app/api/admin/_lib/registry.ts`) regardless of
 * this list.
 * `/settings` joined in PR-C4 (OG fallback image + IndexNow delivery config
 * admin surface). Note this list is not what keeps `/settings` clickable in
 * the sidebar today — `itemState` in `./sidebar.tsx` already special-cases
 * any entry with `children` as "built" regardless of this array, and the
 * `/settings` entry has two (still-unbuilt) children. It is kept accurate
 * here anyway because it is this module's registry of "pages that actually
 * exist" and because a future change to that special case must not silently
 * relabel `/settings` as unbuilt.
 */
export const ADMIN_IMPLEMENTED_PAGES: readonly string[] = Object.freeze([
  "/channel-accounts",
  "/novels",
  "/catalog-sync",
  "/templates",
  "/articles",
  "/home-carousel",
  "/tags",
  "/tasks",
  "/promo-links",
  "/settings",
]);

export function isNavItemActive(pathname: string, item: AdminNavItem): boolean {
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** A parent expands when it or any descendant is active — CPS `sidebar.tsx:89-98`. */
export function isNavGroupExpanded(pathname: string, item: AdminNavItem): boolean {
  return (
    isNavItemActive(pathname, item)
    || (item.children?.some((child) => isNavItemActive(pathname, child)) ?? false)
  );
}
