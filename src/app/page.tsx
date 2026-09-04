import type { Metadata } from "next";

import { JsonLd } from "@/app/_components/json-ld";
import { loadChrome, loadHomeCarousel, loadHomeNovels, loadPublicCategories } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [{ settings }, novels] = await Promise.all([
    loadChrome("home"),
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
  const [{ settings, chrome }, novels, featuredList, categories] = await Promise.all([
    loadChrome("home"),
    loadHomeNovels(PUBLIC_SITE_LOCALE),
    loadHomeCarousel(PUBLIC_SITE_LOCALE),
    loadPublicCategories(PUBLIC_SITE_LOCALE),
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
