import type { AdminCapability } from "@/lib/auth/capabilities";
import { ADMIN_PAGE_ROOTS, type AdminRegistry } from "@/server/auth/registry";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";
import { ADMIN_SITE_SETTING_ROUTES } from "@/server/site-settings/registry";

/**
 * The registry the running app actually resolves against.
 *
 * P1-08B's registry is frozen in `src/server/credentials/registry.ts` and stays
 * that way; P2-04 composes on top rather than editing it, so the credential
 * surface keeps a single owner and this file keeps a single reason to change.
 * X6 follows the same rule: its exact SiteSetting route remains owned by the
 * server module and is composed here into the registry used by the app.
 *
 * ## The capability binding
 *
 * Each content route carries a standard `capability`, the same field the
 * credential routes use. Nothing about these routes is special any more:
 * `requireAdminRouteAccess` resolves the path, requires a session, and calls
 * `enforceCapability`, which grants or refuses from
 * `ADMIN_CAPABILITY_CONFIG` — and skips the 2FA step-up because
 * `content:view` / `content:read` are registered there with
 * `requiresTwoFactor: false`.
 *
 * So the binding is held by the registry *and* enforced from it, by the kernel,
 * on every request. A handler cannot name its own grant, and an unregistered
 * path is refused before any session lookup.
 *
 * (Two earlier revisions got this wrong in different ways: the first passed the
 * capability into a bespoke guard and related it to the route only through a
 * source-scanning test; the second put it in a `readCapability` field the kernel
 * did not read. Both were symptoms of the read capabilities living outside
 * `AdminCapability`, which they no longer do.)
 *
 * ## Why the paths are flat
 *
 * `resolveAdminRoute` compares whole pathnames — it has no dynamic-segment
 * matcher. A `/api/admin/novels/[novelId]` registration would therefore never
 * match a real request and every call would 404. Identifiers travel as query
 * parameters instead, which is also what `/api/admin/credentials/metadata`
 * already does with `channelAccountId`.
 */
/**
 * Metadata takes `content:view`; only the chapter body takes `content:read`, so
 * browsing the catalogue never implies the right to read licensed prose.
 */
export const ADMIN_CONTENT_ROUTES = [
  {
    id: "admin.api.novel.list",
    path: "/api/admin/novels",
    methods: ["GET"],
    capability: "content:view",
  },
  {
    id: "admin.api.novel.detail",
    path: "/api/admin/novels/detail",
    methods: ["GET"],
    capability: "content:view",
  },
  {
    id: "admin.api.novel_chapter.list",
    path: "/api/admin/novels/chapters",
    methods: ["GET"],
    capability: "content:view",
  },
  {
    id: "admin.api.novel_chapter.content",
    path: "/api/admin/novels/chapters/content",
    methods: ["GET"],
    capability: "content:read",
  },
  {
    id: "admin.api.source_label.list",
    path: "/api/admin/tags",
    methods: ["GET"],
    capability: "content:view",
  },
] as const satisfies AdminRegistry["routes"];

export type AdminContentRouteId = (typeof ADMIN_CONTENT_ROUTES)[number]["id"];

/**
 * Derived from {@link ADMIN_CONTENT_ROUTES}, never maintained beside it — a
 * hand-written second copy is how a route ends up registered under one
 * capability and enforced under another.
 */
export const CONTENT_ROUTE_CAPABILITIES: Readonly<
  Record<AdminContentRouteId, AdminCapability>
> = Object.freeze(
  Object.fromEntries(ADMIN_CONTENT_ROUTES.map((route) => [route.id, route.capability])) as Record<
    AdminContentRouteId,
    AdminCapability
  >,
);

export const P2_04_ADMIN_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: ADMIN_PAGE_ROOTS,
  routes: Object.freeze([
    ...P1_08B_ADMIN_REGISTRY.routes,
    ...ADMIN_CONTENT_ROUTES,
    ...ADMIN_SITE_SETTING_ROUTES,
  ]),
  // P2-04 is a read slice: it registers no Server Action, and adding a mutation
  // capability here is out of scope by construction.
  actions: P1_08B_ADMIN_REGISTRY.actions,
});
