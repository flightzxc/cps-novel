import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { findUnique, create } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/app/_lib/public-deps", () => ({
  prisma: {
    promoLink: { findUnique },
    trackingEvent: { create },
  },
}));

import { GET } from "@/app/go/[code]/route";

const PUBLIC_CODE = "pub1a2b";
const UPSTREAM_CODE = "UPSTREAM_SECRET";
const TARGET = "https://partner.example/read";
const PROMO_ID = "11111111-1111-1111-1111-111111111111";
const NOVEL_ID = "22222222-2222-2222-2222-222222222222";

function promo(overrides: Record<string, unknown> = {}) {
  return {
    id: PROMO_ID,
    novelId: NOVEL_ID,
    publicRedirectCode: PUBLIC_CODE,
    webUrl: TARGET,
    appUrl: null,
    status: "fetched",
    deletedAt: null,
    upstreamCode: UPSTREAM_CODE,
    ...overrides,
  };
}

function requestFor(code: string, headers?: HeadersInit): NextRequest {
  return new NextRequest(`https://novel.example/go/${encodeURIComponent(code)}`, { headers });
}

async function invoke(code: string, headers?: HeadersInit) {
  return GET(requestFor(code, headers), { params: Promise.resolve({ code }) });
}

async function leakSurface(response: Response, createArg: unknown): Promise<string> {
  const headers = Object.fromEntries(response.headers.entries());
  return JSON.stringify({
    status: response.status,
    headers,
    location: response.headers.get("location"),
    body: await response.clone().text(),
    createArg,
    findUniqueCalls: findUnique.mock.calls,
  });
}

describe("GET /go/[code]", () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
    create.mockResolvedValue({ id: 1n });
    process.env.TRACKING_HASH_SALT = "test-salt";
  });

  afterEach(() => {
    delete process.env.TRACKING_HASH_SALT;
  });

  it("redirects 302 to the normalized https webUrl for a fetched public code", async () => {
    findUnique.mockResolvedValue(promo());
    const response = await invoke(PUBLIC_CODE, {
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "NovelTest/1.0",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(create).toHaveBeenCalledOnce();
    expect(findUnique).toHaveBeenCalledWith({
      where: { publicRedirectCode: PUBLIC_CODE },
      select: {
        id: true,
        novelId: true,
        publicRedirectCode: true,
        webUrl: true,
        appUrl: true,
        status: true,
        deletedAt: true,
        // v0.6.0 唯一新增：剧场配置（分辨 link / code 模式）。路由从不 select 渠道口令码。
        channelApp: { select: { config: true } },
      },
    });

    const createArg = create.mock.calls[0]?.[0];
    expect(createArg).toMatchObject({
      data: {
        eventType: "go_redirect",
        articleId: null,
        novelId: NOVEL_ID,
        promoLinkId: PROMO_ID,
        publicRedirectCode: PUBLIC_CODE,
        sessionHash: null,
        requestHash: null,
        saltVersion: 1,
        context: {},
      },
    });
    expect(createArg.data.ipHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(createArg.data.userAgentHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(createArg.data.ipHash).not.toContain("203.0.113.9");
    expect(createArg.data.userAgentHash).not.toContain("NovelTest");

    const leaked = await leakSurface(response, createArg);
    expect(leaked).not.toContain(UPSTREAM_CODE);
    expect(leaked).not.toMatch(/upstreamCode/i);
  });

  it("returns 404 when the public code does not exist", async () => {
    findUnique.mockResolvedValue(null);
    const response = await invoke(PUBLIC_CODE);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Not found");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 404 when status is not fetched", async () => {
    findUnique.mockResolvedValue(promo({ status: "pending" }));
    const response = await invoke(PUBLIC_CODE);
    expect(response.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 404 when the promo link is soft-deleted", async () => {
    findUnique.mockResolvedValue(promo({ deletedAt: new Date("2026-08-01T00:00:00.000Z") }));
    const response = await invoke(PUBLIC_CODE);
    expect(response.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 404 for a javascript: target even when isPromoReady would pass", async () => {
    findUnique.mockResolvedValue(promo({ webUrl: "javascript:alert(1)", appUrl: null }));
    const response = await invoke(PUBLIC_CODE);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 404 for an unparseable target URL", async () => {
    findUnique.mockResolvedValue(promo({ webUrl: "http://[broken", appUrl: null }));
    const response = await invoke(PUBLIC_CODE);
    expect(response.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("still redirects when trackingEvent.create throws", async () => {
    findUnique.mockResolvedValue(promo());
    create.mockRejectedValue(new Error("write failed"));
    const response = await invoke(PUBLIC_CODE);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(create).toHaveBeenCalledOnce();
  });

  // P0-S10 (2026-08-20): U1 open-redirect coverage. Batch-1 integration
  // review independently re-verified each of these is already blocked by
  // `normalizeRedirectUrl` (`src/app/go/_lib/redirect-safety.ts`) — this
  // block is coverage, not a fix. If any of these ever starts returning a
  // 302 (or otherwise leaking the unsafe target), that is a new regression,
  // not something this comment already accounts for.
  describe("open-redirect / scheme guard coverage (U1)", () => {
    it("returns 404 for a protocol-relative //evil.com target (no scheme — new URL() rejects it without a base)", async () => {
      findUnique.mockResolvedValue(promo({ webUrl: "//evil.com", appUrl: null }));
      const response = await invoke(PUBLIC_CODE);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(create).not.toHaveBeenCalled();
    });

    it("returns 404 for a data: target", async () => {
      findUnique.mockResolvedValue(promo({ webUrl: "data:text/html,<script>alert(1)</script>", appUrl: null }));
      const response = await invoke(PUBLIC_CODE);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(create).not.toHaveBeenCalled();
    });

    it("returns 404 for a vbscript: target", async () => {
      findUnique.mockResolvedValue(promo({ webUrl: "vbscript:alert(1)", appUrl: null }));
      const response = await invoke(PUBLIC_CODE);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(create).not.toHaveBeenCalled();
    });

    it("returns 404 for an uppercase JAVASCRIPT: target (scheme check is not defeated by case)", async () => {
      findUnique.mockResolvedValue(promo({ webUrl: "JAVASCRIPT:alert(document.cookie)", appUrl: null }));
      const response = await invoke(PUBLIC_CODE);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(create).not.toHaveBeenCalled();
    });

    it("strips embedded CRLF from an otherwise-valid https target instead of forwarding it into the Location header (no response-header injection)", async () => {
      // WHATWG URL parsing removes ASCII tab/newline from the input as a
      // preprocessing step, so this never reaches NextResponse.redirect()
      // with a raw \r or \n in it — verify that holds and nothing resembling
      // an injected header (e.g. a real Set-Cookie) shows up.
      findUnique.mockResolvedValue(
        promo({ webUrl: "https://partner.example/read\r\nSet-Cookie: session=hijacked", appUrl: null }),
      );
      const response = await invoke(PUBLIC_CODE);
      const location = response.headers.get("location");
      expect(response.status).toBe(302);
      expect(location).not.toBeNull();
      expect(location).not.toMatch(/[\r\n]/);
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("redirects using appUrl when webUrl is absent (appUrl-only branch)", async () => {
      const appTarget = "https://app.example/deep-link";
      findUnique.mockResolvedValue(promo({ webUrl: null, appUrl: appTarget }));
      const response = await invoke(PUBLIC_CODE);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(appTarget);
      expect(create).toHaveBeenCalledOnce();
    });

    it("returns 404 when appUrl is the only candidate and it is itself unsafe (javascript:)", async () => {
      findUnique.mockResolvedValue(promo({ webUrl: null, appUrl: "javascript:alert(1)" }));
      const response = await invoke(PUBLIC_CODE);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("does not look up or echo upstreamCode when that secret is used as the path", async () => {
    findUnique.mockResolvedValue(null);
    const response = await invoke(UPSTREAM_CODE);
    expect(response.status).toBe(404);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicRedirectCode: UPSTREAM_CODE } }),
    );
    const where = findUnique.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(Object.keys(where)).toEqual(["publicRedirectCode"]);
    expect(create).not.toHaveBeenCalled();
    const leaked = await leakSurface(response, create.mock.calls[0]?.[0]);
    expect(leaked).not.toMatch(/upstreamCode/i);
  });

  // ---------------------------------------------------------------------------
  // v0.6.0 口令码模式（PlotNovel）：/go/<站内码> → 302 到中间页 /go/<站内码>/app；link 模式一字不变
  // ---------------------------------------------------------------------------
  describe("v0.6.0 剧场模式", () => {
    const CODE_THEATER = { config: { promoMode: "code", agencyIds: ["1351"], codeModeLocales: ["en"] } };
    const LINK_THEATER = { config: { promoMode: "link", agencyIds: ["3366"] } };

    it("🔴 link 模式（MoboReader）：响应与改动前逐字相同——302 到网址、no-store、记一次点击", async () => {
      findUnique.mockResolvedValue(promo({ channelApp: LINK_THEATER }));
      const response = await invoke(PUBLIC_CODE, { "x-forwarded-for": "203.0.113.9", "user-agent": "NovelTest/1.0" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(TARGET);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(create).toHaveBeenCalledOnce();
      // 旧记录 config = {}、剧场信息缺失，同样走原来的逻辑
      create.mockClear();
      findUnique.mockResolvedValue(promo({ channelApp: { config: {} } }));
      expect((await invoke(PUBLIC_CODE)).headers.get("location")).toBe(TARGET);
      findUnique.mockResolvedValue(promo({ channelApp: null }));
      expect((await invoke(PUBLIC_CODE)).headers.get("location")).toBe(TARGET);
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("🔴 防误伤：link 模式下有口令码、没有网址 → 404（口令码模式的放行绝不波及 MoboReader）", async () => {
      findUnique.mockResolvedValue(promo({ webUrl: null, appUrl: null, channelApp: LINK_THEATER }));
      const response = await invoke(PUBLIC_CODE);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(create).not.toHaveBeenCalled();
      findUnique.mockResolvedValue(promo({ webUrl: null, appUrl: null, channelApp: { config: {} } }));
      expect((await invoke(PUBLIC_CODE)).status).toBe(404);
    });

    it("口令码模式：302 到站内中间页 /go/<码>/app（相对路径、no-store、无正文），不记点击，不碰网址", async () => {
      findUnique.mockResolvedValue(promo({ webUrl: null, appUrl: null, channelApp: CODE_THEATER }));
      const response = await invoke(PUBLIC_CODE);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/go/${PUBLIC_CODE}/app`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(create).not.toHaveBeenCalled();
    });

    it("口令码模式即使推广链接带着网址，也去中间页而不是跳网址（两种模式互不相交）", async () => {
      findUnique.mockResolvedValue(promo({ webUrl: TARGET, appUrl: null, channelApp: CODE_THEATER }));
      const response = await invoke(PUBLIC_CODE);
      expect(response.headers.get("location")).toBe(`/go/${PUBLIC_CODE}/app`);
      expect(create).not.toHaveBeenCalled();
    });

    it("口令码模式：状态不是 fetched / 已软删除 / 不存在 → 404，不重定向", async () => {
      findUnique.mockResolvedValue(promo({ status: "pending", channelApp: CODE_THEATER }));
      expect((await invoke(PUBLIC_CODE)).status).toBe(404);
      findUnique.mockResolvedValue(promo({ deletedAt: new Date(), channelApp: CODE_THEATER }));
      expect((await invoke(PUBLIC_CODE)).status).toBe(404);
      findUnique.mockResolvedValue(null);
      expect((await invoke(PUBLIC_CODE)).status).toBe(404);
      expect(create).not.toHaveBeenCalled();
    });

    it("路由从不读也从不输出渠道口令码：查库的 select、重定向的响应面里都没有它", async () => {
      findUnique.mockResolvedValue(promo({ webUrl: null, appUrl: null, channelApp: CODE_THEATER }));
      const response = await invoke(PUBLIC_CODE);
      const leaked = await leakSurface(response, create.mock.calls[0]?.[0]);
      expect(leaked).not.toContain(UPSTREAM_CODE);
      expect(leaked).not.toMatch(/upstreamCode/i);
      expect(JSON.stringify(findUnique.mock.calls)).not.toMatch(/upstream/i);
    });
  });
});
