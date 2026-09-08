import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { loadBlogAccess, loadBlogDetail, loadChrome } from "@/app/_lib/public-load";
import { noIndexMetadata, toNextMetadata } from "@/app/_lib/seo-metadata";
import { BlogDetailScreen } from "@/features/public-ui/blog/BlogDetailScreen";
import { BlogUnavailableScreen } from "@/features/public-ui/blog/BlogUnavailableScreen";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { buildBlogRoutePath } from "@/lib/slug/article-path";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import type { BlogDetailView } from "@/lib/site/blog-queries";
import type { BlogArticleAccessResult } from "@/server/publication/access";

/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29):
 * `/blog/{slug}` detail page. `FEATURE_ARTICLE_BLOG` off, `hidden`, or no
 * matching row all collapse to `loadBlogAccess`'s `not_found` kind ->
 * `notFound()` here (`access.ts`'s `checkBlogArticlePublicAccess` already
 * checks the flag before querying). `seo_only` renders identically to
 * `public` — `checkBlogArticlePublicAccess` does not distinguish them,
 * exactly matching the plan's "`seo_only` → 与 `public` 完全一致地渲染".
 *
 * `takedown` routes to `notFound()`, same precedent as
 * `/novel/[slugParam]/page.tsx`'s own default export (see that file — it
 * treats `not_found` and `takedown` identically at the page-component
 * level even though `NovelArticleAccessResult`'s own doc comment reserves
 * `takedown` for a 410; this route follows the SAME existing behavior
 * rather than inventing a different precedent for blog).
 */
export const dynamic = "force-dynamic";

type LoadedBlogPage =
  | { access: Exclude<BlogArticleAccessResult, { kind: "published" }>; post: null }
  | { access: Extract<BlogArticleAccessResult, { kind: "published" }>; post: BlogDetailView };

async function loadBlogPage(slug: string): Promise<LoadedBlogPage> {
  const access = await loadBlogAccess(PUBLIC_SITE_LOCALE, slug);
  if (access.kind !== "published") return { access, post: null };
  const post = await loadBlogDetail(access.articleId);
  if (!post) return { access: { kind: "not_found" }, post: null };
  return { access, post };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const { access, post } = await loadBlogPage(slug);
  if (access.kind === "not_found") return noIndexMetadata("Not found");
  if (access.kind === "takedown") return noIndexMetadata("Not found");
  if (access.kind === "unavailable" || !post) return noIndexMetadata(access.title);

  const { settings } = await loadChrome();
  const routePath = buildBlogRoutePath({ slug: post.slug });
  const seo = generateSeoMeta({
    entity: "blog",
    locale: PUBLIC_SITE_LOCALE,
    data: {
      title: post.metaTitle ?? post.title,
      description: post.metaDescription ?? post.summary ?? settings.siteDescription,
      canonicalPath: routePath,
      coverUrl: post.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      siteName: settings.siteName,
      publishedAt: post.publishedAt,
      updatedAt: post.updatedAt,
    },
  });
  return toNextMetadata(seo);
}

export default async function BlogDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [{ access, post }, { chrome, settings }] = await Promise.all([loadBlogPage(slug), loadChrome()]);

  if (access.kind === "not_found" || access.kind === "takedown") notFound();
  if (access.kind === "unavailable" || !post) {
    return <BlogUnavailableScreen locale={PUBLIC_SITE_LOCALE} chrome={chrome} postTitle={access.title} />;
  }

  const routePath = buildBlogRoutePath({ slug: post.slug });
  const seo = generateSeoMeta({
    entity: "blog",
    locale: PUBLIC_SITE_LOCALE,
    data: {
      title: post.metaTitle ?? post.title,
      description: post.metaDescription ?? post.summary ?? settings.siteDescription,
      canonicalPath: routePath,
      coverUrl: post.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      siteName: settings.siteName,
      publishedAt: post.publishedAt,
      updatedAt: post.updatedAt,
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <BlogDetailScreen locale={PUBLIC_SITE_LOCALE} chrome={chrome} post={post} />
    </>
  );
}
