import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { loadBlogList, loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { BlogListScreen } from "@/features/public-ui/blog/BlogListScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import { isArticleBlogEnabled } from "@/lib/flags";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { paginateBlogCards } from "@/lib/site/blog-queries";

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * `/blog` list page. `FEATURE_ARTICLE_BLOG` off -> 404, per the plan's
 * "开关" section ("关闭时 /blog 两条路由返回 404"). Reuses the `collection`
 * SEO entity (same one `/browse` uses) rather than a dedicated `blog-list`
 * template — a paginated title+description+item-list page is exactly what
 * that template already models, and `/blog`'s own path shape is
 * locale-invariant, safe for `CollectionSeoData`'s existing
 * `buildHreflangAlternates` use inside `seo-templates/collection.ts`
 * (unlike the per-slug detail page, see `seo-templates/blog.ts`'s header).
 */
export const dynamic = "force-dynamic";

function parseBlogPageParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

async function loadBlogListPage(rawPage: string | string[] | undefined) {
  if (!isArticleBlogEnabled()) return null;
  const requested = parseBlogPageParam(rawPage);
  if (requested === null) return null;

  const [{ settings, chrome }, cards] = await Promise.all([
    loadChrome(),
    loadBlogList(PUBLIC_SITE_LOCALE),
  ]);
  const paged = paginateBlogCards(cards, requested);
  if (requested > paged.totalPages && paged.totalCount > 0) return null;

  return { settings, chrome, paged };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}): Promise<Metadata> {
  const { page } = await searchParams;
  const loaded = await loadBlogListPage(page);
  if (!loaded) {
    return { title: "Not found", robots: { index: false, follow: false } };
  }

  const seo = generateSeoMeta({
    entity: "collection",
    locale: PUBLIC_SITE_LOCALE,
    pageNumber: loaded.paged.page,
    data: {
      title: "Blog",
      description: loaded.settings.siteDescription || "Articles and updates from this site.",
      canonicalPath: "/blog",
      items: loaded.paged.posts.map((post) => ({ name: post.title, url: post.href })),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || null,
    },
  });
  return toNextMetadata(seo);
}

export default async function BlogListPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { page } = await searchParams;
  const loaded = await loadBlogListPage(page);
  if (!loaded) notFound();

  const seo = generateSeoMeta({
    entity: "collection",
    locale: PUBLIC_SITE_LOCALE,
    pageNumber: loaded.paged.page,
    data: {
      title: "Blog",
      description: loaded.settings.siteDescription || "Articles and updates from this site.",
      canonicalPath: "/blog",
      items: loaded.paged.posts.map((post) => ({ name: post.title, url: post.href })),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || null,
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <BlogListScreen locale={PUBLIC_SITE_LOCALE} chrome={loaded.chrome} posts={loaded.paged.posts} />
      <Pagination
        locale={PUBLIC_SITE_LOCALE}
        currentPage={loaded.paged.page}
        totalPages={loaded.paged.totalPages}
        basePath="/blog"
      />
    </>
  );
}
