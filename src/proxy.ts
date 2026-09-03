import { NextResponse, type NextRequest } from "next/server";

import {
  evaluateAdminHostAccess,
  readAdminCanonicalOrigin,
  resolveAdminHost,
  resolveSiteHostSafely,
} from "@/lib/site/admin-origin";

/**
 * RC-9 admin-host isolation (2026-09-03, Owner).
 *
 * The admin backend lives on a dedicated subdomain (`zbcwf` prefix, matching
 * CPS's own convention — production origin is `https://zbcwf.pulsenovels.com`,
 * public origin `https://pulsenovels.com`; X8 local UAT uses
 * `https://zbcwf.novel.test` / `https://novel.test`, see
 * `scripts/lib/x8-production-like-env.sh`). Owner separately flagged that the
 * public short-drama sister site can open its admin login page from its
 * public domain — this proxy exists so that defect structurally cannot
 * recur here: which host a request arrived on, not which nginx `location`
 * happened to match, decides whether an admin path can ever be reached.
 *
 * Rule table (full detail and the shared/same-origin edge cases are
 * documented on `evaluateAdminHostAccess` in `src/lib/site/admin-origin.ts`,
 * which this file only calls into):
 *
 *   request host == adminHost (!= siteHost)  -> admin path allow,  else 404
 *   request host == siteHost                 -> admin path 404,    else allow
 *   any other/missing host                   -> admin path 404,    else allow
 *   adminHost misconfigured == siteHost       -> admin path 404 in production
 *                                                (logged once), allowed only
 *                                                as a non-production dev
 *                                                fallback
 *
 * `/api/health*` is exempt from the split entirely (both hosts must answer
 * it — UptimeRobot probes both origins).
 *
 * A denial is a bare 404 (`new NextResponse(null, { status: 404 })`), never
 * a redirect: redirecting would leak the admin hostname to a public-host
 * visitor, which is exactly the kind of information this proxy exists to
 * withhold.
 */

let loggedSameOriginProductionMisconfig = false;

function warnSameOriginProductionMisconfigOnce(): void {
  if (loggedSameOriginProductionMisconfig) return;
  loggedSameOriginProductionMisconfig = true;
  console.error(
    "[proxy] ADMIN_CANONICAL_ORIGIN resolves to the same host as SITE_URL in " +
      "production. Every admin path is being denied (404) on every host until " +
      "they are configured as distinct origins — see " +
      "docs/operations/PRODUCTION_DOMAIN_2026-09-03.md.",
  );
}

function denied(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

export function proxy(request: NextRequest): NextResponse {
  const result = evaluateAdminHostAccess(
    {
      requestHostHeader: request.headers.get("host"),
      pathname: request.nextUrl.pathname,
      nodeEnv: process.env.NODE_ENV,
    },
    {
      siteHost: resolveSiteHostSafely(),
      adminHostResolution: resolveAdminHost(readAdminCanonicalOrigin()),
    },
  );

  if (result.sameOriginProductionMisconfig) warnSameOriginProductionMisconfigOnce();

  return result.allow ? NextResponse.next() : denied();
}

// Excludes Next's own build-time static assets — nothing this proxy decides
// depends on the app/API/route boundary, so everything else (including
// `/api/health`, `/robots.txt`, `/sitemap.xml`) still runs through it.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|apple-icon|icon\\.).*)"],
};
