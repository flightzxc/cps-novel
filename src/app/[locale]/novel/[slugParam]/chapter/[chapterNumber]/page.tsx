import type { Metadata } from "next";

import { requireRoutableLocale } from "@/app/[locale]/_guard";
import { buildChapterMetadata, ChapterBody, type ChapterRouteParams } from "@/app/_pages/chapter";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string } & ChapterRouteParams>;
}): Promise<Metadata> {
  const { locale: rawLocale, slugParam, chapterNumber } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return buildChapterMetadata(locale, Promise.resolve({ slugParam, chapterNumber }));
}

export default async function LocalePublicChapterPage({
  params,
}: {
  params: Promise<{ locale: string } & ChapterRouteParams>;
}) {
  const { locale: rawLocale, slugParam, chapterNumber } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return ChapterBody({ locale, params: Promise.resolve({ slugParam, chapterNumber }) });
}
