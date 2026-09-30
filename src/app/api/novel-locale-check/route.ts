import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/app/_lib/public-deps";
import { checkNovelLocaleMatch } from "@/lib/site/novel-locale-check";
import { asSiteLocale } from "@/lib/site/locale-label";

/**
 * 语言切换器用的公开只读接口：`GET /api/novel-locale-check?slug=<slugParam>&target=<locale>`。
 *
 * 移植自短剧站 v8.5.1 `src/app/api/drama-locale-check/route.ts:19-69`
 * （`3a76877`）——同样的入参校验（缺 slug 或 target 不是已登记语种 → `hasMatch:
 * false`）、同样的缓存头（`public, max-age=300, s-maxage=300`）。查询本体在
 * `@/lib/site/novel-locale-check`，这里只做 HTTP 边界。
 *
 * 出错时不缓存、不带任何错误细节：返回 503 + `no-store`，切换器按"出错"处理
 * （弹提示并回目标语种首页），下一次点击会重新查询，而不是把一次数据库抖动缓存
 * 五分钟。
 */
export const dynamic = "force-dynamic";

const CACHE_HEADERS = { "Cache-Control": "public, max-age=300, s-maxage=300" };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const slug = request.nextUrl.searchParams.get("slug")?.trim();
  const target = asSiteLocale(request.nextUrl.searchParams.get("target")?.trim() ?? "");

  if (!slug || !target) {
    return NextResponse.json({ hasMatch: false }, { headers: CACHE_HEADERS });
  }

  try {
    const result = await checkNovelLocaleMatch(prisma, { slugParam: slug, target });
    return NextResponse.json(result, { headers: CACHE_HEADERS });
  } catch {
    return NextResponse.json(
      { hasMatch: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
