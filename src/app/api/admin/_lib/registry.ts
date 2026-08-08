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
 * ## Why the content routes carry no `capability`
 *
 * `AdminRouteRegistration.capability` is an `AdminCapability`, and the guard
 * treats that field as "enforce the grant **and** demand 2FA". P2-04 reads must
 * not demand 2FA, so the field is left unset and the grant is enforced one layer
 * out, in `guardContentRead`. To keep that from degrading into "whoever
 * remembers to check", the binding is declared here as data — see
 * {@link CONTENT_ROUTE_CAPABILITIES} — and
 * `tests/ui/admin-content-registry.test.ts` asserts three things at once:
 *
 * 1. every content `route.ts` on disk is registered (no unregistered route),
 * 2. every registered content route exists on disk (no orphan registration),
 * 3. every content route file actually calls `guardContentRead` with the
 *    capability this table binds to it.
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
export const ADMIN_CONTENT_ROUTES = [
  { id: "admin.api.novel.list", path: "/api/admin/novels", methods: ["GET"] },
  { id: "admin.api.novel.detail", path: "/api/admin/novels/detail", methods: ["GET"] },
  { id: "admin.api.novel_chapter.list", path: "/api/admin/novels/chapters", methods: ["GET"] },
  {
    id: "admin.api.novel_chapter.content",
    path: "/api/admin/novels/chapters/content",
    methods: ["GET"],
  },
] as const satisfies AdminRegistry["routes"];

export type AdminContentRouteId = (typeof ADMIN_CONTENT_ROUTES)[number]["id"];

/**
 * Route → read capability. Metadata routes take `content:view`; only the chapter
 * body takes `content:read`, so browsing the catalogue never implies the right
 * to read licensed prose.
 */
export const CONTENT_ROUTE_CAPABILITIES: Readonly<
  Record<AdminContentRouteId, ContentReadCapability>
> = Object.freeze({
  "admin.api.novel.list": "content:view",
  "admin.api.novel.detail": "content:view",
  "admin.api.novel_chapter.list": "content:view",
  "admin.api.novel_chapter.content": "content:read",
});

export const P2_04_ADMIN_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: ADMIN_PAGE_ROOTS,
  routes: Object.freeze([...P1_08B_ADMIN_REGISTRY.routes, ...ADMIN_CONTENT_ROUTES]),
  // P2-04 is a read slice: it registers no Server Action, and adding a mutation
  // capability here is out of scope by construction.
  actions: P1_08B_ADMIN_REGISTRY.actions,
});
