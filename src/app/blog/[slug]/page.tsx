import type { Metadata } from "next";

import { buildBlogDetailMetadata, BlogDetailBody, type BlogDetailRouteParams } from "@/app/_pages/blog-detail";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<BlogDetailRouteParams>;
}): Promise<Metadata> {
  return buildBlogDetailMetadata(PUBLIC_SITE_LOCALE, params);
}

export default async function BlogDetailPage({
  params,
}: {
  params: Promise<BlogDetailRouteParams>;
}) {
  return BlogDetailBody({ locale: PUBLIC_SITE_LOCALE, params });
}
