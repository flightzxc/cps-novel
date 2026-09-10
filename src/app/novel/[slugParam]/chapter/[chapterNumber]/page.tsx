import type { Metadata } from "next";

import { buildChapterMetadata, ChapterBody, type ChapterRouteParams } from "@/app/_pages/chapter";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<ChapterRouteParams>;
}): Promise<Metadata> {
  return buildChapterMetadata(PUBLIC_SITE_LOCALE, params);
}

export default async function PublicChapterPage({
  params,
}: {
  params: Promise<ChapterRouteParams>;
}) {
  return ChapterBody({ locale: PUBLIC_SITE_LOCALE, params });
}
