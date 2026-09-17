import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { prisma } from "@/app/_lib/public-deps";
import { loadActiveLocales, loadBrowseNovels, loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { localePrefix } from "@/lib/slug/article-path";
import { getPublicCategoryPage } from "@/lib/site/category-queries";
import { paginateCards } from "@/lib/site/queries";

/**
 * Browse page shared body (WO-1 §6.1): extracted verbatim out of
 * `src/app/browse/page.tsx`, `PUBLIC_SITE_LOCALE` swapped for the `locale`
 * parameter. Two additional literal substitutions land here per WO-1 §6.4
 * (byte-identical English output, see that section's table): the bare
 * `"All works"` / `` `${category.name} novels` `` / `"Published novels."`
 * string literals become `t("collection.allWorksTitle")` /
 * `t("collection.categoryTitle", { name })` / `t("collection.browseSeoDescription")`.
 * `t` is threaded into `buildBrowseMetadata` (which did not have one before)
 * purely to support those two replacements — no other line's semantics
 * changed (query order, `Promise.all` grouping, the C-29 review-low
 * `totalPages` fix comment, `notFound()` timing, and SEO field construction
 * are all otherwise untouched). `getPublicT(locale)` stays called inline in
 * the not-found branch (matching the original's `getPublicT(PUBLIC_SITE_
 * LOCALE)("meta.notFound")` call) and the `t` used by the success path is
 * declared after that branch, not hoisted above `loadBrowsePage` — WO-1's
 * verbatim extraction keeps the call at the literal's original spot; there
 * is no throw to scope by hoisting (WO-3's `loadMessages` deep-merges onto
 * `en` and never throws on an incomplete catalog).
 */

export type BrowseSearchParams = { page?: string | string[]; category?: string | string[] };

function parseBrowsePageParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

async function loadBrowsePage(
  locale: SiteLocale,
  rawPage: string | string[] | undefined,
  rawCategory: string | string[] | undefined,
) {
  const requested = parseBrowsePageParam(rawPage);
  if (requested === null) return null;

  const activeLocales = await loadActiveLocales();

  const category = Array.isArray(rawCategory) ? rawCategory[0] : rawCategory;
  if (category) {
    const [{ settings, chrome }, result] = await Promise.all([
      loadChrome(locale, "browse", undefined, activeLocales),
      getPublicCategoryPage(prisma, locale, category, requested),
    ]);
    return result ? { settings, chrome, paged: result, category: result.category } : null;
  }

  const [{ settings, chrome }, cards] = await Promise.all([
    loadChrome(locale, "browse", undefined, activeLocales),
    loadBrowseNovels(locale),
  ]);
  const paged = paginateCards(cards, requested);
  // C-29 review low (found while auditing this route's `/blog` counterpart):
  // `paginateCards` forces `totalPages` to 1 when `totalCount === 0` (its
  // own doc comment), so `requested > totalPages` alone already 404s
  // `page=2` against zero novels — the previous `&& totalCount > 0` clause
  // suppressed exactly that case (page 1 always passes regardless, since
  // `1 > 1` is false). `getPublicCategoryPage`'s own guard above already
  // gets this right (`cards.length === 0` returns not-found unconditionally
  // before it ever computes `totalPages`), so only this non-category branch
  // needed the fix.
  if (requested > paged.totalPages) return null;

  return { settings, chrome, paged, category: null };
}

export async function buildBrowseMetadata(
  locale: SiteLocale,
  searchParams: Promise<BrowseSearchParams>,
): Promise<Metadata> {
  const { page, category } = await searchParams;
  const loaded = await loadBrowsePage(locale, page, category);
  if (!loaded) {
    return {
      title: getPublicT(locale)("meta.notFound"),
      robots: { index: false, follow: false },
    };
  }

  const t = getPublicT(locale);
  const seo = generateSeoMeta({
    entity: "collection",
    locale,
    pageNumber: loaded.paged.page,
    data: {
      title: loaded.category ? t("collection.categoryTitle", { name: loaded.category.name }) : t("collection.allWorksTitle"),
      description: loaded.category?.description || loaded.settings.siteDescription || t("collection.browseSeoDescription"),
      canonicalPath: loaded.category ? `/browse?category=${encodeURIComponent(loaded.category.slug)}` : "/browse",
      items: loaded.paged.novels.map((novel) => ({ name: novel.title, url: novel.href })),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || loaded.paged.novels[0]?.coverUrl || null,
    },
  });
  return toNextMetadata(seo);
}

export async function BrowseBody({
  locale,
  searchParams,
}: {
  locale: SiteLocale;
  searchParams: Promise<BrowseSearchParams>;
}) {
  const { page, category } = await searchParams;
  const loaded = await loadBrowsePage(locale, page, category);
  if (!loaded) notFound();

  const t = getPublicT(locale);
  const seo = generateSeoMeta({
    entity: "collection",
    locale,
    pageNumber: loaded.paged.page,
    data: {
      title: loaded.category ? t("collection.categoryTitle", { name: loaded.category.name }) : t("collection.allWorksTitle"),
      description: loaded.category?.description || loaded.settings.siteDescription || t("collection.browseSeoDescription"),
      canonicalPath: loaded.category ? `/browse?category=${encodeURIComponent(loaded.category.slug)}` : "/browse",
      items: loaded.paged.novels.map((novel) => ({ name: novel.title, url: novel.href })),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || loaded.paged.novels[0]?.coverUrl || null,
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <CollectionScreen
        locale={locale}
        chrome={loaded.chrome}
        title={loaded.category?.name || t("collection.allWorksTitle")}
        description={loaded.category?.description || t("collection.allWorksDescription")}
        novels={loaded.paged.novels}
        emptyMessage={t("collection.allWorksEmpty")}
      />
      <Pagination
        locale={locale}
        currentPage={loaded.paged.page}
        totalPages={loaded.paged.totalPages}
        basePath={`${localePrefix(locale)}/browse`}
        searchParams={loaded.category ? { category: loaded.category.slug } : undefined}
      />
    </>
  );
}
