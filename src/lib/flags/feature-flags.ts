export const NOVEL_CATALOG_SYNC_FEATURE_FLAG = "FEATURE_NOVEL_CATALOG_SYNC";
export const NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG = "NOVEL_CATALOG_SYNC_ALLOW_WRITE";
export const TAGGING_MASTER_FEATURE_FLAG = "FEATURE_P2_06_5_TAGGING";
export const TAGGING_ADMIN_WRITE_FEATURE_FLAG = "FEATURE_P2_06_5_TAG_ADMIN_WRITE";
export const TAGGING_AUTO_FEATURE_FLAG = "FEATURE_NOVEL_TAG_AUTO";
export const TAGGING_AUTO_WRITE_AUTHORIZATION = "AUTO_WRITE_AUTHORIZED";
export const SITEMAP_AUTO_REFRESH_FEATURE_FLAG = "FEATURE_SITEMAP_AUTO_REFRESH";
export const SITEMAP_AUTO_REFRESH_ALLOW_WRITE_FLAG = "SITEMAP_AUTO_REFRESH_ALLOW_WRITE";

export function isNovelCatalogSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NOVEL_CATALOG_SYNC_FEATURE_FLAG] === "true";
}

export function isNovelCatalogSyncWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG] === "true";
}

export function isTaggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TAGGING_MASTER_FEATURE_FLAG] === "true";
}
export function isTagAdminWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TAGGING_ADMIN_WRITE_FEATURE_FLAG] === "true";
}
export function isAutoTaggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TAGGING_AUTO_FEATURE_FLAG] === "true";
}
export function isAutoTagWriteAuthorized(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TAGGING_AUTO_WRITE_AUTHORIZATION] === "YES";
}

// -----------------------------------------------------------------------
// P2-11 (Stream E, IndexNow). Two independent capabilities, each its own
// double-gate pair, per this file's "一 flag 一函数、双闸" discipline and the
// round's rollout convention ("enqueue 先行、worker 后开" —
// `P2-07-12-移植审计-2026-08-12/P2-11.md` §11 flag 6): enabling outbox writes
// before delivery lets operators inspect accumulated `indexnow_outbox` rows
// (URLs, eligibility) before the worker ever calls the real IndexNow API.
// registered: docs/governance/feature-flag-registry.md.
// -----------------------------------------------------------------------
export const INDEXNOW_OUTBOX_FEATURE_FLAG = "FEATURE_INDEXNOW_OUTBOX";
export const INDEXNOW_OUTBOX_ALLOW_WRITE_FLAG = "INDEXNOW_OUTBOX_ALLOW_WRITE";
export const INDEXNOW_DELIVERY_FEATURE_FLAG = "FEATURE_INDEXNOW_DELIVERY";
export const INDEXNOW_DELIVERY_ALLOW_WRITE_FLAG = "INDEXNOW_DELIVERY_ALLOW_WRITE";

/** Gates whether `enqueueIndexNow`'s dispatcher handler does anything at all. Off by default: a safe no-op, matching `dispatcher.ts`'s "zero handlers is a safe no-op" contract. */
export function isIndexNowOutboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INDEXNOW_OUTBOX_FEATURE_FLAG] === "true";
}

/** Second key: even with the feature on, `indexnow_outbox` rows are only written when this is also true. */
export function isIndexNowOutboxWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INDEXNOW_OUTBOX_ALLOW_WRITE_FLAG] === "true";
}

/** Gates whether the worker sweeps for due deliveries / creates `GenericTaskItem`s for them at all. */
export function isIndexNowDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INDEXNOW_DELIVERY_FEATURE_FLAG] === "true";
}

/** Second key: even with the feature on, the worker only calls the real IndexNow API / writes attempt or outcome data when this is also true. */
export function isIndexNowDeliveryWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INDEXNOW_DELIVERY_ALLOW_WRITE_FLAG] === "true";
}

export function isSitemapAutoRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SITEMAP_AUTO_REFRESH_FEATURE_FLAG] === "true";
}

export function isSitemapAutoRefreshWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SITEMAP_AUTO_REFRESH_ALLOW_WRITE_FLAG] === "true";
}

// -----------------------------------------------------------------------
// P0-S5 (promo link claim chain). Same "一 flag 一函数、双闸" discipline as
// every pair above. `FEATURE_PROMO_LINK_CLAIM` gates the whole task chain
// (task creation + worker handler) including the zero-upstream-call
// "already-existing promo read" path (`novel-v1-adapter-and-workflow-
// v0.2.1.md` §3.9). `PROMO_LINK_CLAIM_ALLOW_WRITE` additionally gates any
// protected business write and is necessary but never sufficient: that path
// also requires an operator-audited `ChannelCapability.status = 'enabled'`.
// registered: docs/governance/
// feature-flag-registry.md.
// -----------------------------------------------------------------------
export const PROMO_LINK_CLAIM_FEATURE_FLAG = "FEATURE_PROMO_LINK_CLAIM";
export const PROMO_LINK_CLAIM_ALLOW_WRITE_FLAG = "PROMO_LINK_CLAIM_ALLOW_WRITE";

/** Gates whether the promo-link claim task factory and worker handler do anything at all. */
export function isPromoLinkClaimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROMO_LINK_CLAIM_FEATURE_FLAG] === "true";
}

/** Second key: even with the feature on, protected writes and claimPromo only happen when this is also true. */
export function isPromoLinkClaimWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROMO_LINK_CLAIM_ALLOW_WRITE_FLAG] === "true";
}

// -----------------------------------------------------------------------
// RC-6 (`/go` redirect tracking write gate). Semantics ported from CPS
// `getTrackingWriteStatus`/`isPublicTrackingWriteDisabled`
// (`src/lib/cps-tracking.ts:42-56`, v8.3.6 `16f2e4cfca51f46af0dede899ecf6242a770bbd0`),
// collapsed to a single flag: CPS ORs two independent env vars
// (`CPS_PUBLIC_TRACKING_WRITE_DISABLED` / `CPS_TRACKING_DISABLED`) because it
// has several tracked event types; `/go` is this project's only write path,
// so one flag is enough. registered: docs/governance/feature-flag-registry.md.
//
// Deliberately inverted default from CPS. CPS ships this closed by default
// (`.env.example`/`docker-compose.yml` both default `CPS_PUBLIC_TRACKING_WRITE_DISABLED`
// to `1`) because CPS has richer attribution signals elsewhere and treats
// public tracking as opt-in. `/go` is this project's *only* attribution
// signal, so unset must mean writes stay ON here — the opposite of CPS's
// safe-closed default.
//
// Value parsing deliberately mirrors CPS's `isTruthyEnv`
// (`src/lib/cps-tracking.ts:585-587`) verbatim — trim, then
// `/^(1|true|yes|on)$/i` — instead of this file's usual exact `=== "true"`.
// That exception is on purpose, and it is about failure direction: every
// other flag in this file is an *enable* flag, where an unrecognized value
// leaves the feature off, i.e. fails safe. This one is the inverse — a
// safety valve whose unrecognized value leaves writes ON. The operator who
// reaches for it is mid-incident (abuse spike, DB write pressure) and carries
// CPS muscle memory: `on`, `yes`, `TRUE`, or a Compose `environment:` entry
// with a trailing space (Compose does not strip it). Under exact matching
// each of those is a silent no-op at exactly the moment the valve is needed.
// Accepting CPS's full truthy set removes that trap and makes the port
// faithful. Values that genuinely are not truthy ("0", "false", garbage,
// empty) still mean "not disabled": the safe default stays open, because
// `/go` is the only attribution signal and a typo must not silently kill it.
// -----------------------------------------------------------------------
export const PUBLIC_TRACKING_WRITE_DISABLED_FLAG = "PUBLIC_TRACKING_WRITE_DISABLED";

/** CPS `isTruthyEnv`'s accepted set, copied verbatim. No `g` flag: `test` must stay stateless. */
const PUBLIC_TRACKING_WRITE_DISABLED_TRUTHY = /^(1|true|yes|on)$/i;

/** Default (unset) is false — tracking writes stay ON. Only `1`/`true`/`yes`/`on` (case-insensitive, trimmed) turns them off. */
export function isPublicTrackingWriteDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return PUBLIC_TRACKING_WRITE_DISABLED_TRUTHY.test(
    env[PUBLIC_TRACKING_WRITE_DISABLED_FLAG]?.trim() ?? "",
  );
}

// -----------------------------------------------------------------------
// C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25).
// `Article.seoVisibility` (C-24 axes foundation) only affects public-site
// *reads* (list exclusion, sitemap/IndexNow collectability, detail 404 for
// `hidden`) -- there is no protected business write this flag needs to gate,
// the admin filter/column/editor controls read and write the column
// regardless of this flag's value. Per this round's "一 flag 一函数、双闸"
// discipline, a double-gate is for *protected writes*; a read-only capability
// like this one is deliberately single-gated (documented here and in
// `docs/governance/feature-flag-registry.md` so it is not mistaken for a
// missed second gate).
//
// Default `false` reproduces this project's pre-C-25 public-site behavior
// exactly: `src/server/publication/visibility.ts`'s `buildPublicArticleWhere`/
// `buildPublicListArticleWhere`/`isHiddenFromPublicView`, `src/server/
// publication/access.ts`'s `checkNovelArticlePublicAccess`, `src/lib/seo/
// sitemap.ts`'s `isVisibleCandidate`, and `src/lib/indexnow/eligibility.ts`'s
// `isNovelIndexNowEligible` all treat every Article as if `seoVisibility`
// were `"public"` while this is off -- letting operators pre-stage
// `seo_only`/`hidden` values in the admin editor before the public-facing
// behavior is switched on ("后台先行、公开后开", the same rollout convention
// this repo's IndexNow enqueue/delivery pair already uses).
//
// Consumed by BOTH the web and worker processes, not web-only: every
// function above defaults its own `env` param to `process.env`, and the
// sitemap-refresh/indexnow-delivery worker handlers
// (`worker/handlers/sitemap-refresh.ts`'s `createSitemapFamilyBuilder`,
// `worker/handlers/indexnow-delivery.ts`'s `isNovelIndexNowEligible` call)
// never pass an override -- so each reads the WORKER process's own copy of
// this var. `docker-compose.yml` must register it in both the web and
// worker service blocks (a P0 gap this round's review caught: the worker
// block was missing it, silently pinning the worker's read to "false"
// regardless of web's value). Only the scheduler is exempt -- it only
// enqueues tasks and has no public-site read path to gate.
// -----------------------------------------------------------------------
export const ARTICLE_SEO_VISIBILITY_FEATURE_FLAG = "FEATURE_ARTICLE_SEO_VISIBILITY";

/** Gates whether public-site reads (list/sitemap/IndexNow/detail) honor `Article.seoVisibility` at all. Exact `=== "true"` parsing, default off. */
export function isArticleSeoVisibilityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARTICLE_SEO_VISIBILITY_FEATURE_FLAG] === "true";
}

// -----------------------------------------------------------------------
// C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28).
// "新建博客" is a protected business write (the first write path in this
// codebase that can create an Article with `novelId: null`) — per this
// file's own "一 flag 一函数、双闸" discipline that means a *pair*, unlike
// `FEATURE_ARTICLE_SEO_VISIBILITY` above (a read-only gate, deliberately
// single). `FEATURE_ARTICLE_BLOG` off means the whole capability is
// invisible: the "新建博客" header button does not render
// (`src/app/(admin)/articles/page.tsx`), `/articles/new-blog` 404s
// (`src/app/(admin)/articles/new-blog/page.tsx`, same `notFound()` +
// `force-dynamic` kill-switch shape as `src/app/dev-preview/layout.tsx`),
// and the creation service itself
// (`src/server/content-creation/blog.ts`'s `createBlogArticle`) fail-closes
// even if called directly. `ARTICLE_BLOG_ALLOW_WRITE` is the second key:
// even with the feature flag on, the creation service performs zero writes
// unless this is also true — "功能开了也不写库".
//
// `ARTICLE_BLOG_ALLOW_WRITE` stays web-only, unchanged since C-28:
// `createBlogArticle`'s only caller is the admin Server Action
// (`src/app/(admin)/articles/_actions.ts`'s `createBlogArticleAction`), an
// interactive write triggered from the new-blog form — no worker or
// scheduler task chain ever creates a blog Article, and `isArticleBlogWriteAllowed`
// has no caller under `worker/`/`scheduler/`. Registered in
// `docker-compose.yml`'s `web` service only.
//
// `FEATURE_ARTICLE_BLOG` (the read gate above `isArticleBlogEnabled`) is
// DIFFERENT as of C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md`
// §三/C-29) — it is now ALSO consumed by the worker process, the same shape
// `FEATURE_ARTICLE_SEO_VISIBILITY` above already has: `src/lib/seo/sitemap.ts`'s
// `createSitemapFamilyBuilder` calls `isArticleBlogEnabled(env)` to decide
// whether to emit the `blogpage` sitemap family at all (`env` defaults to
// `process.env`, so `worker/handlers/sitemap-refresh.ts`'s call site reads
// the WORKER process's own copy), and `docker-compose.yml`'s `worker`
// service block must therefore carry `FEATURE_ARTICLE_BLOG` too (registered
// this round). `src/lib/indexnow/eligibility.ts`'s `isBlogIndexNowEligible`
// also checks this flag but is NOT yet called from any file under `worker/`
// — the natural call site (`worker/handlers/indexnow-delivery.ts`'s
// drift-recheck) has nothing to recheck yet, since no blog `IndexNowOutbox`
// row can be enqueued this round (`publish-gate/service.ts`'s
// `dispatchFirstPublicPublication` call still skips `novelId === null`
// Articles — see that file's own inline comment and `eligibility.ts`'s
// `isBlogIndexNowEligible` doc comment for the full explanation). So: the
// worker's `docker-compose.yml`/`scripts/lib/x8-levels.json`/
// `scripts/acceptance/x8-validate-compose.mjs` registration for
// `FEATURE_ARTICLE_BLOG` reflects the sitemap consumer only, not an
// IndexNow one yet. `ARTICLE_BLOG_ALLOW_WRITE` is unaffected by any of this
// — it is a write gate, and neither new C-29 consumer performs a write.
// See `docs/governance/feature-flag-registry.md` and
// `tests/backend/flags/article-blog-flags-passthrough.test.ts`.
// -----------------------------------------------------------------------
export const ARTICLE_BLOG_FEATURE_FLAG = "FEATURE_ARTICLE_BLOG";
export const ARTICLE_BLOG_ALLOW_WRITE_FLAG = "ARTICLE_BLOG_ALLOW_WRITE";

/** Gates whether the "新建博客" entry (header button, `/articles/new-blog` page, creation service) exists at all. Exact `=== "true"` parsing, default off. */
export function isArticleBlogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARTICLE_BLOG_FEATURE_FLAG] === "true";
}

/** Second key: even with the feature on, `createBlogArticle` performs zero writes unless this is also true. */
export function isArticleBlogWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARTICLE_BLOG_ALLOW_WRITE_FLAG] === "true";
}
