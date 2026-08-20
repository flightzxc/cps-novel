/**
 * P0-S9: the built-in fallback `ArticleTemplateSource` this service renders
 * against until real `ArticleTemplate` rows exist.
 *
 * ## Why a code-literal constant instead of a DB lookup
 *
 * `ArticleTemplate` (`prisma/schema.prisma`) is in the schema but has zero
 * rows anywhere in this codebase — no seed, no admin CRUD UI, no write path
 * writes one, and nothing defines what a `templateKey` should even look like
 * yet (per-locale? per-genre? `SITE_LOCALES` is `["en"]` only today, so
 * there is exactly one meaningful "which template" answer). Building a
 * `templateKey`-driven lookup (`db.articleTemplate.findFirst({ where: ... })`
 * + fallback-on-miss) now would be plumbing with nothing on the other end —
 * untested-by-construction (`ArticleTemplate.status`/`version`/`locale`
 * selection semantics do not exist yet) and a guess at a schema the actual
 * admin-authored-template feature hasn't decided on. That capability is
 * intentionally left for the round that ships template CRUD; this module is
 * the "only support the built-in default" half of that fork.
 *
 * When that round lands, the intended shape is: `createContentFromSourceItem`
 * (or its caller) accepts an optional `templateKey`, looks up the active
 * `ArticleTemplate` row via `narrowArticleTemplateSource`
 * (`@/lib/seo/template`), and falls back to `DEFAULT_ARTICLE_TEMPLATE` below
 * on a miss — this module's export is already shaped as an
 * `ArticleTemplateSource`, so it slots into that fallback position without
 * a rewrite.
 *
 * ## Content scope
 *
 * This is deliberately minimal operator-authored copy, not SEO-tuned prose —
 * P2-02's own contract is explicit that "content" for this round means the
 * static copy a human wrote into a template, not something the engine
 * invents (`docs/p2/P2_02_TEMPLATE_ENGINE.md` §1 point 5). Every optional
 * field (`cover_url`, `total_chapter_count`, `preview_chapter_count`,
 * `promo_redirect_url`) is wrapped in its own `{if field}…{endif}` block —
 * none of them are guaranteed to have a value at S9's point in the pipeline
 * (no `PromoLink` exists yet; preview-chapter materialization is P2-05's
 * territory) — so a Novel/Article created before those land still renders a
 * non-blank `body` instead of throwing `ERR_TEMPLATE_VAR_EMPTY`.
 *
 * `promo_redirect_url` is registered `required: true` in `fields.ts` (its
 * *data source*, a `PromoLink`, is expected to always exist once the
 * pipeline is complete) — but S9 does not create one (S5's territory, see
 * `service.ts` module header, "Never touches `PromoLink`"), so wrapping it
 * in a conditional here is required, not optional-field convention; a bare
 * `{promo_redirect_url}` would throw on every single row this service
 * creates today. `analyzeTemplate` only warns about bare-referenced
 * `required: false` fields (`render.ts`'s `unguardedOptionalFields`), so
 * wrapping a `required: true` field is legal and silent — see
 * `docs/p2/P2_02_TEMPLATE_ENGINE.md` §1.3/§3 for the html-context and
 * field-registry rules this template must (and does) stay inside:
 * `cover_url` only as the entire `img[src]` value, `promo_redirect_url` only
 * as the entire `a[href]` value, both quoted, neither concatenated with
 * anything else, and no other registered field placed inside any attribute.
 */
import type { ArticleTemplateSource } from "@/lib/seo/template";

/**
 * Not an `ArticleTemplate.templateKey` — no such row exists. Carried only as
 * `RenderArticleContext.templateKey` so a `TemplateRenderError` thrown while
 * rendering this constant is distinguishable in logs/tests from a future
 * DB-sourced template's failures.
 */
export const DEFAULT_ARTICLE_TEMPLATE_KEY = "system-default-v1";

export const DEFAULT_ARTICLE_TEMPLATE: ArticleTemplateSource = Object.freeze({
  title: "{novel_title}",
  body: [
    "<article>",
    "<h1>{novel_title}</h1>",
    '{if cover_url}<p><img src="{cover_url}" alt="Cover"></p>{endif}',
    "<p>{novel_description}</p>",
    "{if total_chapter_count}<p>Total chapters: {total_chapter_count}</p>{endif}",
    "{if preview_chapter_count}<p>Free preview chapters available: {preview_chapter_count}</p>{endif}",
    '{if promo_redirect_url}<p><a href="{promo_redirect_url}">Start Reading</a></p>{endif}',
    "</article>",
  ].join(""),
  metaTitle: "{novel_title}",
  metaDescription: "{novel_description}",
});
