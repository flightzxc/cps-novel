import { NextResponse } from "next/server";

import {
  getSitemapSuccessHeaders,
  getSitemapUnavailableHeaders,
  readStaticSitemapFile,
} from "@/lib/seo/static-sitemap-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const staticXml = await readStaticSitemapFile("sitemap.xml");
  if (staticXml) {
    return new NextResponse(staticXml, { headers: getSitemapSuccessHeaders("static") });
  }
  return new NextResponse("Static sitemap is unavailable", {
    status: 503,
    headers: getSitemapUnavailableHeaders(),
  });
}
