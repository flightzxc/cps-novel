import type { Metadata } from "next";

import { buildBrowseMetadata, BrowseBody, type BrowseSearchParams } from "@/app/_pages/browse";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<BrowseSearchParams>;
}): Promise<Metadata> {
  return buildBrowseMetadata(PUBLIC_SITE_LOCALE, searchParams);
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<BrowseSearchParams>;
}) {
  return BrowseBody({ locale: PUBLIC_SITE_LOCALE, searchParams });
}
