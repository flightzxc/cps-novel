# P2-09 · Cache Invalidation Matrix (Stream C, v0.2.0)

**Status:** Shipped with this PR. **Scope:** `src/server/publication/revalidate.ts` (the broadcast
module) + wiring into every current authoritative write path in
`src/server/publish-gate/service.ts`.

**Success criterion** (`P2_07_12_一轮实施分工方案_2026-08-12.md` §三 Stream C, quoting the round's
GPT-reviewed task book verbatim): *"小说仓启用缓存时，所有 authoritative write path 都有确定失效路径"*
— when this codebase turns on a real cache (`unstable_cache`, a `revalidate` window on a page, or an
ISR segment) on any public route, every write that can change what that route renders already has a
`revalidatePath` call wired to it. This PR does not turn caching on (see §4) — it ships the
invalidation path that makes turning it on safe later.

**Source audit**: `P2-07-12-移植审计-2026-08-12/P2-09.md`. CPS's public-page invalidation logic
(`src/actions/article-actions.ts:90-231`, `safeRevalidatePath` / `revalidatePublicArticlePaths` /
`revalidatePublicTargets`, 94 lines) was ~60% ported by shape (try/catch wrapper, "sitewide listings +
this entity's own pages" fan-out, called synchronously post-write) — see
`src/server/publication/revalidate.ts`'s header for the exact retained/rewritten split.

---

## 1. The broadcast module

`src/server/publication/revalidate.ts` exports three functions, all synchronous and guaranteed
non-throwing (each individual `revalidatePath` call is try/catch-wrapped):

| Export | Does |
| --- | --- |
| `revalidatePublicListings()` | `/` (home) + `/browse` (paginated all-works listing) |
| `revalidatePublicArticlePaths(input)` | listings + one Article's detail page + its entire chapter subtree (`revalidatePath(path, "layout")` on the `/chapter` route segment — one call invalidates every chapter number under that Article, not a per-chapter loop) |
| `revalidatePublicArticleSet(inputs)` | listings once + `revalidatePublicArticlePaths`'s per-article half for each entry — used where a Novel-level write can affect more than one Article at once |

Path construction reuses the frozen builders exclusively — `buildArticlePath`/`buildArticleRoutePath`
from `src/lib/slug/article-path.ts` (Stream F, §7 of `V020_FOUNDATION_INTERFACES.md`) — no path is ever
concatenated inline. Unit coverage: `tests/backend/publication/revalidate.test.ts` (12 tests: exact
`revalidatePath` call sequences including the `"layout"` type argument, URL-encoding, and the
per-call isolation behavior).

---

## 2. Write-path inventory

Every authoritative write path that exists in this repository today, and its invalidation status.
"Authoritative" = a write that can change what a public route (`/`, `/browse`, `/novel/[slug]`,
`/novel/[slug]/chapter/[n]`) renders. Non-content admin writes (channel-account status, credential
rotation) are excluded — they touch no public path.

| # | Write path | File | Affects | Invalidation call | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `applyPublishTransition` (draft → published, the sole gated entry into `published` — see that module's header) | `src/server/publish-gate/service.ts` | `/`, `/browse`, this Article's detail page, its chapter subtree | `revalidatePublicArticlePaths` after `$transaction` commits, gated on `wrote` (skips idempotent replays) | ✅ wired this PR |
| 2 | `publishArticlesBatch` (loops #1) | same file | same as #1, per item | inherited from #1 — no separate wiring needed | ✅ covered for free |
| 3 | `publishDueScheduledArticles` (loops #1; the future cron/worker's gated primitive) | same file | same as #1, per item | inherited from #1 | ✅ covered for free |
| 4 | `withdrawNovel` (published → unpublished) | same file | `/`, `/browse`, every affected Article's detail page + chapter subtree | `revalidatePublicArticleSet` after `$transaction` commits | ✅ wired this PR |
| 5 | `takedownNovel` (any → takedown, cascades to every Article + deletes `NovelChapterContent`) | same file | same as #4 (cascades to *every* Article, published or not — see row "文章状态变更" below) | `revalidatePublicArticleSet` | ✅ wired this PR |
| 6 | `restoreNovel` (takedown → draft, never straight to published) | same file | same as #4 | `revalidatePublicArticleSet` | ✅ wired this PR |
| 7 | Admin-content metadata writes (title/summary/body edits to an already-published Article) | *does not exist yet* — `src/server/admin-content/service.ts` has exactly one write, `tx.operationAudit.create` for `action: "admin.chapter_content.read"` (an audit record *of a read*, per P2-04's `content:read` capability), and zero writes to `article`/`novel`/`novelChapter`/`novelChapterContent`/`promoLink` (`listAdminNovels`/`getAdminNovelDetail`/`listAdminNovelChapters`/`getAdminChapterDetail`/`readAdminChapterContent` are otherwise all reads) | would affect this Article's detail page (+ chapter pages if body/title flow into chapter rendering) | **N/A — not built.** When built, must call `revalidatePublicArticlePaths` after its write commits, following exactly this PR's pattern (post-commit, `safeInvalidatePublicCache`-style call-site isolation) | 🔲 forward guidance only |
| 8 | Cover image write | *does not exist yet* — `grep -rn coverUrl src --include="*.ts"` finds zero write sites | would affect this Novel's Article detail page + `/` (home featured grid uses `coverUrl`) | **N/A — not built.** Same guidance as #7 | 🔲 forward guidance only |
| 9 | Tag / SourceLabel write (`worker/handlers/moboreader.ts`'s `sourceLabel.upsert`/`novelSourceItemLabel.upsert`) | `worker/` — Codex-owned territory (`CLAUDE.md` §3.2), sync-driven not admin-triggered, pre-existing P2-05/P2-06 ingestion code, out of this Stream's write-path scope per the task book's explicit enumeration | no public aggregation-by-label route exists yet (`/browse` lists *all* published Novels, unfiltered by label) | **N/A — no public surface to invalidate yet.** If a label-scoped public route is ever added, its write path must call `revalidatePublicListings()` at minimum, `revalidatePublicArticlePaths` per affected Article if the route is Article-scoped | 🔲 forward guidance only, out of Stream C's file-ownership scope |
| 10 | `NovelChapter`/`NovelChapterContent` materialization — `tx.novelChapterContent.upsert(...)` at `src/lib/preview/changdu-materialization.ts:234`, invoked from `worker/handlers/moboreader.ts` | `src/lib/preview/` + `worker/` — Codex-owned, pre-existing P2-05 ingestion pipeline, not in this round's task book's write-path enumeration (`publish-gate` / `admin-content` / covers / tags / batch — materialization sync is none of these) | **Writes today, right now, the exact chapter body `/novel/[slugParam]/chapter/[chapterNumber]` renders publicly.** Harmless only because every public route is `force-dynamic` (§4) — there is no page-level or query-level cache yet for this write to leave stale. | **None.** No call site exists — this is the gap itself, not a deferred nice-to-have. See §5 for the exact wiring required and who owns it (Codex). | 🔴 **blocking precondition** — any PR caching the chapter route must wire this write first, or chapter bodies go silently stale |

**Batch paths**: the task book explicitly calls out "批量路径" as a category to cover. Rows #2/#3 show
why no separate batch wiring exists: both loop `applyPublishTransition` per item, and invalidation is
wired inside that single function, so every batch caller inherits it automatically — this mirrors why
`tests/backend/publish-gate/no-bypass.test.ts` can make the single-write-site claim about `status` at
all (there is exactly one gated write primitive, and everything else is a thin wrapper around it). No
batch wrapper exists yet for withdraw/takedown/restore (only single-`novelId` functions do); if one is
built, it must loop the single-`novelId` function the same way, which already carries invalidation.

---

## 3. CPS's five confirmed invalidation gaps — how this repo avoids each

`P2-07-12-移植审计-2026-08-12/P2-09.md` §4 documents three gaps CPS shipped to production (plus a
death-tag pattern flagged separately in the round's §二 禁止清单 as a fourth/fifth item not to reproduce).
Each row states the CPS defect and why the equivalent write path here does not have it.

| CPS gap | CPS mechanism of failure | Why it does not reproduce here |
| --- | --- | --- |
| **分类改名/删除不失效公开聚合页** — `category-actions.ts`/`tag-actions.ts` only `revalidatePath("/categories")` (admin list), never the public `/category/[slug]`/`/tag/[slug]` | A second, independently-written mutation surface (Category/Tag admin CRUD) that nobody remembered to wire to the public-facing revalidate helper | **Structurally absent, not merely avoided**: this schema has no `Category`/`Tag` tables at all — confirmed both by `prisma/schema.prisma` (zero `model Category`/`model Tag`) and independently by `P2-07-12-移植审计-2026-08-12/P2-08.md` line 27 ("小说仓目前完全没有 `Category`/`Tag` 模型") — aggregation is `SourceLabel`/`NovelSourceItemLabel`, and there is no admin write path for those outside the sync worker (row #9 above). There is no second content-taxonomy CRUD surface to forget. |
| **文章状态变更/删除不失效公开详情页** — `changeArticleStatus`/`changeArticlesStatus`/`deleteArticle`/`deleteArticles`/`changeArticlesStatusByFilter` all only `safeRevalidatePath("/articles")` (admin list) | *Three separate, ungated* write functions existed beside the "real" publish path, and none of them called the public-invalidation helper | `tests/backend/publish-gate/no-bypass.test.ts` statically proves there is exactly **one** write site for `Article.status`/`Novel.status` in this entire codebase (`src/server/publish-gate/`). Since invalidation is wired into that one site (rows #1/#4/#5/#6 above), there is no second status-changing function that could forget to call it — the CPS defect requires a second write path to exist, and this round's whole design goal (`P2-07.md`) is that one cannot. |
| **封面图上传不失效公开详情页/首页轮播** — `covers/upload/route.ts` only revalidates admin paths | Cover upload was a fourth, independent write surface with its own (incomplete) revalidate call | No cover write path exists yet (row #8) — nothing to wire *or* forget. Documented here as the pattern the eventual cover-write PR must follow, not deferred silently. |
| **死 tag** — `active-locales.ts` defines `tags: ["active-locales"]`, no code anywhere calls `revalidateTag("active-locales")` | A cache tag was declared for a future `revalidateTag` call that was never written | **Structurally unreachable**: this PR (and this codebase, per `P2-09.md` §6's audit — `unstable_cache`/`revalidateTag`: 0 uses) introduces zero `unstable_cache` calls and zero cache tags. Every export in `revalidate.ts` is `revalidatePath`-only. A tag that nothing calls `revalidateTag` on cannot exist if no tag is ever declared. |
| **IndexNow flag-off 同步直发双轨** (禁止清单 item, not strictly a P2-09 finding but adjacent) | Two code paths could both fire an IndexNow submission depending on a flag | Out of this Stream's scope (Stream E) — noted only for completeness; `docs/p2/P2_11_INDEXNOW_WIRING_NOTES.md` is the authority. |

---

## 4. Current state vs. a cache-enabled state (read before touching `dynamic`)

Every public route today is `export const dynamic = "force-dynamic"`:

- `src/app/page.tsx` (home)
- `src/app/browse/page.tsx` (aggregation/listing)
- `src/app/novel/[slugParam]/page.tsx` (Novel detail)
- `src/app/novel/[slugParam]/chapter/[chapterNumber]/page.tsx` (chapter reader)

This means Next.js's Full Route Cache is **not active** on any of these routes today — every request
re-runs the page's data loaders (`src/app/_lib/public-load.ts` → `src/lib/site/queries.ts` → Prisma)
against the live database. In this state, `revalidatePath` calls from this PR have exactly one
observable effect: clearing the client-side Router Cache on a soft navigation (the same ~30s-window
effect CPS's own calls have today, per `P2-09.md` §1's finding that CPS's root layout is force-dynamic
too — "移植 CPS 的 ISR 失效方案" was a category error there for the identical reason). **Data
correctness does not depend on this PR at all today** — every render already reads fresh Prisma data
regardless of whether `revalidatePublicArticlePaths` fires.

What changes the day a future performance round adds a cache — wrapping a query in `unstable_cache`, or
removing a route's `force-dynamic` export in favor of a `revalidate` window or true ISR — is that the
wiring landed in this PR **becomes the thing standing between that change and stale public pages**. Every
write path in §2's table already has a determinate invalidation call; enabling caching on a route this
PR did not have to also touch to be correct.

**This PR deliberately does not flip any route's `dynamic` declaration.** That decision belongs to a
future performance round (per the task instructions this PR was scoped under) — changing it here would
conflate "ship the invalidation plumbing" with "turn on caching," and the latter needs its own
correctness review (cache-key granularity, TTL choices, whether `unstable_cache` or route-level
`revalidate` is the right primitive per route) that is out of scope for a P2-09 infrastructure PR.

### 4.1 Failure window: invalidation is best-effort, not transactional

🔴 **This is not recorded anywhere else in this codebase (`revalidate.ts`, `service.ts`) — this
paragraph is the authoritative statement of the gap.** Every write path in §2 calls
`@/server/publication/revalidate` *after* its `$transaction` commits (§"Cache invalidation" in
`service.ts`'s module header) — that ordering is what prevents a *rolled-back* write from ever
broadcasting an invalidation. It does **not** mean invalidation and the write are one atomic unit.
Two distinct failure windows exist between "the database write is durable" and "the cache is actually
cleared":

1. **Process death between commit and the revalidate call.** `applyPublishTransition`/
   `applyNovelRightsTransition` are ordinary `async` functions, not themselves transactional — if the
   Node process crashes, is OOM-killed, or the request is aborted in the few milliseconds after
   `db.$transaction(...)` resolves but before `revalidatePublicArticlePaths`/`revalidatePublicArticleSet`
   runs, the write is permanently committed and the invalidation call **never happens at all**. There is
   no retry, no outbox, no at-least-once redelivery for this step (compare `IndexNowOutbox`, which exists
   precisely because IndexNow submission *does* need that durability — cache invalidation as implemented
   here has none of it).
2. **A swallowed failure.** `safeRevalidatePath` (`revalidate.ts`) and the call-site
   `safeInvalidatePublicCache` (`service.ts`) both catch-and-log rather than propagate, by design — see
   §2.2 of the merge review (`scratchpad/reports/C-REVIEW.md`) for why that isolation property is load-
   bearing and tested. The same design that makes "an invalidation failure never blocks the write" true
   also makes "an invalidation failure is invisible to the caller" true. If `revalidatePath` throws for a
   reason other than "outside request scope" (a Next.js internal error, a bug in a future refactor), the
   write still reports success and nothing downstream is told the cache was not cleared.

Today this is harmless — §4 already establishes every public route is `force-dynamic`, so there is no
Full Route Cache for a missed `revalidatePath` call to leave stale. **The moment that stops being true,
this window becomes a real, silent data-staleness bug with no reconciliation mechanism.** No audit log,
no dead-letter queue, and no periodic sweep exist to notice or repair a cache entry that a crashed
process or a swallowed error left un-invalidated.

### 4.2 Blocking precondition for the cache-enabling round: a bounded TTL fallback is mandatory

Because of §4.1, **event-driven invalidation (this PR's `revalidatePath` broadcast) must never be the
sole staleness control for any cache a future round adds.** Any PR that wraps a public-route query in
`unstable_cache`, or removes a route's `force-dynamic` export in favor of a `revalidate` window or true
ISR, **must pair it with a bounded TTL** (an `unstable_cache` `revalidate` option, or a route-level
`revalidate` number) short enough that the failure windows in §4.1 self-heal within an acceptable
staleness bound, independent of whether any `revalidatePath` call ever fires. Event-driven invalidation
remains valuable as the *fast path* (clears the cache within the request/response cycle instead of
waiting out the TTL), but it is not a substitute for the TTL, and a design that relies on it alone
inherits exactly the failure mode CPS's own `active-locales.ts` cache (`P2-09.md` §4, "死 tag") shows in
miniature: a cache with no working invalidation path degrading silently to "stale until someone notices."
This is a blocking precondition for that future PR, not a suggestion — the review that approves it should
reject a design that has event-driven invalidation without a TTL fallback on the same cache entry.

---

## 5. Deliberately not covered by this PR

- **Sitemap paths** (`/sitemap.xml`, `/sitemap/[fileName]`) — Stream D's territory
  (`static-sitemap-cache.ts`/`sitemap-refresh-state.ts` equivalents), an independent invalidation
  mechanism per `P2-09.md` §5. Not touched here.
- **`NovelChapter`/`NovelChapterContent` materialization** — `tx.novelChapterContent.upsert(...)` at
  `src/lib/preview/changdu-materialization.ts:234`, invoked from `worker/handlers/moboreader.ts`.
  🔴 **This is not a hypothetical future concern: this write path writes the exact chapter body that
  `/novel/[slugParam]/chapter/[chapterNumber]` renders publicly, today.** It is harmless *only* because
  every public route is still `force-dynamic` (§4) — there is no cache yet for a missed invalidation to
  leave stale. Left unwired here because it is Codex-owned territory (`CLAUDE.md` §3.2: `worker/`,
  `src/lib/preview/` is not in Claude's §3.1 grant either), pre-existing P2-05/P2-06 ingestion code, and
  not one of the write-path categories this round's task book enumerated for Stream C (`publish-gate` /
  `admin-content` / covers / tags / batch).

  **This is a blocking precondition for any future PR that adds caching to the chapter route** — page-
  level `revalidate`, `unstable_cache` around the chapter query, or true ISR — not deferred scope to
  pick up "eventually." That PR must first add a call to `revalidatePublicArticlePaths`/
  `revalidatePublicArticleSet` (`@/server/publication/revalidate`) in
  `worker/handlers/moboreader.ts`'s post-commit code, immediately after the materialization transaction
  in `changdu-materialization.ts:234` lands, following the exact post-commit / `wrote`-gated /
  call-site-isolated pattern `publish-gate/service.ts` already uses. Owner: **Codex** (the file is in
  Codex's territory; this Claude-owned Stream cannot wire it directly). Until that lands, enabling any
  cache on the chapter route will serve stale chapter bodies with no invalidation path to catch it —
  compounding the §4.1/§4.2 best-effort gap with a write path that has *no* invalidation call at all,
  not even an unreliable one.
- **Locale-scoped invalidation** — `SiteLocale` has exactly one member (`"en"`,
  `src/lib/locale/locale-canonical.ts`) today, so `buildArticlePath`'s locale prefix is always empty and
  every path this module builds matches the real (locale-prefix-free) route tree
  (`src/app/novel/[slugParam]`, not `src/app/[locale]/novel/[slugParam]`). `ArticlePublicPathInput` still
  takes `locale` as a required field so no rewrite is needed the day a second locale is registered.

---

## 6. Test coverage shipped with this PR

| File | Covers | Count |
| --- | --- | --- |
| `tests/backend/publication/revalidate.test.ts` | The broadcast module itself: exact `revalidatePath` call sequences (including the `"layout"` type argument on the chapter subtree call), URL-encoding, listings-called-once-per-set, and per-call isolation (one path throwing does not skip the rest of the broadcast) | 12 |
| `tests/backend/publish-gate/invalidation-wiring.test.ts` | Call-site wiring: `applyPublishTransition` calls `revalidatePublicArticlePaths` with the correct `{locale, slug, shortId}` on a real write, not at all on gate rejection, not a second time on an idempotent replay; `withdrawNovel`/`takedownNovel`/`restoreNovel` call `revalidatePublicArticleSet` with every affected Article's path (including a never-published sibling Article on takedown, proving the "cascades to every Article" behavior is reflected in what gets invalidated); a thrown invalidation failure in either module never blocks the write's return value or its already-committed database state | 9 |

Both suites run under the existing `tests/backend/publish-gate/fake-db.ts` in-memory Prisma double,
extended with an optional `FakeArticle.publicPageShortId` field (deterministic fallback for the ~40
pre-existing seed calls across `service.test.ts`/`rights-transitions.test.ts`/`admin-wrappers.test.ts`
that don't set one) — no pre-existing test needed to change.
