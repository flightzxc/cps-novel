import { NextResponse, type NextRequest } from "next/server";

import {
  evaluateAdminHostAccess,
  readAdminCanonicalOrigin,
  resolveAdminHost,
  resolveSiteHostSafely,
} from "@/lib/site/admin-origin";
import { getSiteUrl } from "@/lib/seo/site-url";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";
import { pickPublishableLocale, SITE_LOCALE_REQUEST_HEADER } from "@/lib/site/request-locale";

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

/**
 * WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.5): `/en`, `/en/`,
 * `/en/anything` -> the bare-path equivalent (query string preserved).
 * `/enterprise` and friends must NOT match — the prefix must be exactly
 * `/en` or start with `/en/`. Ported from the short-drama sister site's
 * `src/i18n/default-locale-redirect.ts` (`getDefaultLocaleRedirectPath`),
 * generalized from its hardcoded `routing.defaultLocale` to this site's own
 * `PUBLIC_SITE_LOCALE`. Deliberately does NOT replicate that sister site's
 * `/en/blog` 301 special case (`src/proxy.ts:261-265` there) — that is a
 * documented, unexplained historical inconsistency (see this work order's
 * §十三 item 3); every `/en/*` path here gets the same 308.
 *
 * Pure function, no `NextRequest`/`NextResponse` dependency, so it is
 * directly unit-testable (`tests/ui/default-locale-redirect.test.ts`).
 */
export function buildDefaultLocaleRedirectTarget(pathname: string, search: string): string | null {
  const prefix = `/${PUBLIC_SITE_LOCALE}`;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest === "/") return `/${search}`;
  // L2 hardening: refuse to redirect into a protocol-relative or
  // backslash-prefixed remainder (`/en//evil.com/...`, `/en/\evil.com`).
  // `new URL(target, base)` below treats a leading `//` as scheme-relative
  // (keeps `base`'s protocol, swaps in the new host) — confirmed directly:
  // `new URL("//evil.com/x", "https://site.com")` resolves to
  // `https://evil.com/x` — and a leading `\` normalizes the same way once
  // it reaches a WHATWG URL parser (both `new URL()` and browsers treat `\`
  // as `/` for a special scheme). Either shape would turn this same-origin
  // 308 into an open redirect to an attacker-controlled host. This function
  // has no `NextRequest` context of its own to lean on, so it stays safe on
  // whatever `pathname` string it is given — see
  // `tests/ui/default-locale-redirect.test.ts` for both the pure-function
  // cases and an end-to-end `proxy()` case confirming a real `NextRequest`
  // does not strip a `//` out of `nextUrl.pathname` on its own, so this
  // guard is load-bearing through the real call site too, not just
  // speculative hardening.
  if (rest.startsWith("//") || rest.startsWith("/\\")) return null;
  return `${rest}${search}`;
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

  if (!result.allow) return denied();

  // WO-1 §6.5: only reached once the admin-host isolation check above has
  // already allowed the request — the 404 priority above must never be
  // bypassed by this redirect.
  const redirectTarget = buildDefaultLocaleRedirectTarget(request.nextUrl.pathname, request.nextUrl.search);
  if (redirectTarget) {
    try {
      // Built from the site's own configured canonical origin
      // (`getSiteUrl()`), never from the request's own Host header — the
      // same discipline `resolveSiteHostSafely()` above documents (a
      // request-controlled Location would let a spoofed Host leak into a
      // redirect response, e.g. `Location: http://localhost:3000/...`).
      return NextResponse.redirect(new URL(redirectTarget, getSiteUrl()), 308);
    } catch {
      // SITE_URL misconfigured (`SiteUrlConfigurationError`): fail closed on
      // this redirect specifically — `/en/*` keeps 404ing exactly as it did
      // before this pass — rather than letting a config error take down the
      // whole request the way `resolveSiteHostSafely()` avoids for the
      // admin-host check above.
    }
  }

  // WO-2 §8.2: forward the request's resolved site locale as a header so
  // `src/app/layout.tsx` — which sits above both public route trees (and
  // the admin/dev-preview segments) and has no `[locale]` route param of
  // its own to read — can set `<html lang>`/`dir` without re-deriving this
  // path-parsing rule. Only the path's first segment is consulted, and only
  // when it's in the OPEN locale set (`pickPublishableLocale` ->
  // `isPublishableLocale`, the same gate every other exit point reads) —
  // never `SITE_LOCALES`, so this cannot advertise an unopened locale.
  // Today that set is `{"en"}`, `en` is never itself a path prefix (D-8),
  // and any `/en/*` request was already redirected away above — so this
  // resolves to `"en"` for every request that reaches here, matching the
  // root layout's existing hardcoded `lang="en"` exactly.
  const [, firstPathSegment] = request.nextUrl.pathname.split("/");
  const requestLocale = pickPublishableLocale(firstPathSegment);
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set(SITE_LOCALE_REQUEST_HEADER, requestLocale);
  return NextResponse.next({ request: { headers: forwardedHeaders } });
}

// Excludes Next's own build-time static assets — nothing this proxy decides
// depends on the app/API/route boundary, so everything else (including
// `/api/health`, `/robots.txt`, `/sitemap.xml`) still runs through it.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|apple-icon|icon\\.).*)"],
};
