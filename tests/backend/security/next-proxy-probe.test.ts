import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isAdminPath } from "@/lib/site/admin-origin";

import {
  NAVER_VERIFICATION_GROUP,
  NAVER_VERIFICATION_PATH,
  NAVER_VERIFICATION_SHA256,
  PROBE_ADMIN_API,
  PROBE_ADMIN_PAGES,
  PROBE_AUTH_PAGES,
  UNNORMALIZABLE_VARIANTS,
  buildProbes,
  classify,
  expectAdminApiUnauthenticated,
  expectAdminPageUnauthenticated,
  expectNaverVerificationFile,
  expectNoContentServed,
  expectProxyDenialSignature,
  expectPublicPathNotDenied,
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

  it("B-24: has no PROXY-NORMALIZE-FAILOPEN known finding left — every un-normalisable variant is asserted as the proxy's bare 404 on both hosts", () => {
    const probes = buildProbes({ buildId: "BUILD" });
    expect(probes.filter((probe: { knownFinding?: string }) => probe.knownFinding === "PROXY-NORMALIZE-FAILOPEN")).toEqual([]);
    expect([...UNNORMALIZABLE_VARIANTS].sort()).toEqual(
      ["backslash", "backslash-upper", "malformed-percent", "percent-encoded-slash", "percent-encoded-slash-upper"],
    );
    const proxyDenied = response(404);
    const nextNotFound = response(404, { body: "<html>not found</html>" });
    const guardBounce = response(307, { headers: { location: "/login?next=%2Fnovels" } });
    for (const variant of UNNORMALIZABLE_VARIANTS) {
      for (const path of [...PROBE_ADMIN_PAGES, ...PROBE_AUTH_PAGES, ...PROBE_ADMIN_API]) {
        const publicProbe = probes.find((probe: { id: string }) => probe.id === `public/${path}/${variant}`);
        if (!publicProbe) throw new Error(`public probe missing: ${path} ${variant}`);
        expect(publicProbe.check(proxyDenied, {}), `${publicProbe.id} accepts the proxy denial`).toBeNull();
        expect(publicProbe.check(nextNotFound, {}), `${publicProbe.id} rejects Next's own 404`).toMatch(/bare 404/);
        expect(publicProbe.check(guardBounce, {}), `${publicProbe.id} rejects the page guard bounce`).toMatch(/bare 404/);
      }
      for (const path of [...PROBE_ADMIN_PAGES, ...PROBE_ADMIN_API]) {
        const adminProbe = probes.find((probe: { id: string }) => probe.id === `admin/${path}/${variant}`);
        if (!adminProbe) throw new Error(`admin probe missing: ${path} ${variant}`);
        expect(adminProbe.check(proxyDenied, { requestHeaders: [] }), `${adminProbe.id} accepts the proxy denial`).toBeNull();
        expect(adminProbe.check(guardBounce, { requestHeaders: [] }), `${adminProbe.id} rejects a guard bounce`).toMatch(/bare 404/);
      }
    }
  });

  it("B-24: the un-normalisable probe targets really are classified as admin by isAdminPath once parsed like the proxy sees them", () => {
    const probes = buildProbes({ buildId: "BUILD" });
    const targets = probes
      .filter((probe: { id: string; hostRole: string }) => probe.hostRole === "public" && /^public\/.+\/(?:percent-encoded-slash|percent-encoded-slash-upper|backslash|backslash-upper|malformed-percent)$/.test(probe.id))
      .map((probe: { target: string }) => probe.target);
    expect(targets.length).toBe(UNNORMALIZABLE_VARIANTS.length * (PROBE_ADMIN_PAGES.length + PROBE_AUTH_PAGES.length + PROBE_ADMIN_API.length));
    for (const target of targets) {
      expect(isAdminPath(new URL(target, "https://novel.test").pathname), target).toBe(true);
    }
  });

  it("B-24: ordinary public URLs are probed too, and only the proxy's own bare 404 fails them", () => {
    const probes = buildProbes({ buildId: "BUILD" });
    const legit = probes.filter((probe: { group: string }) => probe.group === "public-host-legit-path");
    expect(legit.length).toBeGreaterThanOrEqual(10);
    const targets = legit.map((probe: { target: string }) => probe.target);
    expect(targets.some((target: string) => /\/ko\/novel\/%EC%84%9C/.test(target))).toBe(true);
    expect(targets.some((target: string) => target.includes("?"))).toBe(true);
    for (const required of ["/sitemap.xml", "/icon", "/apple-icon", "/robots.txt"]) expect(targets).toContain(required);
    for (const probe of legit as Array<{ hostRole: string; target: string; check: (r: unknown) => string | null }>) {
      expect(probe.hostRole).toBe("public");
      expect(isAdminPath(new URL(probe.target, "https://novel.test").pathname), probe.target).toBe(false);
      expect(probe.check(response(404)), probe.target).toMatch(/denied by the proxy/);
      expect(probe.check(response(200, { body: "<html>ok</html>" })), probe.target).toBeNull();
      expect(probe.check(response(404, { body: "<html>not found</html>" })), probe.target).toBeNull();
    }
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

  it("public URL not denied: only the proxy's bare 404 (or no response at all) fails; a 5xx fails only where a page must render", () => {
    expect(expectPublicPathNotDenied(response(200, { body: "<html>ok</html>" }))).toBeNull();
    expect(expectPublicPathNotDenied(response(404, { body: "<html>not found</html>" }))).toBeNull();
    expect(expectPublicPathNotDenied(response(503, { body: "Static sitemap is unavailable" }))).toBeNull();
    expect(expectPublicPathNotDenied(response(404))).toMatch(/denied by the proxy/);
    expect(expectPublicPathNotDenied(response(0))).toMatch(/no response/);
    expect(expectPublicPathNotDenied(response(500, { body: "boom" }), { requireNo5xx: true })).toMatch(/failed/);
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

describe("v0.5.12 Naver site-verification file (public/naver07aa70d2794ed3e5288b204fb467ee18.html)", () => {
  const FILE_ON_DISK = join(ROOT, "public", NAVER_VERIFICATION_PATH.slice(1));
  const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const served = (status: number, options: { body?: string; sha?: string | null; headers?: Record<string, string> } = {}) => ({
    status,
    headers: options.headers ?? {},
    rawHeaders: [],
    body: options.body ?? "",
    bodySha256: options.sha === undefined ? sha256(options.body ?? "") : options.sha,
  });

  it("ships byte-for-byte what Naver issued: pinned SHA-256, 67 bytes, no trailing newline", () => {
    const bytes = readFileSync(FILE_ON_DISK);
    expect(sha256(bytes)).toBe(NAVER_VERIFICATION_SHA256);
    expect(NAVER_VERIFICATION_SHA256).toBe("80f6a3bc8eb3e65113a1a31e8d90c20fda4821983941a4048462d7cab49d8431");
    expect(bytes.length).toBe(67);
    expect(bytes.at(-1)).not.toBe(0x0a);
    expect(bytes.toString("utf8")).toBe("naver-site-verification: naver07aa70d2794ed3e5288b204fb467ee18.html");
  });

  it("is a path the proxy treats as an ordinary public path (not admin, normalisable) and the file name matches the URL", () => {
    expect(isAdminPath(NAVER_VERIFICATION_PATH)).toBe(false);
    expect(NAVER_VERIFICATION_PATH).toBe("/naver07aa70d2794ed3e5288b204fb467ee18.html");
  });

  it("is probed on the public host (GET variants + HEAD) and denied on the admin host, in its own group", () => {
    const probes = buildProbes({ buildId: "BUILD" }).filter(
      (probe: { group: string }) => probe.group === NAVER_VERIFICATION_GROUP,
    ) as Array<{ id: string; hostRole: string; method?: string; target: string; noFollow?: boolean }>;
    const ids = probes.map((probe) => probe.id).sort();
    expect(ids).toEqual([
      "admin-static/naver-verification/plain",
      "public-static/naver-verification/accept-language-ko",
      "public-static/naver-verification/head",
      "public-static/naver-verification/naver-yeti-ua",
      "public-static/naver-verification/plain",
      "public-static/naver-verification/with-query",
    ]);
    // Redirect-following would hide a 3xx: every probe in the group reads the first answer.
    for (const probe of probes) expect(probe.noFollow, probe.id).toBe(true);
    expect(probes.filter((probe) => probe.hostRole === "public").length).toBe(5);
    expect(probes.find((probe) => probe.id.endsWith("/head"))?.method).toBe("HEAD");
    expect(probes.find((probe) => probe.id.endsWith("/with-query"))?.target).toBe(`${NAVER_VERIFICATION_PATH}?v=1`);
    // It must not leak into the generic "legit path" group, whose shared assertions are written for pages.
    const legit = buildProbes({ buildId: "BUILD" }).filter((probe: { group: string }) => probe.group === "public-host-legit-path");
    expect(legit.some((probe: { target: string }) => probe.target === NAVER_VERIFICATION_PATH)).toBe(false);
  });

  it("verdict: only a first-answer 200 with the pinned bytes passes; any 3xx, wrong bytes, 404 or 5xx fails", () => {
    const body = readFileSync(FILE_ON_DISK, "utf8");
    const good = served(200, { body });
    expect(good.bodySha256).toBe(NAVER_VERIFICATION_SHA256);
    expect(expectNaverVerificationFile(good, { first: good, hops: [] })).toBeNull();

    for (const status of [301, 302, 307, 308]) {
      const redirect = served(status, { headers: { location: "https://novel.test/ko/naver07aa70d2794ed3e5288b204fb467ee18.html" } });
      expect(expectNaverVerificationFile(redirect, { first: redirect, hops: [] }), String(status)).toMatch(/redirected/);
    }
    // Even when a followed redirect ends on the right bytes, the hop itself is the failure.
    const first308 = served(308, { headers: { location: "/x" } });
    expect(expectNaverVerificationFile(good, { first: first308, hops: [{ status: 308, to: "/x" }] })).toMatch(/redirected/);
    // A recorded hop is a failure on its own, whatever status the first answer carried.
    expect(expectNaverVerificationFile(good, { first: good, hops: [{ status: 308, to: "/x" }] })).toMatch(/redirected/);
    expect(expectNaverVerificationFile(served(200, { body: "naver-site-verification: other.html" }), {})).toMatch(/differs from the pinned bytes/);
    expect(expectNaverVerificationFile(served(200, { body: `${body}\n` }), {})).toMatch(/differs from the pinned bytes/);
    expect(expectNaverVerificationFile(served(200, { body: "<html>app 404</html>", sha: sha256("<html>app 404</html>") }), {})).toMatch(/differs/);
    expect(expectNaverVerificationFile(served(404), {})).toMatch(/should be 200/);
    expect(expectNaverVerificationFile(served(404, { body: "<html>not found</html>" }), {})).toMatch(/should be 200/);
    expect(expectNaverVerificationFile(served(500, { body: "boom" }), {})).toMatch(/should be 200/);
    expect(expectNaverVerificationFile(served(0, { sha: null }), {})).toMatch(/should be 200/);
  });

  it("admin host probe expects the proxy's own bare 404, not a served file or a Next 404 page", () => {
    const adminProbe = buildProbes({ buildId: "BUILD" }).find(
      (probe: { id: string }) => probe.id === "admin-static/naver-verification/plain",
    ) as { check: (r: unknown, c?: unknown) => string | null };
    expect(adminProbe.check(response(404), {})).toBeNull();
    expect(adminProbe.check(response(404, { body: "<html>not found</html>" }), {})).toMatch(/bare 404/);
    expect(adminProbe.check(response(200, { body: "naver-site-verification: x.html" }), {})).toMatch(/bare 404/);
  });

  it("parseRawResponse hashes the exact (de-chunked) body bytes", () => {
    const body = readFileSync(FILE_ON_DISK);
    const plain = Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: ${body.length}\r\n\r\n`, "latin1"),
      body,
    ]);
    expect(parseRawResponse(plain).bodySha256).toBe(NAVER_VERIFICATION_SHA256);
    const half = Math.floor(body.length / 2);
    const chunked = Buffer.concat([
      Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", "latin1"),
      Buffer.from(`${half.toString(16)}\r\n`, "latin1"),
      body.subarray(0, half),
      Buffer.from(`\r\n${(body.length - half).toString(16)}\r\n`, "latin1"),
      body.subarray(half),
      Buffer.from("\r\n0\r\n\r\n", "latin1"),
    ]);
    expect(parseRawResponse(chunked).bodySha256).toBe(NAVER_VERIFICATION_SHA256);
    expect(parseRawResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-", "latin1")).bodySha256).toBeNull();
  });
});
