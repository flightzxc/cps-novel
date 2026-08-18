import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { loadArticleAccess, loadChapterView, loadChrome } from "@/app/_lib/public-load";
import { noIndexMetadata, toNextMetadata } from "@/app/_lib/seo-metadata";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { buildChapterRoutePath } from "@/lib/seo/chapter-path";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

function parseChapterNumber(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return Number(raw);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slugParam: string; chapterNumber: string }>;
}): Promise<Metadata> {
  const { slugParam, chapterNumber: rawNumber } = await params;
  const chapterNumber = parseChapterNumber(rawNumber);
  if (chapterNumber === null) return noIndexMetadata("章节不存在");

  const access = await loadArticleAccess(slugParam, PUBLIC_SITE_LOCALE);
  if (access.kind !== "published") {
    return noIndexMetadata(access.kind === "not_found" ? "章节不存在" : access.title);
  }

  const [{ settings }, chapter] = await Promise.all([
    loadChrome(),
    loadChapterView(access.articleId, chapterNumber),
  ]);
  if (!chapter) return noIndexMetadata("章节不存在");

  const seo = generateSeoMeta({
    entity: "novel",
    locale: PUBLIC_SITE_LOCALE,
    data: {
      title: `${chapter.title} · ${chapter.novel.title}`,
      description: chapter.paragraphs[0] ?? chapter.novel.title,
      canonicalPath: buildChapterRoutePath({
        slug: access.slugPart,
        shortId: access.shortId,
        chapterNumber,
      }),
      coverUrl: chapter.novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      siteName: settings.siteName,
    },
  });
  return toNextMetadata(seo);
}

export default async function PublicChapterPage({
  params,
}: {
  params: Promise<{ slugParam: string; chapterNumber: string }>;
}) {
  const { slugParam, chapterNumber: rawNumber } = await params;
  const chapterNumber = parseChapterNumber(rawNumber);
  if (chapterNumber === null) notFound();

  const [access, { chrome, settings }] = await Promise.all([
    loadArticleAccess(slugParam, PUBLIC_SITE_LOCALE),
    loadChrome(),
  ]);

  if (access.kind === "not_found" || access.kind === "takedown") notFound();
  if (access.kind === "unavailable") {
    return (
      <UnavailableScreen
        chrome={chrome}
        reason="unpublished"
        novelTitle={access.title}
        homeHref="/"
      />
    );
  }

  const chapter = await loadChapterView(access.articleId, chapterNumber);
  if (!chapter) notFound();

  const seo = generateSeoMeta({
    entity: "novel",
    locale: PUBLIC_SITE_LOCALE,
    data: {
      title: `${chapter.title} · ${chapter.novel.title}`,
      description: chapter.paragraphs[0] ?? chapter.novel.title,
      canonicalPath: buildChapterRoutePath({
        slug: access.slugPart,
        shortId: access.shortId,
        chapterNumber,
      }),
      coverUrl: chapter.novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      siteName: settings.siteName,
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <ChapterScreen chrome={chrome} chapter={chapter} />
    </>
  );
}
