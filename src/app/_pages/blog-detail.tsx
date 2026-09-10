import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { loadBlogAccess, loadBlogDetail, loadChrome } from "@/app/_lib/public-load";
import { noIndexMetadata, toNextMetadata } from "@/app/_lib/seo-metadata";
import { BlogDetailScreen } from "@/features/public-ui/blog/BlogDetailScreen";
import { BlogUnavailableScreen } from "@/features/public-ui/blog/BlogUnavailableScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { buildBlogRoutePath, localePrefix } from "@/lib/slug/article-path";
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
 *
 * WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.1): shared body
 * extracted verbatim out of `src/app/blog/[slug]/page.tsx`,
 * `PUBLIC_SITE_LOCALE` swapped for the `locale` parameter. Two
 * `"Not found"` literals in `buildBlogDetailMetadata` become
 * `getPublicT(locale)("meta.notFound")` per WO-1 §6.4 (byte-identical
 * English output), called inline at each site exactly where the literal
 * used to sit — `buildBlogDetailMetadata`'s success path never needs `t`,
 * so no shared `const t` is declared at all. `getPublicT(locale)` stays
 * called inline at each not-found/takedown site rather than hoisted above
 * `loadBlogPage` — WO-1 §6.1 extracted this body verbatim out of the
 * original page.tsx, literal-for-literal, so each call sits exactly where
 * the literal it replaces used to sit; there is no throw left to scope by
 * hoisting (WO-3's `loadMessages` deep-merges onto `en` and never throws).
 * No other line's semantics changed.
 */

export type BlogDetailRouteParams = { slug: string };

type LoadedBlogPage =
  | { access: Exclude<BlogArticleAccessResult, { kind: "published" }>; post: null }
  | { access: Extract<BlogArticleAccessResult, { kind: "published" }>; post: BlogDetailView };

async function loadBlogPage(locale: SiteLocale, slug: string): Promise<LoadedBlogPage> {
  const access = await loadBlogAccess(locale, slug);
  if (access.kind !== "published") return { access, post: null };
  const post = await loadBlogDetail(access.articleId);
  if (!post) return { access: { kind: "not_found" }, post: null };
  return { access, post };
}

export async function buildBlogDetailMetadata(
  locale: SiteLocale,
  params: Promise<BlogDetailRouteParams>,
): Promise<Metadata> {
  const { slug } = await params;
  const { access, post } = await loadBlogPage(locale, slug);
  if (access.kind === "not_found") return noIndexMetadata(getPublicT(locale)("meta.notFound"));
  if (access.kind === "takedown") return noIndexMetadata(getPublicT(locale)("meta.notFound"));
  if (access.kind === "unavailable" || !post) return noIndexMetadata(access.title);

  const { settings } = await loadChrome(locale);
  const routePath = buildBlogRoutePath({ slug: post.slug });
  const seo = generateSeoMeta({
    entity: "blog",
    locale,
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

export async function BlogDetailBody({
  locale,
  params,
}: {
  locale: SiteLocale;
  params: Promise<BlogDetailRouteParams>;
}) {
  const { slug } = await params;
  const [{ access, post }, { chrome, settings }] = await Promise.all([
    loadBlogPage(locale, slug),
    loadChrome(locale),
  ]);

  if (access.kind === "not_found" || access.kind === "takedown") notFound();
  if (access.kind === "unavailable" || !post) {
    return (
      <BlogUnavailableScreen
        locale={locale}
        chrome={chrome}
        postTitle={access.title}
        homeHref={localePrefix(locale) || "/"}
      />
    );
  }

  const routePath = buildBlogRoutePath({ slug: post.slug });
  const seo = generateSeoMeta({
    entity: "blog",
    locale,
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
      <BlogDetailScreen locale={locale} chrome={chrome} post={post} />
    </>
  );
}
