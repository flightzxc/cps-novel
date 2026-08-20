import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { loadBrowseNovels, loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { paginateCards } from "@/lib/site/queries";

export const dynamic = "force-dynamic";

function parseBrowsePageParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

async function loadBrowsePage(rawPage: string | string[] | undefined) {
  const requested = parseBrowsePageParam(rawPage);
  if (requested === null) return null;

  const [{ settings, chrome }, cards] = await Promise.all([
    loadChrome("browse"),
    loadBrowseNovels(PUBLIC_SITE_LOCALE),
  ]);
  const paged = paginateCards(cards, requested);
  if (requested > paged.totalPages && paged.totalCount > 0) return null;

  return { settings, chrome, paged };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}): Promise<Metadata> {
  const { page } = await searchParams;
  const loaded = await loadBrowsePage(page);
  if (!loaded) {
    return { title: getPublicT()("meta.notFound"), robots: { index: false, follow: false } };
  }

  const seo = generateSeoMeta({
    entity: "collection",
    locale: PUBLIC_SITE_LOCALE,
    pageNumber: loaded.paged.page,
    data: {
      title: "All works",
      description: loaded.settings.siteDescription || "Published novels.",
      canonicalPath: "/browse",
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
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { page } = await searchParams;
  const loaded = await loadBrowsePage(page);
  if (!loaded) notFound();

  const t = getPublicT();
  const seo = generateSeoMeta({
    entity: "collection",
    locale: PUBLIC_SITE_LOCALE,
    pageNumber: loaded.paged.page,
    data: {
      title: "All works",
      description: loaded.settings.siteDescription || "Published novels.",
      canonicalPath: "/browse",
      items: loaded.paged.novels.map((novel) => ({ name: novel.title, url: novel.href })),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || loaded.paged.novels[0]?.coverUrl || null,
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <CollectionScreen
        chrome={loaded.chrome}
        title={t("collection.allWorksTitle")}
        description={t("collection.allWorksDescription")}
        novels={loaded.paged.novels}
        emptyMessage={t("collection.allWorksEmpty")}
      />
      <Pagination
        currentPage={loaded.paged.page}
        totalPages={loaded.paged.totalPages}
        basePath="/browse"
      />
    </>
  );
}
