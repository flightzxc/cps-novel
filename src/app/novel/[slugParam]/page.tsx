import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { loadArticleAccess, loadChrome, loadNovelDetail } from "@/app/_lib/public-load";
import { noIndexMetadata, toNextMetadata } from "@/app/_lib/seo-metadata";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { buildArticleRoutePath } from "@/lib/slug/article-path";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

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

  const seo = generateSeoMeta({
    entity: "novel",
    locale: PUBLIC_SITE_LOCALE,
    data: {
      title: novel.title,
      description: novel.description,
      canonicalPath: buildArticleRoutePath({ slug: access.slugPart, shortId: access.shortId }),
      coverUrl: novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      chapterCount: novel.totalChapterCount,
      siteName: settings.siteName,
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
        chrome={chrome}
        reason="unpublished"
        novelTitle={access.title}
        homeHref="/"
      />
    );
  }

  const novel = await loadNovelDetail(access.articleId);
  if (!novel) notFound();

  const seo = generateSeoMeta({
    entity: "novel",
    locale: PUBLIC_SITE_LOCALE,
    data: {
      title: novel.title,
      description: novel.description,
      canonicalPath: buildArticleRoutePath({ slug: access.slugPart, shortId: access.shortId }),
      coverUrl: novel.coverUrl,
      defaultOgImage: settings.defaultOgImage.trim() || null,
      chapterCount: novel.totalChapterCount,
      siteName: settings.siteName,
    },
  });

  return (
    <>
      {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
      <NovelDetailScreen chrome={chrome} novel={novel} />
    </>
  );
}
