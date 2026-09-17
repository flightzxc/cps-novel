import type { Metadata } from "next";

import { requireRoutableLocale } from "@/app/[locale]/_guard";
import { buildNovelMetadata, NovelBody, type NovelRouteParams } from "@/app/_pages/novel-detail";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string } & NovelRouteParams>;
}): Promise<Metadata> {
  const { locale: rawLocale, slugParam } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return buildNovelMetadata(locale, Promise.resolve({ slugParam }));
}

export default async function LocaleNovelDetailPage({
  params,
}: {
  params: Promise<{ locale: string } & NovelRouteParams>;
}) {
  const { locale: rawLocale, slugParam } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return NovelBody({ locale, params: Promise.resolve({ slugParam }) });
}
