import type { Metadata } from "next";

import { requireRoutableLocale } from "@/app/[locale]/_guard";
import { buildBlogListMetadata, BlogListBody, type BlogListSearchParams } from "@/app/_pages/blog-list";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<BlogListSearchParams>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return buildBlogListMetadata(locale, searchParams);
}

export default async function LocaleBlogListPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<BlogListSearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale = requireRoutableLocale(rawLocale);
  return BlogListBody({ locale, searchParams });
}
