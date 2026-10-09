import type { Metadata } from "next";

import { requireRoutableLocale } from "@/app/[locale]/_guard";
import { buildSearchMetadata, SearchBody, type SearchSearchParams } from "@/app/_pages/search";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchSearchParams>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return buildSearchMetadata(locale, searchParams);
}

export default async function LocaleSearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchSearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return SearchBody({ locale, searchParams });
}
