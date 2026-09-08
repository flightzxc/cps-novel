import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { prisma } from "@/app/_lib/public-deps";
import { loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { localePrefix } from "@/lib/slug/article-path";
import { getPublicCategoryPage } from "@/lib/site/category-queries";

/**
 * Category page shared body (WO-1 §6.1): extracted verbatim out of
 * `src/app/category/[slug]/page.tsx`, `PUBLIC_SITE_LOCALE` swapped for the
 * `locale` parameter. Two literal substitutions land here per WO-1 §6.4
 * (byte-identical English output): the bare `"Not found"` becomes
 * `t("meta.notFound")`, and `"No published novels in this category."`
 * becomes `t("collection.categoryEmpty")` (a new key — deliberately NOT
 * reusing `collection.genreEmpty`, a different existing sentence, see that
 * key's comment in `en.ts`). No other line's semantics changed.
 */

export type CategoryRouteParams = { slug: string };
export type CategorySearchParams = { page?: string | string[] };

function pageNumber(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === "") return 1;
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

async function load(locale: SiteLocale, slug: string, rawPage: string | string[] | undefined) {
  const page = pageNumber(rawPage);
  if (!page) return null;
  const [category, chrome] = await Promise.all([
    getPublicCategoryPage(prisma, locale, slug, page),
    loadChrome(locale),
  ]);
  return category ? { category, ...chrome } : null;
}

function seoFor(locale: SiteLocale, loaded: NonNullable<Awaited<ReturnType<typeof load>>>) {
  return generateSeoMeta({
    entity: "category",
    locale,
    pageNumber: loaded.category.page,
    data: {
      name: loaded.category.category.name,
      slug: loaded.category.category.slug,
      description: loaded.category.category.description,
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage || loaded.category.novels[0]?.coverUrl,
    },
  });
}

export async function buildCategoryMetadata(
  locale: SiteLocale,
  params: Promise<CategoryRouteParams>,
  searchParams: Promise<CategorySearchParams>,
): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const loaded = await load(locale, slug, query.page);
  return loaded
    ? toNextMetadata(seoFor(locale, loaded))
    : { title: getPublicT(locale)("meta.notFound"), robots: { index: false, follow: false } };
}

export async function CategoryBody({
  locale,
  params,
  searchParams,
}: {
  locale: SiteLocale;
  params: Promise<CategoryRouteParams>;
  searchParams: Promise<CategorySearchParams>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const loaded = await load(locale, slug, query.page);
  if (!loaded) notFound();
  const t = getPublicT(locale);
  const seo = seoFor(locale, loaded);
  return <>
    {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
    <CollectionScreen
      locale={locale}
      chrome={loaded.chrome}
      title={loaded.category.category.name}
      description={loaded.category.category.description}
      novels={loaded.category.novels}
      emptyMessage={t("collection.categoryEmpty")}
    />
    <Pagination
      locale={locale}
      currentPage={loaded.category.page}
      totalPages={loaded.category.totalPages}
      basePath={`${localePrefix(locale)}/category/${loaded.category.category.slug}`}
    />
  </>;
}
