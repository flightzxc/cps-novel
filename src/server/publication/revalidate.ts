/**
 * Public-page cache invalidation broadcast (v0.2.0 foundation round, Stream C
 * / P2-09).
 *
 * Ported pattern from CPS `src/actions/article-actions.ts:90-231`
 * (`safeRevalidatePath` / `revalidatePublicArticlePaths` /
 * `revalidatePublicTargets`, 94 lines total, ~60% retained per
 * `P2-07-12-移植审计-2026-08-12/P2-09.md` §7B). What is kept is the *shape*:
 * a try/catch-wrapped `revalidatePath` primitive, called synchronously after
 * a write commits, fanning out to "the sitewide listings" + "this entity's
 * own pages". What is not kept is any of the concrete path construction —
 * CPS's version joins `Article` to `Category`/`Tag`/`DramaTag` to compute
 * which aggregation pages to hit; this schema has no Category/Tag tables at
 * all (aggregation is `SourceLabel`/`NovelSourceItemLabel`, and no public
 * aggregation-by-label route exists yet — see
 * `docs/p2/P2_09_INVALIDATION_MATRIX.md` §"Deliberately not covered").
 *
 * ## Isolation contract
 *
 * Every exported function here is synchronous and never throws:
 * `revalidatePath` itself is wrapped per-call in `safeRevalidatePath`, which
 * mirrors CPS's own justification verbatim — outside a request-scoped
 * revalidation context (a scheduled-publish sweep, a maintenance script, the
 * tail of a batch loop) Next.js's `revalidatePath` throws, and that must
 * never surface as a failure of the write path that triggered it.
 *
 * That said, callers in `src/server/publish-gate/service.ts` additionally
 * wrap *their* call to this module in a call-site try/catch
 * (`safeInvalidatePublicCache`) rather than trusting this file's internal
 * safety alone — the same defense-in-depth stance
 * `src/server/publication/dispatcher.ts` takes (each handler is invoked
 * inside its own try/catch there too). This is what makes
 * `tests/backend/publish-gate/invalidation-wiring.test.ts`'s "an
 * invalidation failure never blocks the write" test meaningful: it mocks
 * this module to throw and asserts the write path's return value is
 * unaffected, which would not be provable if the only safety net were
 * internal to this file.
 *
 * ## Why this compiles to a near no-op today
 *
 * Every public route in this repo is `export const dynamic = "force-dynamic"`
 * (`src/app/page.tsx`, `src/app/browse/page.tsx`,
 * `src/app/novel/[slugParam]/page.tsx`,
 * `src/app/novel/[slugParam]/chapter/[chapterNumber]/page.tsx`) — there is no
 * Full Route Cache to invalidate yet, exactly CPS's own situation
 * (`P2-09.md` §1: CPS's root layout is force-dynamic too, so its
 * `revalidatePath` calls only ever clear the client-side Router Cache in
 * production). Calling these functions today is still correct and not
 * premature: it is "the wiring that becomes load-bearing the day a future
 * performance round adds `unstable_cache`/ISR to a public route", not
 * dead code — see the matrix doc's "Current state vs. cache-enabled state"
 * section for the full explanation of why this PR does not flip `dynamic`
 * itself.
 */
import { revalidatePath, revalidateTag } from "next/cache";

import { ACTIVE_LOCALES_CACHE_TAG } from "@/lib/locale/active-locales-tag";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import {
  buildArticlePath,
  buildArticleRoutePath,
  buildBlogPath,
  type ArticlePathInput,
} from "@/lib/slug/article-path";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

function safeRevalidatePath(path: string, type?: "layout" | "page"): void {
  try {
    if (type) {
      revalidatePath(path, type);
    } else {
      revalidatePath(path);
    }
  } catch {
    // Outside a request-scoped revalidation context — see this module's
    // header, "Isolation contract". Swallow: a cache-invalidation failure
    // must never surface as a write-path failure.
  }
}

/**
 * Same isolation discipline as `safeRevalidatePath` above, for the L10N P4
 * tag-based cache. Next 16's `revalidateTag` now takes a mandatory second
 * "profile" argument (`node_modules/next/dist/server/web/spec-extension/
 * revalidate.d.ts`) — omitting it still works at runtime but logs a
 * deprecation warning recommending a second argument.
 *
 * Review fix (n1, 2026-09-10): that second argument is NOT a free-form
 * "how urgent" hint — `revalidateTag(tag, "max")` does NOT reproduce the
 * classic single-arg immediate-purge behavior, despite the deprecation
 * warning's own wording suggesting `"max"` as the generic replacement.
 * Traced through `node_modules/next/dist/server/web/spec-extension/
 * revalidate.js`'s `revalidate()`: passing a string profile looks it up in
 * `workStore.cacheLifeProfiles[profile]` and only marks the request
 * "immediately revalidated" when that profile's `expire === 0`. The `"max"`
 * profile (`node_modules/next/dist/server/config-shared.js`'s default
 * `cacheLife` registry) is `{ stale: 300, revalidate: 2_592_000, expire:
 * 31_536_000 }` — a **stale-while-revalidate** profile whose cache entries
 * stay servable for up to a year, not an immediate purge. `revalidation-
 * utils.js`'s `revalidateTags()` confirms the same thing from the consumer
 * side: it forwards `durations = { expire: cacheLife.expire }` to the cache
 * handler, and only an `expire` of exactly `0` triggers the handler's
 * immediate-expiration path (its own comment: "If profile is not found and
 * not 'max', durations will be undefined which will trigger immediate
 * expiration in the cache handler" — "max" is explicitly named as one of
 * the profiles that does NOT do that).
 *
 * The actual classic-equivalent replacement is the object form
 * `{ expire: 0 }`: `revalidate()` takes the `typeof profile === 'object'`
 * branch, uses it as the cache-life config directly, and its `expire === 0`
 * satisfies the immediate-revalidation check — the same `durations.expire
 * === 0` the cache handler treats as "already expired". This is the right
 * match for `getActiveLocales()`'s `unstable_cache` entry: a write that
 * could change the active-locales set must invalidate it immediately, not
 * let stale reads (up to `revalidate: 2_592_000`s / 30 days under `"max"`)
 * keep serving for a year.
 */
function safeRevalidateTag(tag: string): void {
  try {
    revalidateTag(tag, { expire: 0 });
  } catch {
    // See `safeRevalidatePath` above — never let a cache-invalidation
    // failure surface as a write-path failure.
  }
}

/**
 * The two sitewide surfaces that list or feature Novels:
 * `/` (home — featured grid, `src/app/page.tsx`) and `/browse` (the
 * paginated all-works listing, `src/app/browse/page.tsx`). Any write that
 * changes which Novels/Articles are publicly visible affects both,
 * regardless of which specific Article changed — the same
 * `includeHome`-style fan-out CPS's `revalidatePublicTargets` does, minus
 * its `categoryIds`/`tagIds` branches (`docs/p2/P2_09_INVALIDATION_MATRIX.md`
 * row "分类改名/Tag" explains why those have no equivalent here).
 *
 * `/browse` supports `?page=N`; `revalidatePath("/browse")` invalidates the
 * route regardless of query string (Next.js does not key the Router/Route
 * Cache by search params for a page path revalidation call).
 */
export function revalidatePublicListings(): void {
  safeRevalidatePath("/");
  safeRevalidatePath("/browse");
  // L10N P4: this is the existing publish-state-transition broadcast point
  // every visibility-changing write already funnels through (directly or
  // via `revalidatePublicArticlePaths`/`revalidatePublicArticleSet` below) —
  // reused here, not a new invalidation mechanism, to expire
  // `getActiveLocales()`'s 300s `unstable_cache` entry whenever a write
  // could have changed which locales have publicly-visible content.
  safeRevalidateTag(ACTIVE_LOCALES_CACHE_TAG);
}

export type ArticlePublicPathInput = ArticlePathInput;

/**
 * Invalidates one Article's public detail page
 * (`/novel/{slug}-p{shortId}`, via `buildArticlePath` — the sole URL-
 * construction entry point, see `src/lib/slug/article-path.ts`) plus every
 * chapter reading page beneath it, in a single call.
 *
 * The chapter subtree is invalidated with `revalidatePath(path, "layout")`
 * against the `/chapter` route segment
 * (`src/app/novel/[slugParam]/chapter/layout.tsx`) rather than a per-chapter-
 * number loop. This is not an optimization, it is the only correct option
 * available to every caller of this function today:
 * `withdrawNovel`/`takedownNovel`/`restoreNovel` (`publish-gate/service.ts`)
 * know *that* a Novel's chapters changed visibility, not *which* chapter
 * numbers exist — enumerating them would mean an extra `NovelChapter` query
 * this function has no `db` handle to run, purely to reconstruct a set of
 * paths a single `"layout"`-typed call already covers in one shot.
 */
function revalidateOneArticlePaths(input: ArticlePublicPathInput): void {
  safeRevalidatePath(buildArticlePath(input));
  safeRevalidatePath(`${buildArticleRoutePath(input)}/chapter`, "layout");
}

/** Single-article convenience wrapper: sitewide listings + this Article's own pages. */
export function revalidatePublicArticlePaths(input: ArticlePublicPathInput): void {
  revalidatePublicListings();
  revalidateOneArticlePaths(input);
}

export type BlogPublicPathInput = Readonly<{ slug: string; locale?: SiteLocale }>;

/**
 * C-29b: blog-family counterpart to `revalidatePublicArticlePaths` above,
 * wired from `publish-gate/service.ts`'s `applyPublishTransition` once a
 * blog Article's own first-publish/republish commits. Deliberately not
 * `revalidatePublicListings()` + `revalidateOneArticlePaths` — a blog
 * Article is not part of `/`/`/browse` (those list Novels only) and has no
 * chapter subtree, so the fan-out here is exactly the two blog surfaces:
 * this post's own `/blog/{slug}` detail page (`buildBlogPath`) and the
 * `/blog` list page itself.
 *
 * Review fix (n3, 2026-09-10): `locale` is now read from the caller instead
 * of always constructing `en`'s path. The blog creation surface
 * (`src/server/content-creation/blog.ts`'s `requireLocale`) has been open to
 * every `SITE_LOCALES` member since P4 §2.B — a non-`en` blog post's own
 * publish/republish used to invalidate `/blog/{slug}` (the `en` path, which
 * that post never renders at) while its real `/{locale}/blog/{slug}` page
 * kept serving a stale cache entry.
 *
 * 🔴 `locale` stays OPTIONAL here (falling back to `PUBLIC_SITE_LOCALE`)
 * purely to keep this function's sole production caller —
 * `publish-gate/service.ts:507`'s `revalidatePublicBlogPaths({ slug:
 * txResult.slug })`, inside this round's declared 禁改区 — compiling
 * unchanged. `txResult.locale` is already available right there (used two
 * lines above this call site for the sibling `novel_article` branch), so
 * closing this for real needs only `revalidatePublicBlogPaths({ slug:
 * txResult.slug, locale: txResult.locale as SiteLocale })` — a one-line,
 * out-of-scope follow-up, not an unknown. Until that lands, a non-`en` blog
 * publish still falls through to this default and under-invalidates exactly
 * as before; every other caller (and this file's own tests) can and should
 * pass `locale` explicitly.
 */
export function revalidatePublicBlogPaths(input: BlogPublicPathInput): void {
  safeRevalidatePath(buildBlogPath({ locale: input.locale ?? PUBLIC_SITE_LOCALE, slug: input.slug }));
  safeRevalidatePath("/blog");
}

/**
 * Multi-article variant for the Novel-level rights transitions
 * (`withdrawNovel`/`takedownNovel`/`restoreNovel`), which can affect more
 * than one Article's Article-level status in one write (today always 0 or 1
 * in practice — `SITE_LOCALES` has one member — but the function does not
 * assume that; see `publish-gate/service.ts`'s module header, "Why Novel and
 * Article publish together"). Calls `revalidatePublicListings()` exactly
 * once regardless of `inputs.length`, not once per article.
 */
export function revalidatePublicArticleSet(inputs: readonly ArticlePublicPathInput[]): void {
  revalidatePublicListings();
  for (const input of inputs) {
    revalidateOneArticlePaths(input);
  }
}
