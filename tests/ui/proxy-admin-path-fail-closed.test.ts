import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  evaluateAdminHostAccess,
  isAdminPath,
  type AdminHostAccessConfig,
} from "@/lib/site/admin-origin";
import {
  isNormalizableAdminPath,
  resolveAdminPage,
  resolveAdminRoute,
} from "@/server/auth/registry";

/**
 * B-24 (2026-10-01): `isAdminPath` must be fail-closed.
 *
 * `resolveAdminPage` returns `null` both for "normalised fine, matches no admin root" (a public path) and for
 * "`normalizePath` could not normalise it at all" (a backslash, `%2f`/`%5c` in any case, a `.`/`..` segment, a
 * malformed percent sequence). `isAdminPath` used to read the second `null` as "public", so on the public host
 * `/novels/<id>%2f`, `/novels/<id>%5c`, `/tasks/<id>%2f` ... passed the proxy gate and reached the dynamic admin
 * routes (the page guard and nginx's admin-root regex were the only things left in the way).
 *
 * The rule pinned here: a path the registry cannot normalise is never public. It counts as an admin path (404 on the
 * public / unrecognised host), and the admin host 404s it as well (it serves only provable admin paths, RC-9).
 */

const SITE_HOST = "pulsenovels.com";
const ADMIN_HOST = "zbcwf.pulsenovels.com";
const DISTINCT_CONFIG: AdminHostAccessConfig = {
  siteHost: SITE_HOST,
  adminHostResolution: { ok: true, host: ADMIN_HOST },
};
const UUID = "00000000-0000-0000-0000-000000000000";

/** Prefixes under the admin roots and under unrelated public paths. */
const ADMIN_PREFIXES = [
  "/novels",
  "/tasks",
  "/settings",
  `/novels/${UUID}`,
  `/tasks/${UUID}`,
  "/login",
  "/two-factor/challenge",
  "/api/admin/tasks",
];
const PUBLIC_PREFIXES = [
  "/",
  "/browse",
  "/ko/novel/%EC%84%9C%EC%9A%B8-p1234abcd",
  "/novel/some-slug-p1234abcd",
  "/sitemap/site_mainpage_ko.xml",
  "/foo",
];

/** How a path becomes un-normalisable, given a prefix. `\\` is a single literal backslash. */
const AMBIGUOUS_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["lowercase encoded slash", "%2f"],
  ["uppercase encoded slash", "%2F"],
  ["lowercase encoded backslash", "%5c"],
  ["uppercase encoded backslash", "%5C"],
  ["literal backslash", "\\"],
  ["dot segment", "/./x"],
  ["dot-dot segment", "/../x"],
  ["malformed percent sequence", "/%E0%A4%A"],
  ["malformed percent sequence glued to the segment", "%E0%A4%A"],
  ["lone percent", "%"],
  ["encoded slash mid-segment", "%2fx"],
];

function ambiguousPaths(prefixes: readonly string[]): string[] {
  const paths: string[] = [];
  for (const prefix of prefixes) {
    for (const [, suffix] of AMBIGUOUS_SUFFIXES) {
      // "/" + suffix must not produce "//" (which normalises fine); everything else is appended as-is.
      paths.push(prefix === "/" ? `/x${suffix}` : `${prefix}${suffix}`);
    }
  }
  return paths;
}

describe("isNormalizableAdminPath", () => {
  it("is false for every shape normalizePath() rejects, regardless of case or position", () => {
    for (const path of [...ambiguousPaths(ADMIN_PREFIXES), ...ambiguousPaths(PUBLIC_PREFIXES)]) {
      expect(isNormalizableAdminPath(path), path).toBe(false);
    }
    expect(isNormalizableAdminPath("novels")).toBe(false); // no leading slash
    expect(isNormalizableAdminPath("")).toBe(false);
  });

  it("is true for ordinary admin paths, public paths and valid percent-encoded non-ASCII paths", () => {
    for (const path of [
      "/",
      "/novels",
      `/novels/${UUID}`,
      "/NOVELS/X",
      "/%6Eovels", // %6E decodes to "n": still a normal, classifiable admin path
      "/api/admin/tasks",
      "/ko/novel/%EC%84%9C%EC%9A%B8%EC%9D%98-%EB%B4%84-p1234abcd",
      "/ja/novel/%E6%9D%B1%E4%BA%AC-p1234abcd",
      "/ko/novel/서울의-봄-p1234abcd", // un-encoded non-ASCII is fine too
      "/sitemap/site_mainpage_ko.xml",
      "/.well-known/security.txt", // ".well-known" is not a "." segment
      "/novels//x", // doubled slash collapses, it does not fail
    ]) {
      expect(isNormalizableAdminPath(path), path).toBe(true);
    }
  });
});

describe("isAdminPath — fail-closed for paths the registry cannot normalise (B-24)", () => {
  it("is true for every ambiguous variant under an admin root", () => {
    for (const path of ambiguousPaths(ADMIN_PREFIXES)) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });

  it("is also true under unrelated / public prefixes — an un-normalisable path is never public", () => {
    for (const path of ambiguousPaths(PUBLIC_PREFIXES)) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });

  it("covers the exact shapes from the B-24 finding", () => {
    for (const path of [
      `/novels/${UUID}%2f`,
      `/novels/${UUID}%2F`,
      `/novels/${UUID}%5c`,
      `/novels/${UUID}%5C`,
      `/novels/${UUID}\\`,
      `/tasks/${UUID}%2f`,
      `/tasks/${UUID}%5c`,
      "/novels/./x",
      "/tasks/../x",
      "/novels/%E0%A4%A",
    ]) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });

  it("leaves classifiable paths exactly as before: admin roots true, public paths false", () => {
    for (const path of [
      "/dashboard",
      "/novels",
      `/novels/${UUID}`,
      `/tasks/${UUID}`,
      "/NOVELS/x",
      "/novels/",
      "/novels//x",
      "/%6Eovels", // decodes to an admin root, as before
      "/login",
      "/two-factor/setup",
      "/api/admin",
      "/api/admin/tasks/retry-failed",
    ]) {
      expect(isAdminPath(path), path).toBe(true);
    }
    for (const path of [
      "/",
      "/browse",
      "/browse/",
      "/novel/some-slug-p1234abcd",
      "/ko/novel/%EC%84%9C%EC%9A%B8%EC%9D%98-%EB%B4%84-p1234abcd",
      "/ja/novel/%E6%9D%B1%E4%BA%AC%E3%81%AE%E7%A9%BA-p1234abcd",
      "/ru/novel/%D0%BB%D1%8E%D0%B1%D0%BE%D0%B2%D1%8C-p1234abcd",
      "/ko/novel/서울의-봄-p1234abcd",
      "/sitemap.xml",
      "/sitemap/site_mainpage_ko.xml",
      "/robots.txt",
      "/icon",
      "/apple-icon",
      "/api/health",
      "/api/health/worker",
      "/go/abc123",
      "/novelsfoo", // shares a prefix with /novels but is a different segment
      "/logout",
    ]) {
      expect(isAdminPath(path), path).toBe(false);
    }
  });
});

describe("the registry's authorisation-side semantics are untouched", () => {
  it("resolveAdminPage / resolveAdminRoute still answer null for an un-normalisable path (isAdminPath is the only fail-closed exit)", () => {
    for (const path of [`/novels/${UUID}%2f`, `/novels/${UUID}%5C`, "/novels/./x", "/novels/%E0%A4%A", `/tasks/${UUID}\\`]) {
      expect(resolveAdminPage(path), path).toBeNull();
    }
    expect(resolveAdminRoute("/api/admin/tasks%2f", "GET")).toBeNull();
    expect(resolveAdminRoute("/api/admin/tasks\\", "GET")).toBeNull();
  });

  it("resolveAdminPage still resolves classifiable paths to their root", () => {
    expect(resolveAdminPage("/novels")).toBe("/novels");
    expect(resolveAdminPage(`/novels/${UUID}`)).toBe("/novels");
    expect(resolveAdminPage("/TASKS/x")).toBe("/tasks");
    expect(resolveAdminPage("/browse")).toBeNull();
  });
});

describe("evaluateAdminHostAccess — an un-normalisable path is a 404 on every host", () => {
  const evaluate = (requestHostHeader: string | null, pathname: string, config = DISTINCT_CONFIG, nodeEnv = "production") =>
    evaluateAdminHostAccess({ requestHostHeader, pathname, nodeEnv }, config);

  it("public host: denied (the B-24 hole), for admin-root and for unrelated prefixes alike", () => {
    for (const path of [...ambiguousPaths(ADMIN_PREFIXES), ...ambiguousPaths(PUBLIC_PREFIXES)]) {
      expect(evaluate(SITE_HOST, path), path).toEqual({ allow: false, sameOriginProductionMisconfig: false });
    }
  });

  it("unrecognised / missing host, unresolved admin host, unresolved site host: denied", () => {
    const path = `/novels/${UUID}%2f`;
    for (const host of ["evil.example", null, ""]) {
      expect(evaluate(host, path), String(host)).toEqual({ allow: false, sameOriginProductionMisconfig: false });
    }
    expect(
      evaluate(SITE_HOST, path, { siteHost: SITE_HOST, adminHostResolution: { ok: false, reason: "missing" } }),
    ).toEqual({ allow: false, sameOriginProductionMisconfig: false });
    expect(
      evaluate(SITE_HOST, path, { siteHost: null, adminHostResolution: { ok: true, host: ADMIN_HOST } }),
    ).toEqual({ allow: false, sameOriginProductionMisconfig: false });
  });

  it("admin host: denied as well — it serves only provable admin paths, so a public-looking ambiguous URL never reaches the public route tree there", () => {
    for (const path of [...ambiguousPaths(ADMIN_PREFIXES), ...ambiguousPaths(PUBLIC_PREFIXES)]) {
      expect(evaluate(ADMIN_HOST, path), path).toEqual({ allow: false, sameOriginProductionMisconfig: false });
    }
    // ... while the same admin roots without the ambiguity are still served there.
    for (const path of [`/novels/${UUID}`, `/tasks/${UUID}`, "/login", "/api/admin/tasks"]) {
      expect(evaluate(ADMIN_HOST, path), path).toEqual({ allow: true, sameOriginProductionMisconfig: false });
    }
  });

  it("same-origin production misconfiguration: still denied, and still flagged", () => {
    const sameOrigin: AdminHostAccessConfig = { siteHost: SITE_HOST, adminHostResolution: { ok: true, host: SITE_HOST } };
    expect(evaluate(SITE_HOST, `/novels/${UUID}%2f`, sameOrigin)).toEqual({ allow: false, sameOriginProductionMisconfig: true });
  });

  it("same-origin non-production dev fallback is unchanged: everything allowed", () => {
    const sameOrigin: AdminHostAccessConfig = { siteHost: SITE_HOST, adminHostResolution: { ok: true, host: SITE_HOST } };
    for (const nodeEnv of ["development", "test"]) {
      expect(evaluate(SITE_HOST, `/novels/${UUID}%2f`, sameOrigin, nodeEnv)).toEqual({ allow: true, sameOriginProductionMisconfig: false });
    }
  });

  it("shared /api/health paths are decided first and stay open on every host", () => {
    for (const host of [SITE_HOST, ADMIN_HOST, "evil.example", null]) {
      expect(evaluate(host, "/api/health"), String(host)).toEqual({ allow: true, sameOriginProductionMisconfig: false });
      expect(evaluate(host, "/api/health/worker"), String(host)).toEqual({ allow: true, sameOriginProductionMisconfig: false });
    }
  });

  it("legitimate public paths stay allowed on the public host", () => {
    for (const path of [
      "/",
      "/browse",
      "/ko/novel/%EC%84%9C%EC%9A%B8%EC%9D%98-%EB%B4%84-p1234abcd",
      "/ja/novel/%E6%9D%B1%E4%BA%AC%E3%81%AE%E7%A9%BA-p1234abcd",
      "/sitemap.xml",
      "/sitemap/site_mainpage_ko.xml",
      "/robots.txt",
      "/icon",
      "/apple-icon",
      "/go/abc123",
    ]) {
      expect(evaluate(SITE_HOST, path), path).toEqual({ allow: true, sameOriginProductionMisconfig: false });
    }
  });
});

describe("src/proxy.ts end to end — NextRequest/NextResponse", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function loadProxy() {
    vi.stubEnv("SITE_URL", `https://${SITE_HOST}`);
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
    vi.stubEnv("NODE_ENV", "production");
    return (await import("@/proxy")).proxy;
  }

  function request(host: string, pathAndQuery: string): NextRequest {
    return new NextRequest(`https://${host}${pathAndQuery}`, { headers: { host } });
  }

  it("public host: the B-24 shapes are the proxy's own bare 404 (empty body, no Location)", async () => {
    const proxy = await loadProxy();
    for (const path of [
      `/novels/${UUID}%2f`,
      `/novels/${UUID}%2F`,
      `/novels/${UUID}%5c`,
      `/novels/${UUID}%5C`,
      `/tasks/${UUID}%2f`,
      `/tasks/${UUID}%5c`,
      `/novels%2f`,
      `/novels/%E0%A4%A`,
      `/api/admin/tasks%2f`,
      `/login%5c`,
      `/ko/novel/x%2f`,
    ]) {
      const response = proxy(request(SITE_HOST, path));
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.body, path).toBeNull();
    }
  });

  it("admin host: the same shapes are a bare 404 too, not a page-guard bounce and not the public tree", async () => {
    const proxy = await loadProxy();
    for (const path of [`/novels/${UUID}%2f`, `/tasks/${UUID}%5c`, `/ko/novel/x%2f`, "/novels/%E0%A4%A"]) {
      const response = proxy(request(ADMIN_HOST, path));
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
    }
    expect(proxy(request(ADMIN_HOST, `/novels/${UUID}`)).status).toBe(200);
    expect(proxy(request(ADMIN_HOST, "/login")).status).toBe(200);
  });

  it("public host: ordinary public URLs are untouched — percent-encoded Korean/Japanese/Russian slugs, query strings, sitemap, icons, robots, health", async () => {
    const proxy = await loadProxy();
    for (const pathAndQuery of [
      "/ko/novel/%EC%84%9C%EC%9A%B8%EC%9D%98-%EB%B4%84-p1234abcd",
      "/ko/novel/%EC%84%9C%EC%9A%B8%EC%9D%98-%EB%B4%84-p1234abcd?utm_source=x&q=%E3%81%82",
      "/ja/novel/%E6%9D%B1%E4%BA%AC%E3%81%AE%E7%A9%BA-p1234abcd",
      "/ru/novel/%D0%BB%D1%8E%D0%B1%D0%BE%D0%B2%D1%8C-p1234abcd",
      "/ja/browse?page=2&q=%E3%81%82",
      "/browse?page=2",
      "/ko/browse",
      "/sitemap.xml",
      "/sitemap/site_mainpage_ko.xml",
      "/sitemap/site_novelpage_ja_2.xml?x=1",
      "/api/health",
      "/api/health/worker",
      "/icon",
      "/apple-icon",
      "/robots.txt",
      "/go/abc123",
    ]) {
      const response = proxy(request(SITE_HOST, pathAndQuery));
      expect(response.status, pathAndQuery).toBe(200);
    }
  });

  it("the percent-encoded non-ASCII slug reaches Next with its path untouched (no decode, no rewrite)", async () => {
    const proxy = await loadProxy();
    const response = proxy(request(SITE_HOST, "/ko/novel/%EC%84%9C%EC%9A%B8%EC%9D%98-%EB%B4%84-p1234abcd?q=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-novel-locale")).toBe("ko");
  });
});
