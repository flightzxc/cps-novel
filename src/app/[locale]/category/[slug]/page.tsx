import type { Metadata } from "next";

import { requireRoutableLocale } from "@/app/[locale]/_guard";
import { buildCategoryMetadata, CategoryBody, type CategoryRouteParams, type CategorySearchParams } from "@/app/_pages/category";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params, searchParams }: {
  params: Promise<{ locale: string } & CategoryRouteParams>;
  searchParams: Promise<CategorySearchParams>;
}): Promise<Metadata> {
  const { locale: rawLocale, slug } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return buildCategoryMetadata(locale, Promise.resolve({ slug }), searchParams);
}

export default async function LocaleCategoryPage({ params, searchParams }: {
  params: Promise<{ locale: string } & CategoryRouteParams>;
  searchParams: Promise<CategorySearchParams>;
}) {
  const { locale: rawLocale, slug } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return CategoryBody({ locale, params: Promise.resolve({ slug }), searchParams });
}
