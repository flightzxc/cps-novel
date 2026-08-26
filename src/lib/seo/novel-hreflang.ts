/**
 * Per-Novel, cross-LOCALE hreflang alternates for public Article detail
 * pages (novel page, chapter pages) — the filtered counterpart to
 * `seo-utils.ts#buildHreflangAlternates`.
 *
 * ## Not "cross-Novel hreflang"
 *
 * `docs/p1/P1_SHARED_CONTRACTS.md` §3 and
 * `docs/architecture/candidate-v0.2.1/novel-v1-open-decisions.md` (D-7) both
 * say "V1 不生成跨 Novel hreflang" (V1 does not generate cross-Novel
 * hreflang). Read literally that would seem to forbid this module, but it
 * does not apply here: "cross-Novel" means relating two *different*
 * `Novel.id` rows that happen to represent the same underlying work (e.g.
 * separately-cataloged translations ingested as distinct Novel records) —
 * that mapping genuinely does not exist in this codebase and remains out of
 * scope. This module never crosses a `novelId` boundary. It only resolves
 * the sibling `Article` rows that already share ONE `novelId`, which is
 * exactly what the schema models: `Article` has
 * `@@unique([novelId, locale])` — one Novel, at most one Article per
 * locale, deliberately structured so a translated edition of the same book
 * is a sibling Article row, not a second Novel. Building this filtered
 * cross-locale layer for that structure is what P0-S7a was tasked with (it
 * is also a load-bearing safety fix: without it, the novel/chapter detail
 * pages would otherwise inherit `buildHreflangAlternates`'s blind
 * same-path enumeration, which is unsafe here — see that function's doc
 * comment for why a detail page's per-locale path can't be blindly
 * enumerated).
 *
 * ## Origin
 *
 * Structural/algorithmic port of CPS's `buildDramaHreflangAlternatesFromArticles`
 * / `buildDramaHreflangAlternatesByPublishedArticles` (`dramaId` branch),
 * `git show v8.2.10:src/lib/drama-hreflang.ts`, read-only reference at
 * `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin`. CPS's
 * `Drama`/`Article` pairing (`@@unique([dramaId, locale])`) is the same
 * shape as this project's `Novel`/`Article`
 * (`@@unique([novelId, locale])`). Differences from the CPS original:
 * this module reuses `visibility.ts`'s `isPublicationStatePublic` +
 * `isPromoReady` (this project's single authoritative "is this row publicly
 * visible" answer — CPS's `PUBLIC_DRAMA_RECORD` equivalent) instead of a
 * bespoke `ARTICLE_STATUS.PUBLISHED` + `publishTime <= now` check (this
 * project has no publish-time gate at the read boundary — see
 * `src/server/publication/access.ts`'s header comment), and additionally
 * intersects with `listPublishableLocales()` so a locale that is technically
 * live in the DB but has not cleared the D-7 publish whitelist can never
 * appear in a hreflang alternate (CPS's `locales`/`isLocale` guard is the
 * "registered" gate only; this project keeps "registered" and "publishable"
 * as two independent gates everywhere else, so this module does too).
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { listPublishableLocales, type SiteLocale } from "@/lib/locale/locale-canonical";
import {
  buildPublicArticleWhere,
  isPromoReady,
  isPublicationStatePublic,
} from "@/server/publication/visibility";
import { toAbsoluteUrl } from "@/lib/seo/site-url";

export type NovelHreflangSibling = {
  readonly locale: SiteLocale;
  readonly slug: string;
  readonly publicPageShortId: string;
};

const NOVEL_HREFLANG_SELECT = {
  locale: true,
  slug: true,
  publicPageShortId: true,
  status: true,
  deletedAt: true,
  novel: { select: { status: true, deletedAt: true } },
  promoLink: { select: { status: true, webUrl: true, appUrl: true, deletedAt: true } },
} as const satisfies Prisma.ArticleSelect;

type NovelHreflangCandidate = Prisma.ArticleGetPayload<{ select: typeof NOVEL_HREFLANG_SELECT }>;

/**
 * Same predicate shape as `sitemap.ts`'s `isVisibleCandidate` — the DB
 * `where` below is a cheap, index-friendly SUPERSET (per `visibility.ts`'s
 * module header), never authoritative on its own; this row-level check is
 * what actually decides whether a sibling locale is safe to link to.
 */
function isVisibleSibling(candidate: NovelHreflangCandidate): boolean {
  return (
    candidate.deletedAt === null
    && candidate.novel.deletedAt === null
    && candidate.promoLink?.deletedAt === null
    && isPublicationStatePublic(candidate.novel, candidate)
    && isPromoReady(candidate.promoLink)
  );
}

/**
 * Loads every publicly-visible Article sibling for one Novel, restricted to
 * locales that are BOTH actually published (row-level check above, not a DB
 * pre-filter alone) and currently on the D-7 publish whitelist. Returns `[]`
 * without touching the DB when the whitelist itself is empty — today's
 * state (see `locale-canonical.ts`), and the common case this function must
 * handle correctly since it runs on every novel/chapter page render.
 */
export async function loadNovelHreflangSiblings(
  db: PrismaClient | Prisma.TransactionClient,
  novelId: string,
): Promise<NovelHreflangSibling[]> {
  const publishableLocales = listPublishableLocales();
  if (publishableLocales.length === 0) return [];

  const rows = await db.article.findMany({
    where: buildPublicArticleWhere({
      novelId,
      locale: { in: publishableLocales },
    }),
    select: NOVEL_HREFLANG_SELECT,
  });

  return rows.filter(isVisibleSibling).map((row) => ({
    // Safe: the `where` clause above already restricts `locale` to
    // `publishableLocales`, which is typed `SiteLocale[]`.
    locale: row.locale as SiteLocale,
    slug: row.slug,
    publicPageShortId: row.publicPageShortId,
  }));
}

export type BuildNovelHreflangAlternatesInput = {
  /** Publicly-visible sibling Article rows, from `loadNovelHreflangSiblings`. */
  readonly siblings: readonly NovelHreflangSibling[];
  /** The locale of the page currently being rendered. */
  readonly currentLocale: string;
  /** This page's own absolute canonical URL — always used for the self entry. */
  readonly canonical: string;
  /**
   * Builds the site-relative path for one sibling locale. The novel page
   * passes `buildArticlePath`; a chapter page passes `buildChapterPath`
   * (same sibling list — canonical chapter numbers are Novel-scoped, shared
   * across every locale's Article, per `src/lib/site/queries.ts`).
   */
  readonly buildSiblingPath: (sibling: NovelHreflangSibling) => string;
};

/**
 * Pure alternates builder — no DB access, easily unit-testable. Mirrors CPS
 * `buildDramaHreflangAlternatesFromArticles`'s shape: every sibling locale
 * gets an absolute URL, the current locale always self-references the exact
 * canonical the caller is rendering (never recomputed from `siblings`, so a
 * page always advertises itself correctly even if its own row was somehow
 * excluded from `siblings`), and `x-default` prefers the site default
 * locale's entry, falling back to `canonical` when the default locale isn't
 * (yet) among the siblings — which is the common case while
 * `PUBLISHABLE_LOCALES` stays empty.
 */
export function buildNovelHreflangAlternates(
  input: BuildNovelHreflangAlternatesInput,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const sibling of input.siblings) {
    result[sibling.locale] = toAbsoluteUrl(input.buildSiblingPath(sibling));
  }
  result[input.currentLocale] = input.canonical;
  result["x-default"] = result.en ?? input.canonical;
  return result;
}

/**
 * DB read + pure build, combined — the one call most page routes need.
 */
export async function buildNovelHreflangAlternatesByPublishedArticles(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    readonly novelId: string;
    readonly currentLocale: string;
    readonly canonical: string;
    readonly buildSiblingPath: (sibling: NovelHreflangSibling) => string;
  },
): Promise<Record<string, string>> {
  const siblings = await loadNovelHreflangSiblings(db, input.novelId);
  return buildNovelHreflangAlternates({ ...input, siblings });
}
