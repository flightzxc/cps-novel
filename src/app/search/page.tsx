import type { Metadata } from "next";

import { buildSearchMetadata, SearchBody, type SearchSearchParams } from "@/app/_pages/search";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchSearchParams>;
}): Promise<Metadata> {
  return buildSearchMetadata(PUBLIC_SITE_LOCALE, searchParams);
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchSearchParams>;
}) {
  return SearchBody({ locale: PUBLIC_SITE_LOCALE, searchParams });
}
