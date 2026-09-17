import type { Metadata } from "next";

import { buildCategoryMetadata, CategoryBody, type CategoryRouteParams, type CategorySearchParams } from "@/app/_pages/category";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params, searchParams }: {
  params: Promise<CategoryRouteParams>;
  searchParams: Promise<CategorySearchParams>;
}): Promise<Metadata> {
  return buildCategoryMetadata(PUBLIC_SITE_LOCALE, params, searchParams);
}

export default async function CategoryPage({ params, searchParams }: {
  params: Promise<CategoryRouteParams>;
  searchParams: Promise<CategorySearchParams>;
}) {
  return CategoryBody({ locale: PUBLIC_SITE_LOCALE, params, searchParams });
}
