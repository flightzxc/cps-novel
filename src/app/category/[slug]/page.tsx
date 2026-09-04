import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { prisma } from "@/app/_lib/public-deps";
import { loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { getPublicCategoryPage } from "@/lib/site/category-queries";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

function pageNumber(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === "") return 1;
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

async function load(slug: string, rawPage: string | string[] | undefined) {
  const page = pageNumber(rawPage);
  if (!page) return null;
  const [category, chrome] = await Promise.all([
    getPublicCategoryPage(prisma, PUBLIC_SITE_LOCALE, slug, page),
    loadChrome(),
  ]);
  return category ? { category, ...chrome } : null;
}

function seoFor(loaded: NonNullable<Awaited<ReturnType<typeof load>>>) {
  return generateSeoMeta({
    entity: "category",
    locale: PUBLIC_SITE_LOCALE,
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

export async function generateMetadata({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const loaded = await load(slug, query.page);
  return loaded ? toNextMetadata(seoFor(loaded)) : { title: "Not found", robots: { index: false, follow: false } };
}

export default async function CategoryPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const loaded = await load(slug, query.page);
  if (!loaded) notFound();
  const seo = seoFor(loaded);
  return <>
    {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
    <CollectionScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={loaded.chrome}
      title={loaded.category.category.name}
      description={loaded.category.category.description}
      novels={loaded.category.novels}
      emptyMessage="No published novels in this category."
    />
    <Pagination
      locale={PUBLIC_SITE_LOCALE}
      currentPage={loaded.category.page}
      totalPages={loaded.category.totalPages}
      basePath={`/category/${loaded.category.category.slug}`}
    />
  </>;
}
