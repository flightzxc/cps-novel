import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDramaSisterSiteRedirectTarget, DRAMA_SISTER_SITE_ORIGIN } from "@/proxy";

/**
 * B-50（Owner 2026-10-19 单独批准）：pulsenovels.com 上的 `/drama/*` 永久跳到短剧站
 * enpulsedrama.com 的同一路径；后台主机、别名域名、裸 IP 不跳。背景见
 * `排查_GA出现drama路径_2026-10-19.md`（仓库外）与 `src/proxy.ts` 的
 * `buildDramaSisterSiteRedirectTarget` 注释。
 */

const SITE_HOST = "pulsenovels.com";
const ADMIN_HOST = "zbcwf.pulsenovels.com";
const ORIGIN = `https://${SITE_HOST}`;
// 排查报告里 ChatGPT 实际带来的两种形态：带短 id 的新地址和不带短 id 的旧地址。
const DRAMA_PATH = "/drama/my-man-remembered-hes-rich-watch-free-p34pthm1b";
const LEGACY_DRAMA_PATH = "/drama/my-man-remembered-hes-rich-watch-free";

function stubProductionHosts(): void {
  vi.stubEnv("SITE_URL", ORIGIN);
  vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
  vi.stubEnv("NODE_ENV", "production");
}

describe("buildDramaSisterSiteRedirectTarget — 纯函数", () => {
  it("目标是写死的短剧站正式域名", () => {
    expect(DRAMA_SISTER_SITE_ORIGIN).toBe("https://enpulsedrama.com");
  });

  it("/drama 与 /drama/* 都跳到短剧站同一路径（与 Next 的 /drama/:path* 同义）", () => {
    expect(buildDramaSisterSiteRedirectTarget(DRAMA_PATH, "")).toBe(`https://enpulsedrama.com${DRAMA_PATH}`);
    expect(buildDramaSisterSiteRedirectTarget(LEGACY_DRAMA_PATH, "")).toBe(`https://enpulsedrama.com${LEGACY_DRAMA_PATH}`);
    expect(buildDramaSisterSiteRedirectTarget("/drama", "")).toBe("https://enpulsedrama.com/drama");
    expect(buildDramaSisterSiteRedirectTarget("/drama/", "")).toBe("https://enpulsedrama.com/drama/");
    expect(buildDramaSisterSiteRedirectTarget("/drama/a/b/c", "")).toBe("https://enpulsedrama.com/drama/a/b/c");
  });

  it("查询串原样带上（含 ChatGPT 的 utm_source）", () => {
    expect(buildDramaSisterSiteRedirectTarget(DRAMA_PATH, "?utm_source=chatgpt.com")).toBe(
      `https://enpulsedrama.com${DRAMA_PATH}?utm_source=chatgpt.com`,
    );
    expect(buildDramaSisterSiteRedirectTarget("/drama/x", "?a=1&b=%E3%81%82")).toBe(
      "https://enpulsedrama.com/drama/x?a=1&b=%E3%81%82",
    );
  });

  it("百分号编码的路径不解码、不重编码", () => {
    expect(buildDramaSisterSiteRedirectTarget("/drama/%E4%B8%AD%E6%96%87-p1", "")).toBe(
      "https://enpulsedrama.com/drama/%E4%B8%AD%E6%96%87-p1",
    );
  });

  it("只认 /drama 这一段：相似前缀、其它路径、语种前缀、大小写不同都不跳", () => {
    for (const pathname of [
      "/dramas",
      "/drama-x",
      "/dramax/1",
      "/Drama/x",
      "/DRAMA/x",
      "/novel/drama/x",
      "/ko/drama/x",
      "/",
      "/novel/some-book-p1234abcd",
      "/browse",
      "/blog/x",
    ]) {
      expect(buildDramaSisterSiteRedirectTarget(pathname, ""), pathname).toBeNull();
    }
  });

  it("双斜杠等形态拼出来仍落在短剧站，不构成开放跳转", () => {
    for (const pathname of ["/drama//evil.com", "/drama//evil.com/x", "/drama/..//evil.com"]) {
      const target = buildDramaSisterSiteRedirectTarget(pathname, "");
      expect(target, pathname).not.toBeNull();
      expect(new URL(target as string).hostname, pathname).toBe("enpulsedrama.com");
    }
  });
});

describe("src/proxy.ts — B-50 /drama/* 301 到短剧站（经真实 NextRequest/NextResponse）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("公开站主机：/drama/* 301 到 enpulsedrama.com 同路径，查询串保留", async () => {
    stubProductionHosts();
    const { proxy } = await import("@/proxy");

    for (const [path, expectedLocation] of [
      [DRAMA_PATH, `https://enpulsedrama.com${DRAMA_PATH}`],
      [`${DRAMA_PATH}?utm_source=chatgpt.com`, `https://enpulsedrama.com${DRAMA_PATH}?utm_source=chatgpt.com`],
      [LEGACY_DRAMA_PATH, `https://enpulsedrama.com${LEGACY_DRAMA_PATH}`],
      ["/drama", "https://enpulsedrama.com/drama"],
    ] as const) {
      const request = new NextRequest(`${ORIGIN}${path}`, { headers: { host: SITE_HOST } });
      const response = proxy(request);
      expect(response.status, path).toBe(301);
      expect(response.headers.get("location"), path).toBe(expectedLocation);
    }
  });

  it("公开站主机名不区分大小写、忽略端口", async () => {
    stubProductionHosts();
    const { proxy } = await import("@/proxy");

    for (const hostHeader of ["PulseNovels.COM", "pulsenovels.com:443", "pulsenovels.com:3000", " pulsenovels.com "]) {
      const request = new NextRequest(`${ORIGIN}/drama/x`, { headers: { host: hostHeader } });
      const response = proxy(request);
      expect(response.status, hostHeader).toBe(301);
      expect(response.headers.get("location"), hostHeader).toBe("https://enpulsedrama.com/drama/x");
    }
  });

  it("后台主机：/drama/* 不跳，仍是 RC-9 的裸 404", async () => {
    stubProductionHosts();
    const { proxy } = await import("@/proxy");

    for (const hostHeader of [ADMIN_HOST, "ZBCWF.pulsenovels.com:443"]) {
      const request = new NextRequest(`https://${ADMIN_HOST}/drama/x?utm_source=chatgpt.com`, { headers: { host: hostHeader } });
      const response = proxy(request);
      expect(response.status, hostHeader).toBe(404);
      expect(response.headers.get("location"), hostHeader).toBeNull();
    }
  });

  it("别名域名、裸 IP、缺 Host 的请求：/drama/* 不跳", async () => {
    stubProductionHosts();
    const { proxy } = await import("@/proxy");

    for (const hostHeader of ["www.bangbangji.cloud", "bangbangji.cloud", "www.pulsenovels.com", "203.0.113.7", "localhost:3000"]) {
      const request = new NextRequest(`https://${hostHeader.replace(/:\d+$/, "")}/drama/x`, { headers: { host: hostHeader } });
      const response = proxy(request);
      expect(response.status, hostHeader).toBe(200);
      expect(response.headers.get("location"), hostHeader).toBeNull();
    }

    const noHost = new NextRequest(`${ORIGIN}/drama/x`);
    expect(noHost.headers.get("host")).toBeNull();
    const response = proxy(noHost);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("公开站其它页面不受影响：/novel/、/browse、/blog/、/ko/drama/、/dramas 都不跳", async () => {
    stubProductionHosts();
    const { proxy } = await import("@/proxy");

    for (const path of [
      "/novel/some-book-p1234abcd",
      "/ko/novel/%EC%84%9C%EC%9A%B8-p1234abcd",
      "/browse?page=2",
      "/category/romance",
      "/blog/some-post",
      "/search?q=drama",
      "/ko/drama/x",
      "/dramas",
      "/Drama/x",
      "/sitemap.xml",
      "/robots.txt",
    ]) {
      const request = new NextRequest(`${ORIGIN}${path}`, { headers: { host: SITE_HOST } });
      const response = proxy(request);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });

  it("后台路径在公开站仍是 404（RC-9 的优先级不被跳转绕过）", async () => {
    stubProductionHosts();
    const { proxy } = await import("@/proxy");

    for (const path of ["/novels", "/catalog-sync", "/login", "/api/admin/tasks"]) {
      const request = new NextRequest(`${ORIGIN}${path}`, { headers: { host: SITE_HOST } });
      const response = proxy(request);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });
});
