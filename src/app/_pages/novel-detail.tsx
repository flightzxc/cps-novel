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
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { buildFaqJsonLd } from "@/lib/seo/faq-extract";
import { buildNovelHreflangAlternates, type NovelHreflangSibling } from "@/lib/seo/novel-hreflang";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { canonicalUrl } from "@/lib/seo/seo-utils";
import { buildArticlePath, buildArticleRoutePath } from "@/lib/slug/article-path";

/**
 * Novel detail page shared body (WO-1 §6.1): extracted verbatim out of
 * `src/app/novel/[slugParam]/page.tsx`, `PUBLIC_SITE_LOCALE` swapped for the
 * `locale` parameter. Two `"Not found"` literals become `t("meta.notFound")`
 * per WO-1 §6.4 (byte-identical English output) — `t` is threaded into
 * `buildNovelMetadata` purely to support that. No other line's semantics
 * changed: query order, `notFound()` timing (`not_found`/`takedown` both
 * still 404 here, `unavailable` still renders `UnavailableScreen`), and SEO
 * field construction (including the hreflang-sibling helper) are untouched.
 */

export type NovelRouteParams = { slugParam: string };

/**
 * Resolves this page's `alternates.languages` — the filtered layer required
 * by `NovelSeoData.hreflangAlternates` (see `seo-templates/novel.ts`), never
 * the same-path blind enumeration. `access.novelId` is the real Prisma
 * `Novel.id`, not `NovelDetailView.id` (which is `businessId`).
 */
async function buildHreflangForArticle(
  locale: SiteLocale,
  novelId: string,
  routePath: string,
): Promise<Record<string, string>> {
  const siblings = await loadHreflangSiblings(novelId);
  return buildNovelHreflangAlternates({
    siblings,
    currentLocale: locale,
    canonical: canonicalUrl(routePath),
    buildSiblingPath: (sibling: NovelHreflangSibling) =>
      buildArticlePath({ locale: sibling.locale, slug: sibling.slug, shortId: sibling.publicPageShortId }),
  });
}

export async function buildNovelMetadata(
  locale: SiteLocale,
  params: Promise<NovelRouteParams>,
): Promise<Metadata> {
  const { slugParam } = await params;
  const t = getPublicT(locale);
  const access = await loadArticleAccess(slugParam, locale);
  if (access.kind === "not_found") {
    return noIndexMetadata(t("meta.notFound"));
  }
  if (access.kind === "unavailable" || access.kind === "takedown") {
    return noIndexMetadata(access.title);
  }

  const [{ settings }, novel] = await Promise.all([loadChrome(locale), loadNovelDetail(access.articleId)]);
  if (!novel) return noIndexMetadata(t("meta.notFound"));

  const routePath = buildArticleRoutePath({ slug: access.slugPart, shortId: access.shortId });
  const seo = generateSeoMeta({
    entity: "novel",
    locale,
    data: {
      title: novel.seoTitle ?? novel.title,
      description: novel.seoDescription ?? novel.description,
      canonicalPath: routePath,
      coverUrl: novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      chapterCount: novel.totalChapterCount,
      siteName: settings.siteName,
      hreflangAlternates: await buildHreflangForArticle(locale, access.novelId, routePath),
    },
  });
  return toNextMetadata(seo);
}

export async function NovelBody({
  locale,
  params,
}: {
  locale: SiteLocale;
  params: Promise<NovelRouteParams>;
}) {
  const { slugParam } = await params;
  const [access, { chrome, settings }] = await Promise.all([
    loadArticleAccess(slugParam, locale),
    loadChrome(locale),
  ]);

  if (access.kind === "not_found" || access.kind === "takedown") notFound();
  if (access.kind === "unavailable") {
    return (
      <UnavailableScreen
        locale={locale}
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
    locale,
    data: {
      title: novel.seoTitle ?? novel.title,
      description: novel.seoDescription ?? novel.description,
      canonicalPath: routePath,
      coverUrl: novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      chapterCount: novel.totalChapterCount,
      siteName: settings.siteName,
      hreflangAlternates: await buildHreflangForArticle(locale, access.novelId, routePath),
    },
  });

  const faqJsonLd = novel.contentBody ? buildFaqJsonLd(novel.contentBody) : null;
  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      {faqJsonLd ? <JsonLd json={JSON.stringify(faqJsonLd)} /> : null}
      <NovelDetailScreen locale={locale} chrome={chrome} novel={novel} />
    </>
  );
}
