import { NextResponse } from "next/server";

import {
  getSitemapSuccessHeaders,
  getSitemapUnavailableHeaders,
  readStaticSitemapFile,
} from "@/lib/seo/static-sitemap-cache";
import { parseSitemapFileName } from "@/lib/seo/sitemap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SitemapRouteProps {
  params: Promise<{ fileName: string }>;
}

export async function GET(_: Request, { params }: SitemapRouteProps): Promise<NextResponse> {
  const { fileName } = await params;
  if (!parseSitemapFileName(fileName)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const staticXml = await readStaticSitemapFile(`sitemap/${fileName}`);
  if (staticXml) {
    return new NextResponse(staticXml, { headers: getSitemapSuccessHeaders("static") });
  }
  return new NextResponse("Static sitemap is unavailable", {
    status: 503,
    headers: getSitemapUnavailableHeaders(),
  });
}
