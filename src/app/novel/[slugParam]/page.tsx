import type { Metadata } from "next";

import { buildNovelMetadata, NovelBody, type NovelRouteParams } from "@/app/_pages/novel-detail";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<NovelRouteParams>;
}): Promise<Metadata> {
  return buildNovelMetadata(PUBLIC_SITE_LOCALE, params);
}

export default async function NovelDetailPage({
  params,
}: {
  params: Promise<NovelRouteParams>;
}) {
  return NovelBody({ locale: PUBLIC_SITE_LOCALE, params });
}
