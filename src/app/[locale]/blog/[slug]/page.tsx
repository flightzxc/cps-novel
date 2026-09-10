import type { Metadata } from "next";

import { requireRoutableLocale } from "@/app/[locale]/_guard";
import { buildBlogDetailMetadata, BlogDetailBody, type BlogDetailRouteParams } from "@/app/_pages/blog-detail";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string } & BlogDetailRouteParams>;
}): Promise<Metadata> {
  const { locale: rawLocale, slug } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return buildBlogDetailMetadata(locale, Promise.resolve({ slug }));
}

export default async function LocaleBlogDetailPage({
  params,
}: {
  params: Promise<{ locale: string } & BlogDetailRouteParams>;
}) {
  const { locale: rawLocale, slug } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return BlogDetailBody({ locale, params: Promise.resolve({ slug }) });
}
