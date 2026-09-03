import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_HOST_PATH_ROOTS,
  evaluateAdminHostAccess,
  isAdminPath,
  normalizeRequestHost,
  readAdminCanonicalOrigin,
  resolveAdminHost,
  type AdminHostAccessConfig,
} from "@/lib/site/admin-origin";
import { ADMIN_PAGE_ROOTS } from "@/server/auth/registry";

/**
 * RC-9 admin-host isolation (2026-09-03, Owner).
 *
 * Covers the full rule table from `src/lib/site/admin-origin.ts` /
 * `src/proxy.ts`: which host a request arrived on decides whether an admin
 * path is reachable, never which nginx `location` happened to match first —
 * that is the exact defect Owner flagged on the public short-drama sister
 * site (its public domain can open the admin login page).
 */

const root = resolve(import.meta.dirname, "../..");
const proxySource = readFileSync(resolve(root, "src/proxy.ts"), "utf8");
const adminOriginSource = readFileSync(resolve(root, "src/lib/site/admin-origin.ts"), "utf8");
const depsSource = readFileSync(resolve(root, "src/app/api/admin/_lib/deps.ts"), "utf8");

const SITE_HOST = "pulsenovels.com";
const ADMIN_HOST = "zbcwf.pulsenovels.com";
const ADMIN_OK: AdminHostAccessConfig["adminHostResolution"] = { ok: true, host: ADMIN_HOST };
const DISTINCT_CONFIG: AdminHostAccessConfig = { siteHost: SITE_HOST, adminHostResolution: ADMIN_OK };

describe("isAdminPath — single source derived from ADMIN_PAGE_ROOTS", () => {
  it("is true for every ADMIN_PAGE_ROOTS entry, /login, /two-factor, and /api/admin", () => {
    for (const root of ADMIN_PAGE_ROOTS) {
      expect(isAdminPath(root), root).toBe(true);
      expect(isAdminPath(`${root}/sub-page`), `${root}/sub-page`).toBe(true);
    }
    expect(isAdminPath("/login")).toBe(true);
    expect(isAdminPath("/two-factor")).toBe(true);
    expect(isAdminPath("/two-factor/challenge")).toBe(true);
    expect(isAdminPath("/two-factor/setup")).toBe(true);
    expect(isAdminPath("/api/admin")).toBe(true);
    expect(isAdminPath("/api/admin/x")).toBe(true);
    expect(isAdminPath("/api/admin/tasks/retry-failed")).toBe(true);
  });

  it("is false for public paths, including the ones that share a nearby prefix", () => {
    for (const publicPath of [
      "/",
      "/browse",
      "/novel/some-slug",
      "/novel/some-slug/chapter/1",
      "/go/abc123",
      "/sitemap.xml",
      "/robots.txt",
      "/indexnow-key.txt",
      "/api/health",
      "/api/health/worker",
      "/dev-preview/chapter/1",
      "/logout",
    ]) {
      expect(isAdminPath(publicPath), publicPath).toBe(false);
    }
  });

  it("has exactly ADMIN_PAGE_ROOTS plus /login, /two-factor, and /api/admin — no second literal list", () => {
    expect(new Set(ADMIN_HOST_PATH_ROOTS)).toEqual(
      new Set([...ADMIN_PAGE_ROOTS, "/login", "/two-factor", "/api/admin"]),
    );
  });
});

describe("readAdminCanonicalOrigin — stays textually aligned with deps.ts's canonicalOrigin()", () => {
  it("reads process.env.ADMIN_CANONICAL_ORIGIN the same way deps.ts does", () => {
    expect(adminOriginSource).toContain('env.ADMIN_CANONICAL_ORIGIN?.trim() ?? ""');
    expect(depsSource).toContain('process.env.ADMIN_CANONICAL_ORIGIN?.trim() ?? ""');
  });

  it("defaults to reading the real process.env.ADMIN_CANONICAL_ORIGIN and trims it", () => {
    const original = process.env.ADMIN_CANONICAL_ORIGIN;
    try {
      process.env.ADMIN_CANONICAL_ORIGIN = "  https://zbcwf.pulsenovels.com  ";
      expect(readAdminCanonicalOrigin()).toBe("https://zbcwf.pulsenovels.com");
      delete process.env.ADMIN_CANONICAL_ORIGIN;
      expect(readAdminCanonicalOrigin()).toBe("");
    } finally {
      if (original === undefined) delete process.env.ADMIN_CANONICAL_ORIGIN;
      else process.env.ADMIN_CANONICAL_ORIGIN = original;
    }
  });
});

describe("resolveAdminHost", () => {
  it("parses a valid https origin to a lowercase hostname, ignoring case", () => {
    expect(resolveAdminHost("https://ZBCWF.PulseNovels.com")).toEqual({ ok: true, host: "zbcwf.pulsenovels.com" });
    expect(resolveAdminHost("https://zbcwf.novel.test")).toEqual({ ok: true, host: "zbcwf.novel.test" });
  });

  it("is missing on empty/unset input", () => {
    expect(resolveAdminHost("")).toEqual({ ok: false, reason: "missing" });
  });

  it("is invalid on credentials, path, query, fragment, or non-http(s) scheme", () => {
    for (const bad of [
      "not-a-url",
      "ftp://zbcwf.pulsenovels.com",
      "https://user:pass@zbcwf.pulsenovels.com",
      "https://zbcwf.pulsenovels.com/admin",
      "https://zbcwf.pulsenovels.com?x=1",
      "https://zbcwf.pulsenovels.com#frag",
    ]) {
      expect(resolveAdminHost(bad), bad).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("normalizeRequestHost", () => {
  it("strips a port and lowercases", () => {
    expect(normalizeRequestHost("Zbcwf.PulseNovels.com:8443")).toBe("zbcwf.pulsenovels.com");
    expect(normalizeRequestHost("pulsenovels.com")).toBe("pulsenovels.com");
  });

  it("returns null for empty/missing input", () => {
    expect(normalizeRequestHost(null)).toBeNull();
    expect(normalizeRequestHost(undefined)).toBeNull();
    expect(normalizeRequestHost("")).toBeNull();
    expect(normalizeRequestHost("   ")).toBeNull();
  });
});

describe("evaluateAdminHostAccess — full rule table, distinct admin/site hosts", () => {
  it("admin host: allows admin paths, 404s everything else", () => {
    for (const pathname of ["/dashboard", "/login", "/two-factor/challenge", "/api/admin/tasks"]) {
      expect(
        evaluateAdminHostAccess({ requestHostHeader: ADMIN_HOST, pathname, nodeEnv: "production" }, DISTINCT_CONFIG),
      ).toEqual({ allow: true, sameOriginProductionMisconfig: false });
    }
    for (const pathname of ["/", "/browse", "/novel/x", "/sitemap.xml", "/robots.txt"]) {
      expect(
        evaluateAdminHostAccess({ requestHostHeader: ADMIN_HOST, pathname, nodeEnv: "production" }, DISTINCT_CONFIG),
      ).toEqual({ allow: false, sameOriginProductionMisconfig: false });
    }
  });

  it("site host: allows public paths, 404s admin paths", () => {
    for (const pathname of ["/", "/browse", "/novel/x"]) {
      expect(
        evaluateAdminHostAccess({ requestHostHeader: SITE_HOST, pathname, nodeEnv: "production" }, DISTINCT_CONFIG),
      ).toEqual({ allow: true, sameOriginProductionMisconfig: false });
    }
    for (const pathname of ["/dashboard", "/login", "/two-factor/challenge", "/api/admin/tasks"]) {
      expect(
        evaluateAdminHostAccess({ requestHostHeader: SITE_HOST, pathname, nodeEnv: "production" }, DISTINCT_CONFIG),
      ).toEqual({ allow: false, sameOriginProductionMisconfig: false });
    }
  });

  it("other/missing host: same fail-closed shape as the site host", () => {
    for (const requestHostHeader of ["evil.example", null, ""]) {
      expect(
        evaluateAdminHostAccess({ requestHostHeader, pathname: "/dashboard", nodeEnv: "production" }, DISTINCT_CONFIG),
      ).toEqual({ allow: false, sameOriginProductionMisconfig: false });
      expect(
        evaluateAdminHostAccess({ requestHostHeader, pathname: "/", nodeEnv: "production" }, DISTINCT_CONFIG),
      ).toEqual({ allow: true, sameOriginProductionMisconfig: false });
    }
  });

  it("shared paths (/api/health*) pass on every host, admin or not", () => {
    for (const requestHostHeader of [ADMIN_HOST, SITE_HOST, "evil.example", null]) {
      for (const pathname of ["/api/health", "/api/health/worker", "/api/health/backup"]) {
        expect(
          evaluateAdminHostAccess({ requestHostHeader, pathname, nodeEnv: "production" }, DISTINCT_CONFIG),
        ).toEqual({ allow: true, sameOriginProductionMisconfig: false });
      }
    }
  });

  it("Host header comparison ignores a port (X8 runs 443, but this must hold generally)", () => {
    expect(
      evaluateAdminHostAccess(
        { requestHostHeader: `${ADMIN_HOST}:8443`, pathname: "/dashboard", nodeEnv: "production" },
        DISTINCT_CONFIG,
      ),
    ).toEqual({ allow: true, sameOriginProductionMisconfig: false });
  });
});

describe("evaluateAdminHostAccess — adminHost missing/invalid (fail-closed everywhere)", () => {
  it("blocks admin paths on every host when ADMIN_CANONICAL_ORIGIN is unset", () => {
    const config: AdminHostAccessConfig = { siteHost: SITE_HOST, adminHostResolution: { ok: false, reason: "missing" } };
    for (const requestHostHeader of [SITE_HOST, ADMIN_HOST, "evil.example", null]) {
      expect(
        evaluateAdminHostAccess({ requestHostHeader, pathname: "/dashboard", nodeEnv: "production" }, config),
      ).toEqual({ allow: false, sameOriginProductionMisconfig: false });
    }
    expect(
      evaluateAdminHostAccess({ requestHostHeader: SITE_HOST, pathname: "/", nodeEnv: "production" }, config),
    ).toEqual({ allow: true, sameOriginProductionMisconfig: false });
  });

  it("blocks admin paths on every host when ADMIN_CANONICAL_ORIGIN is malformed", () => {
    const config: AdminHostAccessConfig = { siteHost: SITE_HOST, adminHostResolution: { ok: false, reason: "invalid" } };
    expect(
      evaluateAdminHostAccess({ requestHostHeader: SITE_HOST, pathname: "/dashboard", nodeEnv: "production" }, config),
    ).toEqual({ allow: false, sameOriginProductionMisconfig: false });
  });
});

describe("evaluateAdminHostAccess — siteHost unresolved (SITE_URL broken)", () => {
  it("still fail-closes admin paths, without breaking public traffic on the admin host mismatch", () => {
    const config: AdminHostAccessConfig = { siteHost: null, adminHostResolution: ADMIN_OK };
    expect(
      evaluateAdminHostAccess({ requestHostHeader: ADMIN_HOST, pathname: "/dashboard", nodeEnv: "production" }, config),
    ).toEqual({ allow: true, sameOriginProductionMisconfig: false });
    expect(
      evaluateAdminHostAccess({ requestHostHeader: ADMIN_HOST, pathname: "/", nodeEnv: "production" }, config),
    ).toEqual({ allow: false, sameOriginProductionMisconfig: false });
    expect(
      evaluateAdminHostAccess({ requestHostHeader: "anything.example", pathname: "/dashboard", nodeEnv: "production" }, config),
    ).toEqual({ allow: false, sameOriginProductionMisconfig: false });
  });
});

describe("evaluateAdminHostAccess — same-origin misconfiguration (production vs. dev fallback)", () => {
  const sameOriginConfig: AdminHostAccessConfig = {
    siteHost: SITE_HOST,
    adminHostResolution: { ok: true, host: SITE_HOST },
  };

  it("production: 404s admin paths on the shared host and flags the misconfiguration", () => {
    expect(
      evaluateAdminHostAccess({ requestHostHeader: SITE_HOST, pathname: "/dashboard", nodeEnv: "production" }, sameOriginConfig),
    ).toEqual({ allow: false, sameOriginProductionMisconfig: true });
  });

  it("production: still allows public paths, but still flags the misconfiguration", () => {
    expect(
      evaluateAdminHostAccess({ requestHostHeader: SITE_HOST, pathname: "/", nodeEnv: "production" }, sameOriginConfig),
    ).toEqual({ allow: true, sameOriginProductionMisconfig: true });
  });

  it.each([undefined, "development", "test"])("non-production (%s): allows everything as a local dev fallback", (nodeEnv) => {
    expect(
      evaluateAdminHostAccess({ requestHostHeader: SITE_HOST, pathname: "/dashboard", nodeEnv }, sameOriginConfig),
    ).toEqual({ allow: true, sameOriginProductionMisconfig: false });
    expect(
      evaluateAdminHostAccess({ requestHostHeader: SITE_HOST, pathname: "/", nodeEnv }, sameOriginConfig),
    ).toEqual({ allow: true, sameOriginProductionMisconfig: false });
  });
});

describe("src/proxy.ts", () => {
  it("only trusts the Host header — never x-forwarded-host (unlike requireSameOrigin, nothing here trusts a forwarded header)", () => {
    expect(proxySource).not.toMatch(/x-forwarded-host/i);
    expect(proxySource).toContain('request.headers.get("host")');
  });

  it("never redirects a denial — a bare status-only 404, so the admin hostname never leaks to a public-host visitor", () => {
    expect(proxySource).not.toMatch(/NextResponse\.redirect/);
    expect(proxySource).toContain("new NextResponse(null, { status: 404 })");
  });

  it("excludes only Next's own static-asset conventions from the matcher — every app/API route still runs through it", () => {
    expect(proxySource).toMatch(/_next\/static/);
    expect(proxySource).toMatch(/_next\/image/);
    expect(proxySource).toMatch(/favicon/);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("denies a request whose Host equals the site origin and whose path is an admin path — end to end via NextRequest/NextResponse", async () => {
    vi.stubEnv("SITE_URL", `https://${SITE_HOST}`);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");

    const { proxy } = await import("@/proxy");
    const request = new NextRequest(`https://${SITE_HOST}/login`, { headers: { host: SITE_HOST } });
    const response = proxy(request);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();

    const allowedRequest = new NextRequest(`https://${ADMIN_HOST}/login`, { headers: { host: ADMIN_HOST } });
    const allowedResponse = proxy(allowedRequest);
    expect(allowedResponse.status).toBe(200);
  });
});
