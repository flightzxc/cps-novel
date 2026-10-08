import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxy } from "@/proxy";

/**
 * v0.5.12 — Naver Search Advisor site-verification file
 * (`public/naver07aa70d2794ed3e5288b204fb467ee18.html`).
 *
 * `src/proxy.ts`'s matcher excludes only `_next/static`, `_next/image`, favicon and the icon routes, so a root-level
 * `*.html` request runs through the admin-host gate, the `/en/*` redirect and the root-path language negotiation
 * before Next's static handler can serve it from `public/`. The live proof (200 + identical bytes + no 3xx on a real
 * `next start`) is the `public-host-static-verification-file` group of scripts/security/next-proxy-probe.mjs; this
 * file pins the proxy's own decision for that path so a unit-level regression is caught without a build.
 */

const SITE_HOST = "pulsenovels.com";
const ADMIN_HOST = "zbcwf.pulsenovels.com";
const PATH = "/naver07aa70d2794ed3e5288b204fb467ee18.html";

function stubProductionEnv() {
  vi.stubEnv("SITE_URL", `https://${SITE_HOST}`);
  vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
  vi.stubEnv("NODE_ENV", "production");
}

describe("src/proxy.ts — Naver verification file passes through on the public host", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is passed on (no redirect, no rewrite, no denial) for the public host, with or without language/UA/query noise", () => {
    stubProductionEnv();
    const variants: Array<[string, string, Record<string, string>]> = [
      ["plain", PATH, {}],
      ["accept-language ko", PATH, { "accept-language": "ko-KR,ko;q=0.9,en;q=0.5" }],
      ["accept-language ja + locale cookie", PATH, { "accept-language": "ja", cookie: "NEXT_LOCALE=ko" }],
      ["naver crawler UA", PATH, { "user-agent": "Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)" }],
      ["query string", `${PATH}?v=1`, {}],
    ];
    for (const [name, path, headers] of variants) {
      const request = new NextRequest(`https://${SITE_HOST}${path}`, { headers: { host: SITE_HOST, ...headers } });
      const response = proxy(request);
      expect(response.status, name).toBe(200);
      expect(response.headers.get("location"), name).toBeNull();
      expect(response.headers.get("x-middleware-rewrite"), name).toBeNull();
      // NextResponse.next(): the request continues to Next's filesystem (public/) handler.
      expect(response.headers.get("x-middleware-next"), name).toBe("1");
    }
  });

  it("is also passed on for an unrecognised Host (same fail-open rule as every non-admin path)", () => {
    stubProductionEnv();
    const request = new NextRequest(`https://other.example${PATH}`, { headers: { host: "other.example" } });
    const response = proxy(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("is the proxy's bare 404 on the admin host (the admin host serves admin paths only)", async () => {
    stubProductionEnv();
    const request = new NextRequest(`https://${ADMIN_HOST}${PATH}`, { headers: { host: ADMIN_HOST } });
    const response = proxy(request);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("");
  });
});
