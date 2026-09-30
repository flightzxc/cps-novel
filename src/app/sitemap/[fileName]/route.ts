import { NextResponse } from "next/server";

import {
  getSitemapSuccessHeaders,
  getSitemapUnavailableHeaders,
  readStaticSitemapFile,
  readStaticSitemapIndexedFileNames,
} from "@/lib/seo/static-sitemap-cache";
import { getSiteUrl } from "@/lib/seo/site-url";
import {
  getSitemapFileName,
  parseLegacyCategoryPageFileName,
  parseSitemapFileName,
} from "@/lib/seo/sitemap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SitemapRouteProps {
  params: Promise<{ fileName: string }>;
}

function unavailable(): NextResponse {
  return new NextResponse("Static sitemap is unavailable", {
    status: 503,
    headers: getSitemapUnavailableHeaders(),
  });
}

export async function GET(_: Request, { params }: SitemapRouteProps): Promise<NextResponse> {
  const { fileName } = await params;

  // 运营 V2（Owner 2026-09-30）：分类页并入 mainpage。旧的 `site_categorypage_<语种>[_N].xml`
  // 308 到同语种的 `site_mainpage_<语种>.xml`——照 CPS v8.5.1
  // `src/app/sitemap-category.xml/route.ts:5` 的旧网址跳转（`NextResponse.redirect(new URL(
  // "/sitemap/site_mainpage_en.xml", getSiteUrl()), 308)`，用配置的站点地址而不是请求 Host）。
  // 海阅的旧网址带语种，所以目标随语种变；语种没有内容（总索引没列它的 mainpage）时 404，
  // 不跳向一个必然 404 的地址。
  const legacy = parseLegacyCategoryPageFileName(fileName);
  if (legacy) {
    const indexed = await readStaticSitemapIndexedFileNames();
    if (indexed === null) return unavailable();
    const target = getSitemapFileName("mainpage", legacy.locale, 0);
    if (!indexed.has(target)) return new NextResponse("Not Found", { status: 404 });
    return NextResponse.redirect(new URL(`/sitemap/${target}`, getSiteUrl()), 308);
  }

  if (!parseSitemapFileName(fileName)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const staticXml = await readStaticSitemapFile(`sitemap/${fileName}`);
  if (staticXml) {
    return new NextResponse(staticXml, { headers: getSitemapSuccessHeaders("static") });
  }

  // 文件不在当前发布目录里。运营 V2：区分两种情况——
  // - 总索引读不到：还没有任何发布，服务尚不可用 → 503（与 CPS 同一份路由的原行为）；
  // - 总索引读得到，但没列这个文件：这个语种没有公开内容 / 这一类分片不存在 → 404，
  //   不返回空文件，也不让爬虫当成"暂时不可用"反复重试（海阅独有，CPS 无对应）。
  // 列了却读不到文件（发布目录不完整）仍然是 503。
  const indexed = await readStaticSitemapIndexedFileNames();
  if (indexed !== null && !indexed.has(fileName)) {
    return new NextResponse("Not Found", { status: 404 });
  }
  return unavailable();
}
