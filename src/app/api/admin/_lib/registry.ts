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
 * the session-level 2FA gate before `enforceCapability`, which grants or
 * refuses from `ADMIN_CAPABILITY_CONFIG`. `content:view` / `content:read`
 * remain `requiresTwoFactor: false` on the capability axis, but X12 requires
 * every human admin API/Action session to have completed its global step-up.
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

/**
 * X9 task operations are a separate high-risk capability surface. Read and
 * write methods are both registry-bound to `task:manage`; the guard therefore
 * requires a current session with completed 2FA before any handler executes.
 */
export const ADMIN_TASK_ROUTES = [
  { id: "admin.api.task.list", path: "/api/admin/tasks", methods: ["GET"], capability: "task:manage" },
  { id: "admin.api.task.detail", path: "/api/admin/tasks/detail", methods: ["GET"], capability: "task:manage" },
  { id: "admin.api.task.items", path: "/api/admin/tasks/items", methods: ["GET"], capability: "task:manage" },
  { id: "admin.api.task.retry_failed", path: "/api/admin/tasks/retry-failed", methods: ["POST"], capability: "task:manage" },
  { id: "admin.api.task.manual_reviews", path: "/api/admin/tasks/manual-reviews", methods: ["GET"], capability: "task:manage" },
  { id: "admin.api.task.manual_review.resolve", path: "/api/admin/tasks/manual-reviews/resolve", methods: ["POST"], capability: "task:manage" },
  { id: "admin.api.promo_link.list", path: "/api/admin/promo-links", methods: ["GET"], capability: "task:manage" },
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

/**
 * PR-C3 publish/rights-transition triggers.
 *
 * `src/server/publish-gate/service.ts`'s five admin-facing exports
 * (`publishArticleAsAdmin`, `publishArticlesBatchAsAdmin`, `withdrawNovel`,
 * `takedownNovel`, `restoreNovel`) had zero production callers before this —
 * that module's own header says so explicitly ("no admin screen calls them
 * yet"). These five registrations are that missing binding, composed the
 * same way {@link ADMIN_CONTENT_CREATION_ACTIONS} and
 * {@link ADMIN_CATALOG_SCAN_ACTIONS} compose on top of P1-08B.
 *
 * The `id` values are not this file's choice: each service function
 * hardcodes the exact `entryId` string it checks its ticket against
 * internally (see `../../(admin)/novels/_actions.ts`'s header for the full
 * explanation), so these five ids are a mechanical transcription of those
 * literals, not a naming convention picked here.
 *
 * The capability split follows `src/server/publish-gate/service.ts`'s own
 * `RIGHTS_TRANSITION_CAPABILITY` table verbatim — publish and withdraw take
 * `content:publish`; takedown and restore take the stricter
 * `content:takedown` (restore's, because "restore" in this codebase always
 * lands on `draft`, never straight back to `published` — re-publishing after
 * a takedown means going through the Hard Gate again, but *reaching* draft
 * from takedown is still gated the same as the takedown itself, per that
 * table). This is stricter than a single blanket `content:publish` would be,
 * on purpose — matching the service's own authorization split is what this
 * file's registrations are for.
 */
export const ADMIN_PUBLISH_LIFECYCLE_ACTIONS = [
  { id: "admin.article.publish", capability: "content:publish", mutation: true },
  { id: "admin.article.publish_batch", capability: "content:publish", mutation: true },
  { id: "admin.novel.withdraw", capability: "content:publish", mutation: true },
  { id: "admin.novel.takedown", capability: "content:takedown", mutation: true },
  { id: "admin.novel.restore", capability: "content:takedown", mutation: true },
] as const satisfies AdminRegistry["actions"];

/**
 * RC-1 promo-link claim trigger.
 *
 * `createPromoLinkClaimTask` (`@/lib/tasks/promo-link-claim`) had zero
 * `src/app/**` callers before this — CPS v8.3.6 parity requires an explicit-
 * selection launcher on the sync/catalog screen (`submitChangduPromoClaim`,
 * `src/app/(admin)/sync/actions.ts:724-766` in the read-only CPS reference).
 * This single registration is that missing binding, composed the same way
 * {@link ADMIN_CATALOG_SCAN_ACTIONS} and {@link ADMIN_PUBLISH_LIFECYCLE_ACTIONS}
 * compose on top of P1-08B.
 *
 * One action, not two split by mode, unlike `ADMIN_CATALOG_SCAN_ACTIONS`.
 * That split exists there because `dry_run` and `apply` ask for *different*
 * capabilities (`content:view` vs `content:publish`) — splitting by static
 * action id is what keeps the capability enforced independent of
 * client-controlled input. Here there is exactly one capability for the
 * whole claim chain, `promo:claim`, required for *both* modes (the factory
 * writes a `GenericTask` + `OperationAudit` row every time, dry_run
 * included — see `../../../(admin)/catalog-sync/_actions.ts`'s
 * `enqueuePromoLinkClaimAction` header for the full reasoning). With the
 * capability identical either way, a single action branching on `mode`
 * carries none of the risk the catalog-scan precedent avoids.
 */
export const ADMIN_PROMO_LINK_CLAIM_ACTIONS = [
  { id: "admin.promo_link_claim.enqueue", capability: "promo:claim", mutation: true },
] as const satisfies AdminRegistry["actions"];

/**
 * RC-4 explicit-selection batch content-creation trigger.
 *
 * `applyContentCreationBatch`/`dryRunContentCreationBatch`
 * (`@/server/content-creation/batch`) had zero `src/app/**` callers before
 * this — composed on top of P1-08B the same way every group above does.
 * CPS v8.3.6 parity target is `runChangduPromoteDramaBatch`
 * (`src/lib/changdu-promote-drama-batch.ts` in the read-only CPS reference);
 * see `src/app/(admin)/catalog-sync/_actions.ts`'s
 * `dryRunContentCreationBatchAction`/`applyContentCreationBatchAction`
 * header for the full reasoning.
 *
 * Two actions, split by static id exactly like {@link
 * ADMIN_CONTENT_CREATION_ACTIONS} (its single-item counterpart): `batch_dry_run`
 * takes `content:view` (zero writes, same bar `/catalog-sync` already
 * requires), `batch_apply` takes `content:publish` (2FA + `super_admin`
 * default, the real write) — the same split as the single-item pair, for
 * the same reason: `dry_run` and `apply` need *different* capabilities, so
 * splitting by static action id (not a client-supplied `mode`) is what
 * keeps the enforced capability out of client-controlled input.
 */
export const ADMIN_CONTENT_CREATION_BATCH_ACTIONS = [
  { id: "admin.content_creation.batch_dry_run", capability: "content:view", mutation: false },
  { id: "admin.content_creation.batch_apply", capability: "content:publish", mutation: true },
] as const satisfies AdminRegistry["actions"];

export const ADMIN_ARTICLE_TEMPLATE_ACTIONS = [
  { id: "admin.article_template.create", capability: "content:publish", mutation: true },
  { id: "admin.article_template.update", capability: "content:publish", mutation: true },
  { id: "admin.article_template.status", capability: "content:publish", mutation: true },
  { id: "admin.article_template.delete", capability: "content:publish", mutation: true },
] as const satisfies AdminRegistry["actions"];

export const ADMIN_ARTICLE_ACTIONS = [
  { id: "admin.article.update", capability: "content:publish", mutation: true },
  { id: "admin.article.regenerate", capability: "content:publish", mutation: true },
  { id: "admin.article.regenerate_batch", capability: "content:publish", mutation: true },
] as const satisfies AdminRegistry["actions"];

export const ADMIN_HOME_CAROUSEL_ACTIONS = [
  { id: "admin.home_carousel.config", capability: "settings:manage", mutation: true },
  { id: "admin.home_carousel.manual_upsert", capability: "settings:manage", mutation: true },
  { id: "admin.home_carousel.compute", capability: "settings:manage", mutation: true },
] as const satisfies AdminRegistry["actions"];

export const P2_04_ADMIN_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: ADMIN_PAGE_ROOTS,
  // Routes: the union of every composed group. P1-08B's credential surface,
  // P2-04's content reads, X6's SiteSetting route and X9's task-operations
  // routes each stay owned where they are declared and are only assembled here.
  routes: Object.freeze([
    ...P1_08B_ADMIN_REGISTRY.routes,
    ...ADMIN_CONTENT_ROUTES,
    ...ADMIN_SITE_SETTING_ROUTES,
    ...ADMIN_TASK_ROUTES,
  ]),
  // Actions: P2-04 itself registered no Server Action (a read slice, by
  // construction). P0-S13 added the first two mutation Actions on top of
  // P1-08B's six; PR-C2 adds two more for the catalog-scan trigger; PR-C3 adds
  // five more for the publish/rights-transition triggers; RC-1 adds one more
  // for the promo-link claim trigger; RC-4 adds two more for the batch
  // content-creation trigger. X6/X9 add no Action: their writes are
  // explicit, registry-bound HTTP routes whose services revalidate their
  // auth tickets, so the Action list is unchanged by them.
  actions: Object.freeze([
    ...P1_08B_ADMIN_REGISTRY.actions,
    ...ADMIN_CONTENT_CREATION_ACTIONS,
    ...ADMIN_CATALOG_SCAN_ACTIONS,
    ...ADMIN_PUBLISH_LIFECYCLE_ACTIONS,
    ...ADMIN_PROMO_LINK_CLAIM_ACTIONS,
    ...ADMIN_CONTENT_CREATION_BATCH_ACTIONS,
    ...ADMIN_ARTICLE_TEMPLATE_ACTIONS,
    ...ADMIN_ARTICLE_ACTIONS,
    ...ADMIN_HOME_CAROUSEL_ACTIONS,
  ]),
});
