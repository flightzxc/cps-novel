import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { negotiateRootLocale } from "@/lib/locale/root-negotiation";
import { proxy } from "@/proxy";

/**
 * L10N P4 (矩阵 #9): root-path (`/`) Accept-Language/cookie negotiation.
 * `negotiateRootLocale` is `COPY` from CPS `3a76877:src/i18n/root-negotiation.ts`
 * (see that module's own header comment for the exact provenance and the
 * two deliberate substitutions — `SITE_LOCALES`/`PUBLIC_SITE_LOCALE` in
 * place of CPS's `next-intl` `routing` object).
 *
 * Two layers of coverage: `negotiateRootLocale` directly (pure request-in,
 * response-or-null-out, no host awareness of its own — see its own doc
 * comment), and `proxy()`'s wiring around it (admin-host gate runs first,
 * negotiation is skipped entirely off the public host).
 */

const SITE_HOST = "pulsenovels.com";
const ADMIN_HOST = "zbcwf.pulsenovels.com";
const ORIGIN = `https://${SITE_HOST}`;

function rootRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(ORIGIN, { headers: { host: SITE_HOST, ...headers } });
}

describe("negotiateRootLocale — pure function", () => {
  it("only negotiates pathname === '/', never a deeper path", () => {
    const nonRoot = new NextRequest(`${ORIGIN}/browse`, {
      headers: { host: SITE_HOST, "accept-language": "ru" },
    });
    expect(negotiateRootLocale(nonRoot)).toBeNull();
  });

  it("cookie takes priority over Accept-Language", () => {
    const request = new NextRequest(ORIGIN, {
      headers: { host: SITE_HOST, cookie: "NEXT_LOCALE=fr", "accept-language": "ru" },
    });
    const response = negotiateRootLocale(request);
    expect(response?.status).toBe(307);
    expect(new URL(response!.headers.get("location")!).pathname).toBe("/fr");
  });

  it("Accept-Language: ru -> 307 to /ru with a Set-Cookie", () => {
    const response = negotiateRootLocale(rootRequest({ "accept-language": "ru" }));
    expect(response).not.toBeNull();
    expect(response!.status).toBe(307);
    expect(new URL(response!.headers.get("location")!).pathname).toBe("/ru");
    const setCookie = response!.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("NEXT_LOCALE=ru");
    expect(setCookie.toLowerCase()).toContain("path=/");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    // 1 year, matching 3a76877:src/i18n/routing.ts:6-25's localeCookie.maxAge verbatim.
    expect(setCookie.toLowerCase()).toContain(`max-age=${60 * 60 * 24 * 365}`);
  });

  it("a resolved locale of en never redirects (already the default)", () => {
    expect(negotiateRootLocale(rootRequest({ "accept-language": "en" }))).toBeNull();
  });

  it("no Accept-Language and no cookie: no redirect", () => {
    expect(negotiateRootLocale(rootRequest())).toBeNull();
  });

  it("an unregistered/garbage Accept-Language value never redirects", () => {
    expect(negotiateRootLocale(rootRequest({ "accept-language": "xx-not-a-real-locale" }))).toBeNull();
  });

  it.each([
    "Googlebot/2.1 (+http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Some-Random-Spider/1.0",
  ])("never negotiates for a bot UA (%s), even with a clear Accept-Language signal", (userAgent) => {
    expect(negotiateRootLocale(rootRequest({ "accept-language": "ru", "user-agent": userAgent }))).toBeNull();
  });

  it("an invalid cookie value falls through to Accept-Language, not straight to no-op", () => {
    const request = new NextRequest(ORIGIN, {
      headers: { host: SITE_HOST, cookie: "NEXT_LOCALE=not-a-real-locale", "accept-language": "ru" },
    });
    const response = negotiateRootLocale(request);
    expect(new URL(response!.headers.get("location")!).pathname).toBe("/ru");
  });
});

describe("proxy() — negotiation wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("negotiates on the public host's root path", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const request = new NextRequest(ORIGIN, { headers: { host: SITE_HOST, "accept-language": "ru" } });
    const response = proxy(request);
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/ru");
  });

  it("never negotiates on the admin host, even for its own root path", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    // Admin host's root path is not an admin path -> the host-isolation gate
    // denies it with a bare 404 before negotiation would ever run; either
    // way, no redirect towards a locale-prefixed path is ever produced.
    const request = new NextRequest(`https://${ADMIN_HOST}/`, {
      headers: { host: ADMIN_HOST, "accept-language": "ru" },
    });
    const response = proxy(request);
    expect(response.status).not.toBe(307);
  });

  it("does not negotiate for a non-root path even with a clear Accept-Language signal", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const request = new NextRequest(`${ORIGIN}/browse`, {
      headers: { host: SITE_HOST, "accept-language": "ru" },
    });
    const response = proxy(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  // L10N P4 review fix (n2): an unrecognised Host header takes the
  // `evaluateAdminHostAccess` fail-open branch for a non-admin path
  // (`src/lib/site/admin-origin.ts:215-220` — "fail closed the same way as
  // the public host for everything that isn't an admin path") and so is
  // ALLOWED through the admin-host gate at `/`. That allow must not be
  // conflated with "this is the public site host" for negotiation purposes:
  // `proxy()`'s own `requestHost === siteHost` check
  // (`src/proxy.ts:154-155`) is a second, stricter gate specifically for
  // `negotiateRootLocale`, and this request — Host not equal to either the
  // configured site host or admin host — must fail it.
  it("does not negotiate when the Host header is unrecognised, even though the admin-host gate fail-opens it through", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const UNRECOGNISED_HOST = "203.0.113.9";
    const request = new NextRequest(`http://${UNRECOGNISED_HOST}/`, {
      headers: { host: UNRECOGNISED_HOST, "accept-language": "ru" },
    });
    const response = proxy(request);
    // Fail-open on the admin gate -> reaches this far without a 404, but
    // never negotiates: no 307, no redirect Location, no locale cookie.
    expect(response.status).not.toBe(307);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
