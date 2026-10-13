import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/app/_lib/public-deps";
import { isCodeModeTheater } from "@/server/publication/theater-promo-mode";
import { isPromoReady } from "@/server/publication/visibility";

import { getRequestIp, hashSensitive, normalizeRedirectUrl } from "../_lib/redirect-safety";
import { shouldRecordGoRedirect } from "../_lib/tracking-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const PROMO_LINK_SELECT = {
  id: true,
  novelId: true,
  publicRedirectCode: true,
  webUrl: true,
  appUrl: true,
  status: true,
  deletedAt: true,
  // v0.6.0：只多读一样东西——推广所属剧场的配置，用来分辨 link / code 模式。
  // 🔴 路由本身从不读渠道口令码（`upstream_code`）：口令码模式的细判定（口令码非空、语种白名单）和展示都在
  // 中间页 `/go/[code]/app` 里做，这里只放行"已领取"的。
  channelApp: { select: { config: true } },
} as const;

interface GoRouteProps {
  params: Promise<{ code: string }>;
}

function notFound(): NextResponse {
  return new NextResponse("Not found", { status: 404, headers: NO_STORE });
}

/**
 * v0.6.0：口令码模式剧场（PlotNovel）的推广链接没有可跳转的网址——读者要先在站内中间页拿到口令码、
 * 再去商店下载 App。302 到中间页 `/go/<站内码>/app`（相对路径；站内码只含 [a-z0-9]，不需要转义，仍统一编码一次）。
 * 不记录点击（Owner 10-14 拍板第 6 项）。
 */
function codeModeRedirect(code: string): NextResponse {
  return new NextResponse(null, {
    status: 302,
    headers: { Location: `/go/${encodeURIComponent(code)}/app`, ...NO_STORE },
  });
}

function parsePublicCode(raw: string | undefined): string | null {
  try {
    const code = decodeURIComponent(raw ?? "").trim();
    return code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest, { params }: GoRouteProps): Promise<NextResponse> {
  const code = parsePublicCode((await params).code);
  if (!code) return notFound();

  const promoLink = await prisma.promoLink.findUnique({
    where: { publicRedirectCode: code },
    select: PROMO_LINK_SELECT,
  });
  if (!promoLink || promoLink.deletedAt != null) return notFound();
  // v0.6.0：口令码模式剧场 → 中间页；其余（link 模式，缺省）走下面原来的逻辑，一字未改。
  // 这里只判"口令码模式 + 状态 fetched"，因为路由从不读口令码：口令码为空白、语种不在白名单的推广也会 302 到中间页，
  // 由中间页用 `isPromoReady` 细判并 404（预期行为，不是漏判）。
  if (isCodeModeTheater(promoLink.channelApp?.config)) {
    return promoLink.status === "fetched" ? codeModeRedirect(code) : notFound();
  }
  if (!isPromoReady(promoLink)) return notFound();

  const candidate = promoLink.webUrl?.trim() || promoLink.appUrl?.trim() || "";
  const targetUrl = normalizeRedirectUrl(candidate);
  if (!targetUrl) return notFound();

  try {
    const ip = getRequestIp(request.headers);
    const userAgent = request.headers.get("user-agent");
    if (shouldRecordGoRedirect({ userAgent })) {
      await prisma.trackingEvent.create({
        data: {
          eventType: "go_redirect",
          articleId: null,
          novelId: promoLink.novelId,
          promoLinkId: promoLink.id,
          publicRedirectCode: promoLink.publicRedirectCode,
          sessionHash: null,
          requestHash: null,
          ipHash: ip ? hashSensitive(ip) : null,
          userAgentHash: userAgent ? hashSensitive(userAgent) : null,
          saltVersion: 1,
          context: {},
        },
      });
    }
  } catch {
    // Tracking must never block or fail the redirect.
  }

  const response = NextResponse.redirect(targetUrl, { status: 302 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
