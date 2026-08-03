import type { AdminCapability } from "@/lib/auth/capabilities";

export const ADMIN_API_NAMESPACE = "/api/admin";

export const ADMIN_PAGE_ROOTS = Object.freeze([
  "/dashboard",
  "/novels",
  "/catalog-sync",
  "/promo-links",
  "/previews",
  "/home-carousel",
  "/templates",
  "/articles",
  "/categories",
  "/tags",
  "/tasks",
  "/revenue",
  "/settings",
  "/channel-accounts",
] as const);

export type AdminRouteRegistration = {
  id: string;
  path: `${typeof ADMIN_API_NAMESPACE}/${string}`;
  methods: readonly string[];
  capability?: AdminCapability;
};

export type AdminActionRegistration = {
  id: `admin.${string}`;
  capability?: AdminCapability;
  mutation: boolean;
};

export type AdminRegistry = {
  pageRoots: readonly string[];
  routes: readonly AdminRouteRegistration[];
  actions: readonly AdminActionRegistration[];
};

export const DEFAULT_ADMIN_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: ADMIN_PAGE_ROOTS,
  routes: Object.freeze([]),
  actions: Object.freeze([]),
});

function normalizePath(pathname: string): string | null {
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("%2f") || pathname.includes("%5c")) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(pathname).replace(/\/{2,}/g, "/");
    if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;
    return decoded.length > 1 ? decoded.replace(/\/$/, "") : decoded;
  } catch {
    return null;
  }
}

function segmentMatch(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function resolveAdminPage(pathname: string, registry = DEFAULT_ADMIN_REGISTRY): string | null {
  const normalized = normalizePath(pathname.toLowerCase());
  if (!normalized) return null;
  return registry.pageRoots.find((root) => segmentMatch(normalized, root)) ?? null;
}

export function resolveAdminRoute(
  pathname: string,
  method: string,
  registry = DEFAULT_ADMIN_REGISTRY,
): AdminRouteRegistration | null {
  const normalized = normalizePath(pathname.toLowerCase());
  if (!normalized || !segmentMatch(normalized, ADMIN_API_NAMESPACE)) return null;
  return (
    registry.routes.find(
      (route) => route.path.toLowerCase() === normalized && route.methods.includes(method.toUpperCase()),
    ) ?? null
  );
}

export function resolveAdminAction(
  actionId: string,
  registry = DEFAULT_ADMIN_REGISTRY,
): AdminActionRegistration | null {
  return registry.actions.find((action) => action.id === actionId) ?? null;
}
