import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/app/_lib/public-deps";
import { isPromoReady } from "@/server/publication/visibility";

import { getRequestIp, hashSensitive, normalizeRedirectUrl } from "../_lib/redirect-safety";

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
} as const;

interface GoRouteProps {
  params: Promise<{ code: string }>;
}

function notFound(): NextResponse {
  return new NextResponse("Not found", { status: 404, headers: NO_STORE });
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
  if (!isPromoReady(promoLink)) return notFound();

  const candidate = promoLink.webUrl?.trim() || promoLink.appUrl?.trim() || "";
  const targetUrl = normalizeRedirectUrl(candidate);
  if (!targetUrl) return notFound();

  try {
    const ip = getRequestIp(request.headers);
    const userAgent = request.headers.get("user-agent");
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
  } catch {
    // Tracking must never block or fail the redirect.
  }

  const response = NextResponse.redirect(targetUrl, { status: 302 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
