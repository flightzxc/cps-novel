import type { Metadata } from "next";

import { JsonLd } from "@/app/_components/json-ld";
import { loadChrome, loadHomeCarousel, loadHomeNovels, loadPublicCategories } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";

/**
 * Home page shared body (WO-1 `施工工单_WO1-3_多语种公开站地基_2026-09-08.md`
 * §6.1): extracted verbatim out of `src/app/page.tsx`, `PUBLIC_SITE_LOCALE`
 * swapped for the `locale` parameter — no other line's semantics changed
 * (query order, `Promise.all` grouping, SEO field construction all as they
 * were). `src/app/page.tsx` (bare path) and `src/app/[locale]/page.tsx`
 * (locale-prefixed) are now both thin shells over `buildHomeMetadata` /
 * `HomeBody` below.
 *
 * N-9 (lane D): both `buildHomeMetadata` and `HomeBody` below fetch
 * categories via `loadPublicCategories(locale)` — a `React.cache()`-scoped
 * call that dedupes to one `listPublicCategories` round-trip per request —
 * and hand the same array into `loadChrome(locale, "home", categories)`,
 * which is itself request-deduped the same way. Previously each function
 * called `loadChrome("home")` alone (which ran its own internal, un-deduped-
 * relative-to-this categories query) *and* `HomePage` separately called
 * `loadPublicCategories` again for `HomeScreen`'s prop — two independent
 * `listPublicCategories` round-trips for identical data. See
 * `tests/backend/site/public-query-budget.test.ts` for the regression gate.
 */
export async function buildHomeMetadata(locale: SiteLocale): Promise<Metadata> {
  const categories = await loadPublicCategories(locale);
  const [{ settings }, novels] = await Promise.all([
    loadChrome(locale, "home", categories),
    loadHomeNovels(locale),
  ]);
  const seo = generateSeoMeta({
    entity: "home",
    locale,
    data: {
      siteName: settings.siteName,
      title: settings.homeMetaTitle || settings.siteName,
      description: settings.homeMetaDescription || settings.siteDescription,
      defaultOgImage: settings.defaultOgImage.trim() || novels[0]?.coverUrl || null,
    },
  });
  return toNextMetadata(seo);
}

export async function HomeBody({ locale }: { locale: SiteLocale }) {
  const categories = await loadPublicCategories(locale);
  const [{ settings, chrome }, novels, featuredList] = await Promise.all([
    loadChrome(locale, "home", categories),
    loadHomeNovels(locale),
    loadHomeCarousel(locale),
  ]);
  const seo = generateSeoMeta({
    entity: "home",
    locale,
    data: {
      siteName: settings.siteName,
      title: settings.homeMetaTitle || settings.siteName,
      description: settings.homeMetaDescription || settings.siteDescription,
      defaultOgImage: settings.defaultOgImage.trim() || novels[0]?.coverUrl || null,
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <HomeScreen
        locale={locale}
        chrome={chrome}
        featuredList={featuredList}
        novels={novels}
        browseAllHref="/browse"
        categories={categories}
      />
    </>
  );
}
