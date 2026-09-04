import type { Metadata } from "next";

import { JsonLd } from "@/app/_components/json-ld";
import { loadChrome, loadHomeCarousel, loadHomeNovels, loadPublicCategories } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

/**
 * N-9 (lane D): both `generateMetadata` and `HomePage` below fetch categories
 * via `loadPublicCategories(PUBLIC_SITE_LOCALE)` — a `React.cache()`-scoped
 * call that dedupes to one `listPublicCategories` round-trip per request — and
 * hand the same array into `loadChrome("home", categories)`, which is itself
 * request-deduped the same way. Previously each function called
 * `loadChrome("home")` alone (which ran its own internal, un-deduped-relative-
 * to-this categories query) *and* `HomePage` separately called
 * `loadPublicCategories` again for `HomeScreen`'s prop — two independent
 * `listPublicCategories` round-trips for identical data. See
 * `tests/backend/site/public-query-budget.test.ts` for the regression gate.
 */
export async function generateMetadata(): Promise<Metadata> {
  const categories = await loadPublicCategories(PUBLIC_SITE_LOCALE);
  const [{ settings }, novels] = await Promise.all([
    loadChrome("home", categories),
    loadHomeNovels(PUBLIC_SITE_LOCALE),
  ]);
  const seo = generateSeoMeta({
    entity: "home",
    locale: PUBLIC_SITE_LOCALE,
    data: {
      siteName: settings.siteName,
      title: settings.homeMetaTitle || settings.siteName,
      description: settings.homeMetaDescription || settings.siteDescription,
      defaultOgImage: settings.defaultOgImage.trim() || novels[0]?.coverUrl || null,
    },
  });
  return toNextMetadata(seo);
}

export default async function HomePage() {
  const categories = await loadPublicCategories(PUBLIC_SITE_LOCALE);
  const [{ settings, chrome }, novels, featuredList] = await Promise.all([
    loadChrome("home", categories),
    loadHomeNovels(PUBLIC_SITE_LOCALE),
    loadHomeCarousel(PUBLIC_SITE_LOCALE),
  ]);
  const seo = generateSeoMeta({
    entity: "home",
    locale: PUBLIC_SITE_LOCALE,
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
        locale={PUBLIC_SITE_LOCALE}
        chrome={chrome}
        featuredList={featuredList}
        novels={novels}
        browseAllHref="/browse"
        categories={categories}
      />
    </>
  );
}
