import { ADMIN_PAGE_ROOTS, type AdminRegistry } from "@/server/auth/registry";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";

import type { ContentReadCapability } from "./content-capabilities";

/**
 * The registry the running app actually resolves against.
 *
 * P1-08B's registry is frozen in `src/server/credentials/registry.ts` and stays
 * that way; P2-04 composes on top rather than editing it, so the credential
 * surface keeps a single owner and this file keeps a single reason to change.
 *
 * ## Why the content routes carry no `capability`, and what carries it instead
 *
 * `AdminRouteRegistration.capability` is an `AdminCapability`, and the guard
 * treats that field as "enforce the grant **and** demand 2FA". P2-04 reads must
 * not demand 2FA, so that field stays unset and the grant is enforced one layer
 * out, in `guardContentRead`.
 *
 * The binding itself lives here, on the registration, in the `readCapability`
 * field — one table, resolved at runtime. Routes do not name their own
 * capability: `guardContentRead` looks it up from this registry by the route the
 * kernel just matched. A handler therefore *cannot* run under the wrong grant,
 * because there is no argument to get wrong, and a content route that is not
 * registered here fails closed rather than running ungated.
 *
 * (An earlier revision passed the capability into `guardContentRead` and related
 * it to the route only through a source-scanning test. That left the runtime
 * registry not actually holding the binding — flagged in Codex review.)
 *
 * Registration is still what makes an unknown path 404: `resolveAdminRoute`
 * matches literally, so an unregistered path is refused before any session
 * lookup, exactly as for the credential routes.
 *
 * ## Why the paths are flat
 *
 * `resolveAdminRoute` compares whole pathnames — it has no dynamic-segment
 * matcher. A `/api/admin/novels/[novelId]` registration would therefore never
 * match a real request and every call would 404. Identifiers travel as query
 * parameters instead, which is also what `/api/admin/credentials/metadata`
 * already does with `channelAccountId`.
 */
type AdminContentRouteRegistration = AdminRegistry["routes"][number] & {
  /** The read grant this route runs under. Metadata is `content:view`; only the
   *  chapter body is `content:read`, so browsing the catalogue never implies the
   *  right to read licensed prose. */
  readonly readCapability: ContentReadCapability;
};

export const ADMIN_CONTENT_ROUTES = [
  {
    id: "admin.api.novel.list",
    path: "/api/admin/novels",
    methods: ["GET"],
    readCapability: "content:view",
  },
  {
    id: "admin.api.novel.detail",
    path: "/api/admin/novels/detail",
    methods: ["GET"],
    readCapability: "content:view",
  },
  {
    id: "admin.api.novel_chapter.list",
    path: "/api/admin/novels/chapters",
    methods: ["GET"],
    readCapability: "content:view",
  },
  {
    id: "admin.api.novel_chapter.content",
    path: "/api/admin/novels/chapters/content",
    methods: ["GET"],
    readCapability: "content:read",
  },
] as const satisfies readonly AdminContentRouteRegistration[];

export type AdminContentRouteId = (typeof ADMIN_CONTENT_ROUTES)[number]["id"];

/**
 * Derived from {@link ADMIN_CONTENT_ROUTES}, never maintained beside it.
 *
 * A hand-written second copy is precisely how a route ends up registered under
 * one capability and enforced under another.
 */
export const CONTENT_ROUTE_CAPABILITIES: Readonly<
  Record<AdminContentRouteId, ContentReadCapability>
> = Object.freeze(
  Object.fromEntries(
    ADMIN_CONTENT_ROUTES.map((route) => [route.id, route.readCapability]),
  ) as Record<AdminContentRouteId, ContentReadCapability>,
);

/**
 * The runtime binding lookup. Returns null for anything not registered as a
 * content route, so the caller fails closed instead of guessing a grant.
 */
export function contentReadCapabilityForRoute(routeId: string): ContentReadCapability | null {
  return ADMIN_CONTENT_ROUTES.find((route) => route.id === routeId)?.readCapability ?? null;
}

export const P2_04_ADMIN_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: ADMIN_PAGE_ROOTS,
  routes: Object.freeze([...P1_08B_ADMIN_REGISTRY.routes, ...ADMIN_CONTENT_ROUTES]),
  // P2-04 is a read slice: it registers no Server Action, and adding a mutation
  // capability here is out of scope by construction.
  actions: P1_08B_ADMIN_REGISTRY.actions,
});
