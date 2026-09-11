import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import {
  loadActiveLocales,
  loadArticleAccess,
  loadChapterView,
  loadChrome,
  loadHreflangSiblings,
} from "@/app/_lib/public-load";
import { noIndexMetadata, toNextMetadata } from "@/app/_lib/seo-metadata";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { buildChapterPath } from "@/lib/seo/chapter-path";
import { buildNovelHreflangAlternates, type NovelHreflangSibling } from "@/lib/seo/novel-hreflang";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { canonicalUrl } from "@/lib/seo/seo-utils";
import { decodeSlugParam, localePrefix } from "@/lib/slug/article-path";

/**
 * Chapter page shared body (WO-1 §6.1): extracted verbatim out of
 * `src/app/novel/[slugParam]/chapter/[chapterNumber]/page.tsx`,
 * `PUBLIC_SITE_LOCALE` swapped for the `locale` parameter. No literal
 * replacements land here — this file is not in WO-1 §6.4's 13-occurrence
 * table (it already used `t("meta.chapterNotFound")` before this pass). No
 * other line's semantics changed.
 */

export type ChapterRouteParams = { slugParam: string; chapterNumber: string };

function parseChapterNumber(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Same filtered-hreflang requirement as the novel page (`NovelSeoData.
 * hreflangAlternates` is required — see `seo-templates/novel.ts`), but the
 * sibling path is the sibling's own chapter URL (`buildChapterPath`), not
 * its Article root. Canonical chapter numbers are Novel-scoped and shared
 * across every locale's Article (`src/lib/site/queries.ts`), so the same
 * `chapterNumber` is valid for every sibling.
 */
async function buildHreflangForChapter(
  locale: SiteLocale,
  novelId: string,
  chapterNumber: number,
  routePath: string,
): Promise<Record<string, string>> {
  const siblings = await loadHreflangSiblings(novelId);
  return buildNovelHreflangAlternates({
    siblings,
    currentLocale: locale,
    canonical: canonicalUrl(routePath),
    buildSiblingPath: (sibling: NovelHreflangSibling) =>
      buildChapterPath({
        locale: sibling.locale,
        slug: sibling.slug,
        shortId: sibling.publicPageShortId,
        chapterNumber,
      }),
  });
}

export async function buildChapterMetadata(
  locale: SiteLocale,
  params: Promise<ChapterRouteParams>,
): Promise<Metadata> {
  // Decode once, right after destructuring `params` — see
  // `decodeSlugParam`'s own doc comment (CPS parity `normalizeRouteSlug`;
  // Next.js does not decode a `force-dynamic` App Router segment itself).
  const { slugParam: rawSlugParam, chapterNumber: rawNumber } = await params;
  const slugParam = decodeSlugParam(rawSlugParam);
  const chapterNumber = parseChapterNumber(rawNumber);
  const t = getPublicT(locale);
  if (chapterNumber === null) return noIndexMetadata(t("meta.chapterNotFound"));

  const access = await loadArticleAccess(slugParam, locale);
  if (access.kind !== "published") {
    return noIndexMetadata(access.kind === "not_found" ? t("meta.chapterNotFound") : access.title);
  }

  const [{ settings }, chapter] = await Promise.all([
    loadChrome(locale),
    loadChapterView(access.articleId, chapterNumber),
  ]);
  if (!chapter) return noIndexMetadata(t("meta.chapterNotFound"));

  // Locale-prefixed (`buildChapterPath`), not `buildChapterRoutePath` — same
  // canonical/hreflang-self-reference defect as `novel-detail.tsx`'s
  // `buildNovelMetadata` (see that file's comment for the full account).
  const routePath = buildChapterPath({
    locale,
    slug: access.slugPart,
    shortId: access.shortId,
    chapterNumber,
  });
  const seo = generateSeoMeta({
    entity: "novel",
    locale,
    data: {
      title: `${chapter.title} · ${chapter.novel.title}`,
      description: chapter.paragraphs[0] ?? chapter.novel.title,
      canonicalPath: routePath,
      coverUrl: chapter.novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      siteName: settings.siteName,
      hreflangAlternates: await buildHreflangForChapter(locale, access.novelId, chapterNumber, routePath),
    },
  });
  return toNextMetadata(seo);
}

export async function ChapterBody({
  locale,
  params,
}: {
  locale: SiteLocale;
  params: Promise<ChapterRouteParams>;
}) {
  const { slugParam: rawSlugParam, chapterNumber: rawNumber } = await params;
  const slugParam = decodeSlugParam(rawSlugParam);
  const chapterNumber = parseChapterNumber(rawNumber);
  if (chapterNumber === null) notFound();

  const activeLocales = await loadActiveLocales();
  const [access, { chrome, settings }] = await Promise.all([
    loadArticleAccess(slugParam, locale),
    loadChrome(locale, undefined, undefined, activeLocales),
  ]);

  if (access.kind === "not_found" || access.kind === "takedown") notFound();
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

  const chapter = await loadChapterView(access.articleId, chapterNumber);
  if (!chapter) notFound();

  // See `buildChapterMetadata` above — locale-prefixed path.
  const routePath = buildChapterPath({
    locale,
    slug: access.slugPart,
    shortId: access.shortId,
    chapterNumber,
  });
  const seo = generateSeoMeta({
    entity: "novel",
    locale,
    data: {
      title: `${chapter.title} · ${chapter.novel.title}`,
      description: chapter.paragraphs[0] ?? chapter.novel.title,
      canonicalPath: routePath,
      coverUrl: chapter.novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      siteName: settings.siteName,
      hreflangAlternates: await buildHreflangForChapter(locale, access.novelId, chapterNumber, routePath),
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <ChapterScreen locale={locale} chrome={chrome} chapter={chapter} />
    </>
  );
}
