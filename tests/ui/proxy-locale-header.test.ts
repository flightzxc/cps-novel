import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxy } from "@/proxy";
import { SITE_LOCALE_REQUEST_HEADER } from "@/lib/site/request-locale";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.2): `src/proxy.ts`
 * forwards the resolved site locale via `SITE_LOCALE_REQUEST_HEADER`
 * (`x-novel-locale`) so `src/app/layout.tsx` can set `<html lang>`/`dir`
 * without re-deriving path parsing. `NextResponse.next({ request: {
 * headers } })` surfaces the forwarded header on the RESPONSE object as
 * `x-middleware-request-<name>` (confirmed directly against this repo's
 * installed `next/server` — this is how Next's own middleware pipeline
 * merges header overrides back into the request the app router sees), so
 * that's what these tests read.
 */

const SITE_HOST = "pulsenovels.com";
const ADMIN_HOST = "zbcwf.pulsenovels.com";
const ORIGIN = `https://${SITE_HOST}`;

function forwardedLocale(response: ReturnType<typeof proxy>): string | null {
  return response.headers.get(`x-middleware-request-${SITE_LOCALE_REQUEST_HEADER}`);
}

describe("src/proxy.ts — locale request header forwarding", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards en for the bare-path public site (today's only open locale)", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    for (const path of ["/", "/browse", "/novel/some-title-pabc123", "/category/fantasy"]) {
      const request = new NextRequest(`${ORIGIN}${path}`, { headers: { host: SITE_HOST } });
      const response = proxy(request);
      expect(response.status, path).toBe(200);
      expect(forwardedLocale(response), path).toBe("en");
    }
  });

  it("falls back to en for a locale-shaped prefix that is registered but not (yet) open", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    for (const path of ["/ja/browse", "/fr/novel/x-pabc123", "/ru"]) {
      const request = new NextRequest(`${ORIGIN}${path}`, { headers: { host: SITE_HOST } });
      const response = proxy(request);
      expect(response.status, path).toBe(200);
      expect(forwardedLocale(response), path).toBe("en");
    }
  });

  it("falls back to en for a path that merely resembles a locale prefix", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const request = new NextRequest(`${ORIGIN}/enterprise`, { headers: { host: SITE_HOST } });
    const response = proxy(request);
    expect(response.status).toBe(200);
    expect(forwardedLocale(response)).toBe("en");
  });

  it("overwrites a client-supplied x-novel-locale header with the proxy's own derivation, rather than trusting it", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    // "ja" is registered (`SITE_LOCALES`) but not (yet) open
    // (`PUBLISHABLE_LOCALES` is still `{"en"}`) — an inbound request that
    // already carries this header (a client, a misbehaving proxy hop, or an
    // attacker probing for locale smuggling) must not have it trusted:
    // `new Headers(request.headers)` copies the client's value in first,
    // and only the subsequent `.set(SITE_LOCALE_REQUEST_HEADER, ...)`
    // (proxy.ts, right below the WO-2 §8.2 comment) makes the proxy's own
    // derivation win instead.
    const request = new NextRequest(`${ORIGIN}/`, {
      headers: { host: SITE_HOST, [SITE_LOCALE_REQUEST_HEADER]: "ja" },
    });
    const response = proxy(request);
    expect(response.status).toBe(200);
    expect(forwardedLocale(response)).toBe("en");
  });

  it("does not attach the locale header to a 404 admin-host denial (that response never carries a forwarded request)", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const request = new NextRequest(`https://${ADMIN_HOST}/some-admin-path`, { headers: { host: ADMIN_HOST } });
    const response = proxy(request);
    expect(response.status).toBe(404);
    expect(forwardedLocale(response)).toBeNull();
  });

  it("the /en/* 308 redirect response itself carries no forwarded locale header (the browser re-requests the bare path, which gets its own header on the next pass)", () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const request = new NextRequest(`${ORIGIN}/en/browse`, { headers: { host: SITE_HOST } });
    const response = proxy(request);
    expect(response.status).toBe(308);
    expect(forwardedLocale(response)).toBeNull();
  });
});
