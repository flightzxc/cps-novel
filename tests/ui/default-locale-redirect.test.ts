import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDefaultLocaleRedirectTarget } from "@/proxy";

/**
 * WO-1 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §6.5/§6.6 item 1):
 * `/en/*` -> bare-path 308, ported from the short-drama sister site's
 * `default-locale-redirect.ts` / `src/proxy.ts` wiring (see this file's
 * `buildDefaultLocaleRedirectTarget` doc comment for the exact
 * provenance and the one deliberate divergence — a single 308 everywhere,
 * never that sister site's `/en/blog` 301 special case).
 */

const SITE_HOST = "pulsenovels.com";
const ADMIN_HOST = "zbcwf.pulsenovels.com";
const ORIGIN = `https://${SITE_HOST}`;

describe("buildDefaultLocaleRedirectTarget — pure function", () => {
  it("maps /en and /en/ to the bare root path", () => {
    expect(buildDefaultLocaleRedirectTarget("/en", "")).toBe("/");
    expect(buildDefaultLocaleRedirectTarget("/en/", "")).toBe("/");
  });

  it("strips the /en prefix for nested paths", () => {
    expect(buildDefaultLocaleRedirectTarget("/en/browse", "")).toBe("/browse");
  });

  it("preserves the query string", () => {
    expect(buildDefaultLocaleRedirectTarget("/en/browse", "?page=2&category=x")).toBe(
      "/browse?page=2&category=x",
    );
  });

  it("does not match a path that merely starts with the same three letters (/enterprise)", () => {
    expect(buildDefaultLocaleRedirectTarget("/enterprise", "")).toBeNull();
    expect(buildDefaultLocaleRedirectTarget("/enterprise/foo", "?x=1")).toBeNull();
  });

  it("does not match another locale prefix or the bare path itself", () => {
    expect(buildDefaultLocaleRedirectTarget("/ja/browse", "")).toBeNull();
    expect(buildDefaultLocaleRedirectTarget("/browse", "")).toBeNull();
    expect(buildDefaultLocaleRedirectTarget("/", "")).toBeNull();
  });

  // L2 review hardening: `new URL(target, base)` treats a leading `//` as
  // scheme-relative (keeps `base`'s protocol, swaps in the new host) — so
  // without this guard, `/en//evil.com/x` would turn this same-origin 308
  // into an open redirect to an attacker-controlled host. Confirmed against
  // Node's own WHATWG URL parser: `new URL("//evil.com/x", "https://site.com")`
  // and `new URL("/\\evil.com/x", "https://site.com")` both resolve to
  // `https://evil.com/x` (a leading `\` also normalizes to scheme-relative
  // for a special scheme). See the "end to end" describe block below for
  // the same guarantee through `proxy()` itself — including confirmation
  // that a real `NextRequest` does NOT strip `//` out of `nextUrl.pathname`
  // on its own, so this is not a merely-theoretical input at that call site
  // either.
  it("refuses to redirect a protocol-relative or backslash-prefixed remainder (open-redirect shape)", () => {
    expect(buildDefaultLocaleRedirectTarget("/en//evil.com", "")).toBeNull();
    expect(buildDefaultLocaleRedirectTarget("/en//evil.com/x", "?y=1")).toBeNull();
    expect(buildDefaultLocaleRedirectTarget("/en/\\evil.com", "")).toBeNull();
    expect(buildDefaultLocaleRedirectTarget("/en/\\\\evil.com", "")).toBeNull();
    // A single interior slash/backslash (not right after the /en prefix)
    // stays a normal, safe same-origin redirect.
    expect(buildDefaultLocaleRedirectTarget("/en/browse/a//b", "")).toBe("/browse/a//b");
  });
});

describe("src/proxy.ts — /en/* 308 redirect, end to end via NextRequest/NextResponse", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("308s /en, /en/, and /en/browse?page=2 to the bare path, preserving the query string and never leaking the request host", async () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const { proxy } = await import("@/proxy");

    for (const [path, expectedLocation] of [
      ["/en", `${ORIGIN}/`],
      ["/en/", `${ORIGIN}/`],
      ["/en/browse?page=2", `${ORIGIN}/browse?page=2`],
    ] as const) {
      const request = new NextRequest(`${ORIGIN}${path}`, { headers: { host: SITE_HOST } });
      const response = proxy(request);
      expect(response.status, path).toBe(308);
      const location = response.headers.get("location");
      expect(location, path).toBe(expectedLocation);
      expect(location).not.toMatch(/localhost|127\.0\.0\.1|:3000/);
    }
  });

  it("L2: never redirects a protocol-relative or backslash-prefixed /en/* remainder off-origin, even though NextRequest itself does not normalize `//`/`\\` out of the pathname", async () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const { proxy } = await import("@/proxy");

    for (const path of ["/en//evil.com/x", "/en/\\evil.com"]) {
      const request = new NextRequest(`${ORIGIN}${path}`, { headers: { host: SITE_HOST } });
      // Confirms the premise this guard defends against: a crafted request
      // really can reach `proxy()` with an un-normalized `//`/`\` pathname
      // (see `buildDefaultLocaleRedirectTarget`'s doc comment) — this is
      // not a hypothetical input.
      expect(request.nextUrl.pathname, path).toMatch(/^\/en[/\\]/);
      const response = proxy(request);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });

  it("does not redirect /enterprise, /ja/browse, /sitemap.xml, /robots.txt, or /api/health — all pass through unredirected", async () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const { proxy } = await import("@/proxy");
    for (const path of ["/enterprise", "/ja/browse", "/sitemap.xml", "/robots.txt", "/api/health"]) {
      const request = new NextRequest(`${ORIGIN}${path}`, { headers: { host: SITE_HOST } });
      const response = proxy(request);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });

  it("admin-host isolation's 404 takes priority — /en/* on the admin host is denied, never redirected", async () => {
    vi.stubEnv("SITE_URL", ORIGIN);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const { proxy } = await import("@/proxy");
    const request = new NextRequest(`https://${ADMIN_HOST}/en/browse`, { headers: { host: ADMIN_HOST } });
    const response = proxy(request);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  it("fails closed (no redirect, no crash) when SITE_URL is misconfigured — /en/* just falls through unredirected", async () => {
    vi.stubEnv("SITE_URL", "");
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const { proxy } = await import("@/proxy");
    const request = new NextRequest(`${ORIGIN}/en/browse`, { headers: { host: SITE_HOST } });
    const response = proxy(request);
    // siteHost resolves to null when SITE_URL is unset, so the admin-host
    // evaluation's "unrecognised host" branch still allows public paths —
    // this reaches the redirect attempt, `getSiteUrl()` throws building the
    // absolute Location, and the proxy falls back to `NextResponse.next()`
    // rather than crashing the request or leaking a bad Location.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
