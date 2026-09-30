import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isAdminPath } from "@/lib/site/admin-origin";

import {
  PROBE_ADMIN_API,
  PROBE_ADMIN_PAGES,
  PROBE_AUTH_PAGES,
  buildProbes,
  classify,
  expectAdminApiUnauthenticated,
  expectAdminPageUnauthenticated,
  expectNoContentServed,
  expectProxyDenialSignature,
  expectPublicAdminPath404,
  isGuardRedirect,
  parseRawResponse,
  pathVariants,
} from "../../../scripts/security/next-proxy-probe.mjs";

/**
 * scripts/security/next-proxy-probe.mjs is the black-box regression guard for the
 * Next.js "Middleware / Proxy bypass" advisories against src/proxy.ts (Next 16.1.6 -> 16.3.3
 * security upgrade). The live run is scripts/run-next-proxy-probe-verification.sh; this file
 * pins the parts that do not need a server: that the matrix cannot silently drift away from the
 * real admin surface, and that the verdict functions say what they claim.
 */

const ROOT = resolve(import.meta.dirname, "../../..");

function response(status: number, options: { headers?: Record<string, string>; body?: string } = {}) {
  return { status, headers: options.headers ?? {}, rawHeaders: [], body: options.body ?? "" };
}

const GUARD_META =
  '<html><head><meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/login?next=%2Fnovels"/></head><body></body></html>';

describe("next-proxy-probe matrix stays aligned with the real admin surface", () => {
  it("only probes paths that src/proxy.ts's isAdminPath classifies as admin", () => {
    for (const path of [...PROBE_ADMIN_PAGES, ...PROBE_AUTH_PAGES, ...PROBE_ADMIN_API]) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });

  it("probes every top-level directory of the (admin) route group, so a new admin page cannot dodge the matrix", () => {
    const adminDir = join(ROOT, "src/app/(admin)");
    const roots = readdirSync(adminDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
      .map((entry) => `/${entry.name}`);
    expect(roots.length).toBeGreaterThan(5);
    for (const root of roots) {
      expect(PROBE_ADMIN_PAGES, `admin page root ${root} is not in PROBE_ADMIN_PAGES`).toContain(root);
    }
  });

  it("covers a dynamic admin route (the shape the parameter-injection advisory is about)", () => {
    expect(PROBE_ADMIN_PAGES.some((path) => /\/novels\/[0-9a-f-]{36}$/.test(path))).toBe(true);
    expect(PROBE_ADMIN_PAGES.some((path) => /\/tasks\/[0-9a-f-]{36}$/.test(path))).toBe(true);
  });

  it("generates the transport variants each advisory family describes", () => {
    const names = pathVariants("/novels", "BUILD").map((variant) => variant.name);
    for (const expected of [
      "plain",
      "rsc-suffix",
      "rsc-header-only",
      "segment-tree",
      "segment-page",
      "segment-header-only",
      "next-data",
      "next-data-header-only",
      "query-nxtP",
      "query-nextDataReq",
      "percent-encoded-slash",
      "under-next-static",
      "hdr-x-matched-path",
      "hdr-x-middleware-subrequest",
    ]) {
      expect(names, expected).toContain(expected);
    }
    const segment = pathVariants("/novels", "BUILD").find((variant) => variant.name === "segment-tree");
    expect(segment?.target).toBe("/novels.segments/_tree.segment.rsc");
  });

  it("builds a matrix with unique ids, controls, and the GHSA-3g8h redirect-integrity probes", () => {
    const probes = buildProbes({ buildId: "BUILD" });
    const ids = probes.map((probe: { id: string }) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(probes.length).toBeGreaterThan(1000);
    expect(probes.filter((probe: { group: string }) => probe.group === "control").length).toBeGreaterThanOrEqual(10);
    const redirect = probes.filter((probe: { group: string }) => probe.group === "proxy-redirect-integrity");
    expect(redirect.length).toBeGreaterThanOrEqual(3);
    for (const probe of redirect) expect(probe.noFollow).toBe(true);
    expect(probes.some((probe: { id: string }) => probe.id.startsWith("bearer/admin-page/"))).toBe(true);
  });

  it("uses the requested build id for Pages-Router-style data URLs", () => {
    const probes = buildProbes({ buildId: "abc123" });
    expect(probes.some((probe: { target: string }) => probe.target.startsWith("/_next/data/abc123/"))).toBe(true);
  });
});

describe("next-proxy-probe verdict functions", () => {
  it("public host + admin path: only a 404 passes; a page-guard redirect or a served page is a bypass", () => {
    expect(expectPublicAdminPath404(response(404))).toBeNull();
    expect(expectPublicAdminPath404(response(404, { body: "<html>not found</html>" }))).toBeNull();
    expect(expectPublicAdminPath404(response(307, { headers: { location: "/login?next=%2Fnovels" } }))).toMatch(/reached an admin path/);
    expect(expectPublicAdminPath404(response(200, { body: GUARD_META }))).toMatch(/reached an admin path/);
    expect(expectPublicAdminPath404(response(500))).toMatch(/reached an admin path/);
  });

  it("proxy denial signature is the bare empty 404, not Next's own not-found page", () => {
    expect(expectProxyDenialSignature(response(404))).toBeNull();
    expect(expectProxyDenialSignature(response(404, { body: "<html>not found</html>" }))).toMatch(/bare 404/);
    expect(expectProxyDenialSignature(response(200))).toMatch(/bare 404/);
  });

  it("recognises both transports of the page guard's no-session answer", () => {
    expect(isGuardRedirect(response(307, { headers: { location: "/login?next=%2Fsettings" } }))).toBe(true);
    expect(isGuardRedirect(response(308, { headers: { location: "https://zbcwf.novel.test/two-factor/setup" } }))).toBe(true);
    expect(isGuardRedirect(response(200, { body: GUARD_META }))).toBe(true);
    expect(isGuardRedirect(response(200, { body: "<html>plain page</html>" }))).toBe(false);
    expect(isGuardRedirect(response(307, { headers: { location: "/somewhere-else" } }))).toBe(false);
  });

  it("admin host + protected page without a session: redirect/404/401 pass, content and 5xx fail", () => {
    expect(expectAdminPageUnauthenticated(response(307, { headers: { location: "/login?next=%2Ftasks" } }))).toBeNull();
    expect(expectAdminPageUnauthenticated(response(200, { body: GUARD_META }))).toBeNull();
    expect(expectAdminPageUnauthenticated(response(404))).toBeNull();
    expect(expectAdminPageUnauthenticated(response(200, { body: "{}" }))).toBeNull();
    expect(expectAdminPageUnauthenticated(response(200, { body: "<main>tasks table</main>" }))).toMatch(/was served/);
    const flight = (body: string) => response(200, { headers: { "content-type": "text/x-component" }, body });
    const adminTree = '0:{"f":[[["",{"children":["(admin)",{"children":["tasks",{}]}]}]]]}';
    expect(expectAdminPageUnauthenticated(flight(`${adminTree} NEXT_REDIRECT`), { requestHeaders: [["RSC", "1"]] })).toBeNull();
    expect(expectAdminPageUnauthenticated(flight(adminTree), { requestHeaders: [["RSC", "1"], ["Next-Router-Prefetch", "1"]] })).toBeNull();
    expect(expectAdminPageUnauthenticated(flight('0:{"f":[[["",{"children":[["locale","x","d"],{}]}]]]}'), { requestHeaders: [["RSC", "1"]] })).toBeNull();
    expect(expectAdminPageUnauthenticated(flight(adminTree), { requestHeaders: [["RSC", "1"]] })).toMatch(/without the guard/);
    expect(expectAdminPageUnauthenticated(response(500))).toMatch(/server error/);
    expect(expectAdminPageUnauthenticated(response(307, { headers: { location: "/elsewhere" } }))).toMatch(/unexpected place/);
  });

  it("admin API without a session: 401/403/404/405 pass, 2xx data and 5xx fail", () => {
    expect(expectAdminApiUnauthenticated(response(401))).toBeNull();
    expect(expectAdminApiUnauthenticated(response(403))).toBeNull();
    expect(expectAdminApiUnauthenticated(response(200, { body: '{"data":[1]}' }))).toMatch(/answered/);
    expect(expectAdminApiUnauthenticated(response(500))).toMatch(/answered/);
  });

  it("malformed request shapes: 404 or a redirect is fine, served content is not", () => {
    expect(expectNoContentServed(response(404))).toBeNull();
    expect(expectNoContentServed(response(308, { headers: { location: "/x" } }))).toBeNull();
    expect(expectNoContentServed(response(200, { body: "x" }))).toMatch(/unexpected answer/);
  });

  it("classify labels a redirect that lost its Location (the GHSA-3g8h symptom) distinctly", () => {
    expect(classify(response(308, { headers: { "x-nextjs-redirect": "https://novel.test/browse" } }))).toContain("LOCATION-LOST");
    expect(classify(response(308, { headers: { location: "/browse" } }))).toBe("308->/browse");
    expect(classify(response(404))).toContain("proxy-deny-signature");
  });

  it("GHSA-3g8h probe fails on a Location-less 308 and passes on a healthy one", () => {
    const probes = buildProbes({ buildId: "BUILD" });
    const probe = probes.find((candidate: { id: string }) => candidate.id === "redirect/en-prefix-with-x-nextjs-data");
    if (!probe) throw new Error("GHSA-3g8h probe missing from the matrix");
    const lost = response(308, { headers: { "x-nextjs-redirect": "https://novel.test/browse?x=1" } });
    const healthy = response(308, { headers: { location: "https://novel.test/browse?x=1" } });
    expect(probe.check(lost, {})).toMatch(/changed the proxy redirect/);
    expect(probe.check(healthy, {})).toBeNull();
  });
});

describe("parseRawResponse", () => {
  it("parses status, headers (case-insensitive, duplicates joined) and a chunked body", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nset-cookie: b=2\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
      "latin1",
    );
    const parsed = parseRawResponse(raw);
    const headers = parsed.headers as Record<string, string>;
    expect(parsed.status).toBe(200);
    expect(headers["content-type"]).toBe("text/plain");
    expect(headers["set-cookie"]).toBe("a=1, b=2");
    expect(parsed.body).toBe("hello world");
  });

  it("returns status 0 rather than throwing on a truncated response", () => {
    expect(parseRawResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-", "latin1")).status).toBe(0);
  });
});
