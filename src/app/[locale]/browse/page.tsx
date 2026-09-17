import type { Metadata } from "next";

import { requireRoutableLocale } from "@/app/[locale]/_guard";
import { buildBrowseMetadata, BrowseBody, type BrowseSearchParams } from "@/app/_pages/browse";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<BrowseSearchParams>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return buildBrowseMetadata(locale, searchParams);
}

export default async function LocaleBrowsePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<BrowseSearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return BrowseBody({ locale, searchParams });
}
