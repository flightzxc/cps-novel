import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { loadBlogList, loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { BlogListScreen } from "@/features/public-ui/blog/BlogListScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { isArticleBlogEnabled } from "@/lib/flags";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
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
 *
 * WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.1): shared body
 * extracted verbatim out of `src/app/blog/page.tsx`, `PUBLIC_SITE_LOCALE`
 * swapped for the `locale` parameter. One literal replacement lands here
 * per WO-1 §6.4 (byte-identical English output): the bare `"Not found"`
 * early-return in `buildBlogListMetadata` becomes `t("meta.notFound")` —
 * `t` is hoisted above that early return (it previously existed only after
 * it, for the success path's `t("blog.listTitle")`) purely to support that
 * substitution. No other line's semantics changed.
 */

export type BlogListSearchParams = { page?: string | string[] };

function parseBlogPageParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

async function loadBlogListPage(locale: SiteLocale, rawPage: string | string[] | undefined) {
  if (!isArticleBlogEnabled()) return null;
  const requested = parseBlogPageParam(rawPage);
  if (requested === null) return null;

  const [{ settings, chrome }, cards] = await Promise.all([
    loadChrome(locale),
    loadBlogList(locale),
  ]);
  const paged = paginateBlogCards(cards, requested);
  // C-29 review low: `paginateBlogCards` forces `totalPages` to 1 when
  // `totalCount === 0` (its own doc comment), so `requested > totalPages`
  // alone already 404s `page=2` against zero posts — the previous `&&
  // totalCount > 0` clause suppressed exactly that case (page 1 always
  // passes regardless, since `1 > 1` is false). See `src/app/browse/page.tsx`'s
  // identical fix.
  if (requested > paged.totalPages) return null;

  return { settings, chrome, paged };
}

export async function buildBlogListMetadata(
  locale: SiteLocale,
  searchParams: Promise<BlogListSearchParams>,
): Promise<Metadata> {
  const { page } = await searchParams;
  const t = getPublicT(locale);
  const loaded = await loadBlogListPage(locale, page);
  if (!loaded) {
    return { title: t("meta.notFound"), robots: { index: false, follow: false } };
  }

  const seo = generateSeoMeta({
    entity: "collection",
    locale,
    pageNumber: loaded.paged.page,
    data: {
      title: t("blog.listTitle"),
      description: loaded.settings.siteDescription || t("blog.listDescription"),
      canonicalPath: "/blog",
      items: loaded.paged.posts.map((post) => ({ name: post.title, url: post.href })),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || null,
    },
  });
  return toNextMetadata(seo);
}

export async function BlogListBody({
  locale,
  searchParams,
}: {
  locale: SiteLocale;
  searchParams: Promise<BlogListSearchParams>;
}) {
  const { page } = await searchParams;
  const loaded = await loadBlogListPage(locale, page);
  if (!loaded) notFound();

  const t = getPublicT(locale);
  const seo = generateSeoMeta({
    entity: "collection",
    locale,
    pageNumber: loaded.paged.page,
    data: {
      title: t("blog.listTitle"),
      description: loaded.settings.siteDescription || t("blog.listDescription"),
      canonicalPath: "/blog",
      items: loaded.paged.posts.map((post) => ({ name: post.title, url: post.href })),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || null,
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <BlogListScreen locale={locale} chrome={loaded.chrome} posts={loaded.paged.posts} />
      <Pagination
        locale={locale}
        currentPage={loaded.paged.page}
        totalPages={loaded.paged.totalPages}
        basePath="/blog"
      />
    </>
  );
}
