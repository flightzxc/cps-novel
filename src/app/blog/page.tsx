import type { Metadata } from "next";

import { buildBlogListMetadata, BlogListBody, type BlogListSearchParams } from "@/app/_pages/blog-list";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<BlogListSearchParams>;
}): Promise<Metadata> {
  return buildBlogListMetadata(PUBLIC_SITE_LOCALE, searchParams);
}

export default async function BlogListPage({
  searchParams,
}: {
  searchParams: Promise<BlogListSearchParams>;
}) {
  return BlogListBody({ locale: PUBLIC_SITE_LOCALE, searchParams });
}
