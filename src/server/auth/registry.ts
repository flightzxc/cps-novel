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

/**
 * True when `pathname` survives the exact normalisation `resolveAdminPage`
 * applies (lower-case, then `normalizePath`). False means "cannot be
 * classified": a backslash, an encoded slash/backslash (`%2f`, `%5c`, any
 * case), a `.`/`..` segment, a malformed percent sequence, or no leading `/`.
 *
 * `resolveAdminPage` answers `null` both for "normalised fine, matches no
 * admin root" (a public path) and for "could not be normalised at all" (an
 * unknown). Callers that must not mistake the second for the first — the
 * proxy's admin-host split, see `isAdminPath` in `src/lib/site/admin-origin.ts`
 * — use this to tell them apart. It adds no new rule: it reuses the same
 * `normalizePath` call, so the two can never disagree about what is
 * normalisable, and `resolveAdminPage`/`resolveAdminRoute` keep their
 * behaviour exactly (they still return `null` for such paths).
 */
export function isNormalizableAdminPath(pathname: string): boolean {
  return normalizePath(pathname.toLowerCase()) !== null;
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
