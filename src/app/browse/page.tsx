import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { prisma } from "@/app/_lib/public-deps";
import { loadBrowseNovels, loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { paginateCards } from "@/lib/site/queries";
import { getPublicCategoryPage } from "@/lib/site/category-queries";

export const dynamic = "force-dynamic";

function parseBrowsePageParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

async function loadBrowsePage(
  rawPage: string | string[] | undefined,
  rawCategory: string | string[] | undefined,
) {
  const requested = parseBrowsePageParam(rawPage);
  if (requested === null) return null;

  const category = Array.isArray(rawCategory) ? rawCategory[0] : rawCategory;
  if (category) {
    const [{ settings, chrome }, result] = await Promise.all([
      loadChrome("browse"),
      getPublicCategoryPage(prisma, PUBLIC_SITE_LOCALE, category, requested),
    ]);
    return result ? { settings, chrome, paged: result, category: result.category } : null;
  }

  const [{ settings, chrome }, cards] = await Promise.all([
    loadChrome("browse"),
    loadBrowseNovels(PUBLIC_SITE_LOCALE),
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

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[]; category?: string | string[] }>;
}): Promise<Metadata> {
  const { page, category } = await searchParams;
  const loaded = await loadBrowsePage(page, category);
  if (!loaded) {
    return {
      title: getPublicT(PUBLIC_SITE_LOCALE)("meta.notFound"),
      robots: { index: false, follow: false },
    };
  }

  const seo = generateSeoMeta({
    entity: "collection",
    locale: PUBLIC_SITE_LOCALE,
    pageNumber: loaded.paged.page,
    data: {
      title: loaded.category ? `${loaded.category.name} novels` : "All works",
      description: loaded.category?.description || loaded.settings.siteDescription || "Published novels.",
      canonicalPath: loaded.category ? `/browse?category=${encodeURIComponent(loaded.category.slug)}` : "/browse",
      items: loaded.paged.novels.map((novel) => ({ name: novel.title, url: novel.href })),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || loaded.paged.novels[0]?.coverUrl || null,
    },
  });
  return toNextMetadata(seo);
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[]; category?: string | string[] }>;
}) {
  const { page, category } = await searchParams;
  const loaded = await loadBrowsePage(page, category);
  if (!loaded) notFound();

  const t = getPublicT(PUBLIC_SITE_LOCALE);
  const seo = generateSeoMeta({
    entity: "collection",
    locale: PUBLIC_SITE_LOCALE,
    pageNumber: loaded.paged.page,
    data: {
      title: loaded.category ? `${loaded.category.name} novels` : "All works",
      description: loaded.category?.description || loaded.settings.siteDescription || "Published novels.",
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
        locale={PUBLIC_SITE_LOCALE}
        chrome={loaded.chrome}
        title={loaded.category?.name || t("collection.allWorksTitle")}
        description={loaded.category?.description || t("collection.allWorksDescription")}
        novels={loaded.paged.novels}
        emptyMessage={t("collection.allWorksEmpty")}
      />
      <Pagination
        locale={PUBLIC_SITE_LOCALE}
        currentPage={loaded.paged.page}
        totalPages={loaded.paged.totalPages}
        basePath="/browse"
        searchParams={loaded.category ? { category: loaded.category.slug } : undefined}
      />
    </>
  );
}
