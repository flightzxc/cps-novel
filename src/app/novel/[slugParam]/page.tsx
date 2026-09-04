import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import {
  loadArticleAccess,
  loadChrome,
  loadHreflangSiblings,
  loadNovelDetail,
} from "@/app/_lib/public-load";
import { noIndexMetadata, toNextMetadata } from "@/app/_lib/seo-metadata";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { canonicalUrl } from "@/lib/seo/seo-utils";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { buildNovelHreflangAlternates, type NovelHreflangSibling } from "@/lib/seo/novel-hreflang";
import { buildArticlePath, buildArticleRoutePath } from "@/lib/slug/article-path";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { buildFaqJsonLd } from "@/lib/seo/faq-extract";

export const dynamic = "force-dynamic";

/**
 * Resolves this page's `alternates.languages` — the filtered layer required
 * by `NovelSeoData.hreflangAlternates` (see `seo-templates/novel.ts`), never
 * the same-path blind enumeration. `access.novelId` is the real Prisma
 * `Novel.id`, not `NovelDetailView.id` (which is `businessId`).
 */
async function buildHreflangForArticle(
  novelId: string,
  routePath: string,
): Promise<Record<string, string>> {
  const siblings = await loadHreflangSiblings(novelId);
  return buildNovelHreflangAlternates({
    siblings,
    currentLocale: PUBLIC_SITE_LOCALE,
    canonical: canonicalUrl(routePath),
    buildSiblingPath: (sibling: NovelHreflangSibling) =>
      buildArticlePath({ locale: sibling.locale, slug: sibling.slug, shortId: sibling.publicPageShortId }),
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slugParam: string }>;
}): Promise<Metadata> {
  const { slugParam } = await params;
  const access = await loadArticleAccess(slugParam, PUBLIC_SITE_LOCALE);
  if (access.kind === "not_found") {
    return noIndexMetadata("Not found");
  }
  if (access.kind === "unavailable" || access.kind === "takedown") {
    return noIndexMetadata(access.title);
  }

  const [{ settings }, novel] = await Promise.all([loadChrome(), loadNovelDetail(access.articleId)]);
  if (!novel) return noIndexMetadata("Not found");

  const routePath = buildArticleRoutePath({ slug: access.slugPart, shortId: access.shortId });
  const seo = generateSeoMeta({
    entity: "novel",
    locale: PUBLIC_SITE_LOCALE,
    data: {
      title: novel.seoTitle ?? novel.title,
      description: novel.seoDescription ?? novel.description,
      canonicalPath: routePath,
      coverUrl: novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      chapterCount: novel.totalChapterCount,
      siteName: settings.siteName,
      hreflangAlternates: await buildHreflangForArticle(access.novelId, routePath),
    },
  });
  return toNextMetadata(seo);
}

export default async function NovelDetailPage({
  params,
}: {
  params: Promise<{ slugParam: string }>;
}) {
  const { slugParam } = await params;
  const [access, { chrome, settings }] = await Promise.all([
    loadArticleAccess(slugParam, PUBLIC_SITE_LOCALE),
    loadChrome(),
  ]);

  if (access.kind === "not_found" || access.kind === "takedown") notFound();
  if (access.kind === "unavailable") {
    return (
      <UnavailableScreen
        locale={PUBLIC_SITE_LOCALE}
        chrome={chrome}
        reason="unpublished"
        novelTitle={access.title}
        homeHref="/"
      />
    );
  }

  const novel = await loadNovelDetail(access.articleId);
  if (!novel) notFound();

  const routePath = buildArticleRoutePath({ slug: access.slugPart, shortId: access.shortId });
  const seo = generateSeoMeta({
    entity: "novel",
    locale: PUBLIC_SITE_LOCALE,
    data: {
      title: novel.seoTitle ?? novel.title,
      description: novel.seoDescription ?? novel.description,
      canonicalPath: routePath,
      coverUrl: novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      chapterCount: novel.totalChapterCount,
      siteName: settings.siteName,
      hreflangAlternates: await buildHreflangForArticle(access.novelId, routePath),
    },
  });

  const faqJsonLd = novel.contentBody ? buildFaqJsonLd(novel.contentBody) : null;
  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      {faqJsonLd ? <JsonLd json={JSON.stringify(faqJsonLd)} /> : null}
      <NovelDetailScreen locale={PUBLIC_SITE_LOCALE} chrome={chrome} novel={novel} />
    </>
  );
}
