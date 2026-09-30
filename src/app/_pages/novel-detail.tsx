import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import {
  loadActiveLocales,
  loadArticleAccess,
  loadChrome,
  loadHreflangSiblings,
  loadNovelDetail,
  loadRelatedAndNewReleases,
} from "@/app/_lib/public-load";
import { noIndexMetadata, toNextMetadata } from "@/app/_lib/seo-metadata";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { buildFaqJsonLd } from "@/lib/seo/faq-extract";
import { buildNovelHreflangAlternates, type NovelHreflangSibling } from "@/lib/seo/novel-hreflang";
import { generateSeoMeta, normalizeMetadataTitle } from "@/lib/seo/seo-meta-generator";
import { resolveSiteBrandName } from "@/lib/seo/site-brand";
import { canonicalUrl } from "@/lib/seo/seo-utils";
import { buildArticlePath, decodeSlugParam, localePrefix } from "@/lib/slug/article-path";

/**
 * Novel detail page shared body (WO-1 §6.1): extracted verbatim out of
 * `src/app/novel/[slugParam]/page.tsx`, `PUBLIC_SITE_LOCALE` swapped for the
 * `locale` parameter. Two `"Not found"` literals become
 * `getPublicT(locale)("meta.notFound")` per WO-1 §6.4 (byte-identical
 * English output), called inline at each site exactly where the literal
 * used to sit — never hoisted into a shared `const t` above them, since
 * `buildNovelMetadata`'s success path never needs `t` at all (unlike
 * `buildBrowseMetadata`'s). WO-1's verbatim extraction keeps each call at
 * the literal's original spot; there is no throw to scope by hoisting
 * above `loadArticleAccess` (WO-3's `loadMessages` deep-merges onto `en`
 * and never throws on an incomplete catalog). No other line's semantics
 * changed: query order, `notFound()` timing
 * (`not_found`/`takedown` both still 404 here, `unavailable` still renders
 * `UnavailableScreen`), and SEO field construction (including the
 * hreflang-sibling helper) are untouched.
 */

export type NovelRouteParams = { slugParam: string };

/**
 * 小说详情页交给布局的标题：文章 SEO 标题（`seoMetadata.metaTitle`，缺失时用书名）
 * 先去掉末尾已有的 `| 站点名` 再交出去——根布局的标题模板会再加一次
 * （TKD 对齐 CPS，Owner 2026-09-30；CPS 剧集详情页同样先 `normalizeMetadataTitle`
 * 再交给布局）。运营在后台单篇改 SEO 标题时可能自己写了 `| PulseNovel`，不去重就会
 * 出现双后缀。去重后为空（标题只有品牌名）时退回书名。站点名的取法与根布局共用
 * `resolveSiteBrandName`。
 */
function metadataTitleFor(novel: { seoTitle?: string | null; title: string }, siteName: string): string {
  return normalizeMetadataTitle(novel.seoTitle ?? novel.title, resolveSiteBrandName(siteName)) || novel.title;
}

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
  // Decode once, right after destructuring `params` — CPS parity
  // (`normalizeRouteSlug`, see `decodeSlugParam`'s own doc comment). Next.js
  // does not decode a `force-dynamic` App Router segment on its own, so
  // `slugParam` arrives here still percent-encoded for any non-ASCII slug.
  const { slugParam: rawSlugParam } = await params;
  const slugParam = decodeSlugParam(rawSlugParam);
  const access = await loadArticleAccess(slugParam, locale);
  if (access.kind === "not_found") {
    return noIndexMetadata(getPublicT(locale)("meta.notFound"));
  }
  // `redirect`: 页面本体马上 308 到规范地址，这份元数据不会被任何人看到；
  // 走 noindex 只是让它在任何意外泄漏的情形下不被收录。
  if (access.kind === "unavailable" || access.kind === "takedown" || access.kind === "redirect") {
    return noIndexMetadata(access.title);
  }

  const [{ settings }, novel] = await Promise.all([loadChrome(locale), loadNovelDetail(access.articleId)]);
  if (!novel) return noIndexMetadata(getPublicT(locale)("meta.notFound"));

  // Locale-prefixed (`buildArticlePath`), not `buildArticleRoutePath` — this
  // becomes both the `<link rel="canonical">` path (via `canonicalPath`
  // below) and, through `buildHreflangForArticle`'s `canonical` argument,
  // the page's own hreflang self-reference entry. The route-only builder
  // silently dropped the `/${locale}` prefix for every non-`en` locale,
  // pointing both at a bare `/novel/...` path that 404s on its own route
  // tree (`en`-only, `src/app/novel/[slugParam]/page.tsx`) — invisible until
  // this round's first non-`en` published Article (`en`'s own prefix is
  // always empty, so the two builders were byte-identical for it).
  const routePath = buildArticlePath({ locale, slug: access.slugPart, shortId: access.shortId });
  const seo = generateSeoMeta({
    entity: "novel",
    locale,
    data: {
      title: metadataTitleFor(novel, settings.siteName),
      // JSON-LD 与面包屑用干净书名，不用 SEO 标题（见 `NovelSeoData.name`）。
      name: novel.title,
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
  const { slugParam: rawSlugParam } = await params;
  const slugParam = decodeSlugParam(rawSlugParam);
  const activeLocales = await loadActiveLocales();
  const [access, { chrome, settings }] = await Promise.all([
    loadArticleAccess(slugParam, locale),
    loadChrome(locale, undefined, undefined, activeLocales),
  ]);

  if (access.kind === "not_found" || access.kind === "takedown") notFound();
  // 短码能找到已发布文章、但语种前缀不对或 slug 过期：308 到规范地址（CPS
  // `permanentRedirect(getCanonicalDramaPath(data))` 同款，
  // `drama/[slug]/page.tsx:204-207`）。不是批量 301——每条请求各自按短码就地纠正。
  if (access.kind === "redirect") {
    permanentRedirect(buildArticlePath({ locale: access.locale, slug: access.slugPart, shortId: access.shortId }));
  }
  if (access.kind === "unavailable") {
    return (
      <UnavailableScreen
        locale={locale}
        chrome={chrome}
        reason="unpublished"
        novelTitle={access.title}
        homeHref={localePrefix(locale) || "/"}
      />
    );
  }

  const [novel, recommendations] = await Promise.all([
    loadNovelDetail(access.articleId),
    loadRelatedAndNewReleases(locale, access.articleId, access.novelId),
  ]);
  if (!novel) notFound();

  // See `buildNovelMetadata` above — locale-prefixed path, not the
  // route-only builder.
  const routePath = buildArticlePath({ locale, slug: access.slugPart, shortId: access.shortId });
  const seo = generateSeoMeta({
    entity: "novel",
    locale,
    data: {
      title: metadataTitleFor(novel, settings.siteName),
      // JSON-LD 与面包屑用干净书名，不用 SEO 标题（见 `NovelSeoData.name`）。
      name: novel.title,
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
      <NovelDetailScreen
        locale={locale}
        chrome={chrome}
        novel={novel}
        related={recommendations.related}
        newReleases={recommendations.newReleases}
      />
    </>
  );
}
