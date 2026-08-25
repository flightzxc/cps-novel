import type { AdminCapability } from "@/lib/auth/capabilities";
import { ADMIN_PAGE_ROOTS, type AdminRegistry } from "@/server/auth/registry";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";

/**
 * The registry the running app actually resolves against.
 *
 * P1-08B's registry is frozen in `src/server/credentials/registry.ts` and stays
 * that way; P2-04 composes on top rather than editing it, so the credential
 * surface keeps a single owner and this file keeps a single reason to change.
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

/**
 * P0-S13 content-creation actions.
 *
 * `createContentFromSourceItem` (`@/server/content-creation`) carries no
 * authorization of its own — its module header says so explicitly ("No admin
 * UI, no Server Action wrapper. Nothing under `src/app/**` calls this yet").
 * These two registrations are that missing binding, composed here the same
 * way {@link ADMIN_CONTENT_ROUTES} composes on top of P1-08B rather than
 * editing it.
 *
 * `dry_run` is a read: `content:view`, the same bar `/catalog-sync` and
 * `/novels` already require to render, `mutation: false` so it skips
 * same-origin/rate-limit/request-id enforcement exactly like every other read.
 * `apply` is the real write and takes `content:publish` — the only existing
 * content-mutation capability (2FA + `super_admin` default). There is no
 * dedicated `content:create` in `AdminCapability`
 * (`src/lib/auth/capabilities.ts`) and adding one is outside this file's
 * write territory; reusing `content:publish` is a deliberate, documented
 * choice, not an oversight — see the P0-S13 delivery notes for the tradeoff.
 */
export const ADMIN_CONTENT_CREATION_ACTIONS = [
  { id: "admin.content_creation.dry_run", capability: "content:view", mutation: false },
  { id: "admin.content_creation.apply", capability: "content:publish", mutation: true },
] as const satisfies AdminRegistry["actions"];

/**
 * PR-C2 catalog-scan trigger.
 *
 * `createMoboreaderCatalogScanTask` (`@/lib/tasks/moboreader`) has had zero
 * production callers since it was written — the audit that opened this task
 * found no `src/app/**` reference to it at all, leaving operators with no way
 * to make the cold-start catalog pipeline's step 4 (discover upstream
 * catalog pages) actually run. These two registrations are that missing
 * binding, composed the same way {@link ADMIN_CONTENT_CREATION_ACTIONS}
 * composes on top of P1-08B.
 *
 * Both modes end up writing a `CatalogScanTask` row (plus an
 * `OperationAudit` row) — unlike P0-S13's content-creation `dry_run`, which
 * performs zero writes by construction, `createMoboreaderCatalogScanTask`
 * always inserts, in *every* mode. `mode` there is a worker-side execution
 * instruction (does the worker persist upstream `NovelSourceItem` rows or
 * not), not a Web-side "compute a plan, write nothing" preview. So both
 * actions below are registered `mutation: true` — even `dry_run` gets
 * same-origin + rate-limit + request-id enforcement, which P0-S13's true
 * dry run (`mutation: false`) deliberately skips.
 *
 * The capability split still mirrors P0-S13's convention: `dry_run` takes
 * `content:view` (already required to reach `/catalog-sync` at all), `apply`
 * takes `content:publish` (2FA + `super_admin` default) and, in the action
 * body, additionally goes through `requireFreshAdminServiceMutation` — apply
 * is the mode that, once `NOVEL_CATALOG_SYNC_ALLOW_WRITE` is also on, lets
 * the worker actually persist upstream data instead of leaving the created
 * task `disabled`.
 */
export const ADMIN_CATALOG_SCAN_ACTIONS = [
  { id: "admin.catalog_scan.dry_run", capability: "content:view", mutation: true },
  { id: "admin.catalog_scan.apply", capability: "content:publish", mutation: true },
] as const satisfies AdminRegistry["actions"];

export const P2_04_ADMIN_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: ADMIN_PAGE_ROOTS,
  routes: Object.freeze([...P1_08B_ADMIN_REGISTRY.routes, ...ADMIN_CONTENT_ROUTES]),
  // P2-04 itself registered no Server Action (a read slice, by construction).
  // P0-S13 added the first two mutation Actions on top of P1-08B's six;
  // PR-C2 adds two more for the catalog-scan trigger.
  actions: Object.freeze([
    ...P1_08B_ADMIN_REGISTRY.actions,
    ...ADMIN_CONTENT_CREATION_ACTIONS,
    ...ADMIN_CATALOG_SCAN_ACTIONS,
  ]),
});
