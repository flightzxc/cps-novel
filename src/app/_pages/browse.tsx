import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { loadActiveLocales, loadBrowsePage, loadCategoryPage, loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { withPageSuffix } from "@/lib/seo/page-suffix";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { localePrefix } from "@/lib/slug/article-path";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

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
 * declared after that branch, not hoisted above `loadBrowseData` — WO-1's
 * verbatim extraction keeps the call at the literal's original spot; there
 * is no throw to scope by hoisting (WO-3's `loadMessages` deep-merges onto
 * `en` and never throws on an incomplete catalog).
 *
 * B-38 (v0.5.13): the list is database-paginated. `loadBrowsePage` /
 * `loadCategoryPage` (`@/app/_lib/public-load`) are request-deduped
 * (`React.cache()`), so `generateMetadata` and the page body — which ask for
 * the same `(locale, page)` — hit the database once between them. Page 1 of
 * `/browse` and of `?category=` is as fast as any page; there is no
 * "newest N books" window, `totalCount` is the real total and every page up
 * to `totalPages` is reachable. The 404 rules are unchanged: a page past the
 * end, or a category with no books, is `notFound()`; zero books in the whole
 * locale still renders page 1 (200, empty) and 404s page 2.
 */

export type BrowseSearchParams = { page?: string | string[]; category?: string | string[] };

function parseBrowsePageParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

async function loadBrowseData(
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
      loadCategoryPage(locale, category, requested),
    ]);
    return result ? { settings, chrome, paged: result, category: result.category, activeLocales } : null;
  }

  const [{ settings, chrome }, paged] = await Promise.all([
    loadChrome(locale, "browse", undefined, activeLocales),
    loadBrowsePage(locale, requested),
  ]);
  // C-29 review low (found while auditing this route's `/blog` counterpart):
  // the list query forces `totalPages` to 1 when `totalCount === 0` (see
  // `listPublicNovelPage`), so `requested > totalPages` alone already 404s
  // `page=2` against zero novels — the previous `&& totalCount > 0` clause
  // suppressed exactly that case (page 1 always passes regardless, since
  // `1 > 1` is false). `getPublicCategoryPage`'s own guard above already
  // gets this right (`cards.length === 0` returns not-found unconditionally
  // before it ever computes `totalPages`), so only this non-category branch
  // needed the fix.
  if (requested > paged.totalPages) return null;

  return { settings, chrome, paged, category: null, activeLocales };
}

export async function buildBrowseMetadata(
  locale: SiteLocale,
  searchParams: Promise<BrowseSearchParams>,
): Promise<Metadata> {
  const { page, category } = await searchParams;
  const loaded = await loadBrowseData(locale, page, category);
  if (!loaded) {
    return {
      title: getPublicT(locale)("meta.notFound"),
      robots: { index: false, follow: false },
    };
  }

  const t = getPublicT(locale);
  // 后台"站点描述"只有一个值（不分语种），只有默认语种读它，其余语种走文案
  // （TKD 对齐 CPS，Owner 2026-09-30，同首页）。分类自身的描述（标签资产，按语种）不受影响。
  const useSettingsMetadata = locale === PUBLIC_SITE_LOCALE;
  const seo = generateSeoMeta({
    entity: "collection",
    locale,
    pageNumber: loaded.paged.page,
    data: {
      // 第 2 页起标题加本地化翻页后缀；品牌后缀由根布局模板加。这个 `title` 同时会进
      // og:title/twitter:title（CPS 契约：同样带翻页后缀、不带品牌）。
      title: withPageSuffix(
        loaded.category ? t("collection.categoryTitle", { name: loaded.category.name }) : t("collection.allWorksTitle"),
        loaded.paged.page,
        t,
      ),
      description:
        loaded.category?.description ||
        (useSettingsMetadata && loaded.settings.siteDescription) ||
        t("collection.browseSeoDescription"),
      canonicalPath: loaded.category ? `/browse?category=${encodeURIComponent(loaded.category.slug)}` : "/browse",
      items: loaded.paged.novels.map((novel) => ({ name: novel.title, url: novel.href })),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || null,
      // 站点默认图缺失时的兜底；分开传，模板才能判断最终分享图是默认图还是书封（B-37）。
      fallbackCoverUrl: loaded.paged.novels[0]?.coverUrl ?? null,
      // PN-09：空语种输出 noindex 且不声明 hreflang；hreflang 只列活跃语种。
      activeLocales: loaded.activeLocales,
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
  const loaded = await loadBrowseData(locale, page, category);
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
      defaultOgImage: loaded.settings.defaultOgImage.trim() || null,
      // 站点默认图缺失时的兜底；分开传，模板才能判断最终分享图是默认图还是书封（B-37）。
      fallbackCoverUrl: loaded.paged.novels[0]?.coverUrl ?? null,
      activeLocales: loaded.activeLocales,
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <CollectionScreen
        locale={locale}
        chrome={loaded.chrome}
        title={loaded.category?.name || t("collection.allWorksTitle")}
        description={
          loaded.category
            ? loaded.category.description ?? undefined
            : t("collection.allWorksDescription")
        }
        novels={loaded.paged.novels}
        // 标题下的作品数 = 分页覆盖的总本数（数据库实时总数；带 ?category= 时是该分类的总数），
        // 不是当前页本数——见 `CollectionScreen` 文件头注释。
        totalCount={loaded.paged.totalCount}
        emptyMessage={t("collection.allWorksEmpty")}
        // PN-06：分页条进作品网格之后、页脚之前（原先写在整个页面壳之外，DOM 里落在页脚后面）。
        pagination={
          <Pagination
            locale={locale}
            currentPage={loaded.paged.page}
            totalPages={loaded.paged.totalPages}
            basePath={`${localePrefix(locale)}/browse`}
            searchParams={loaded.category ? { category: loaded.category.slug } : undefined}
          />
        }
      />
    </>
  );
}
