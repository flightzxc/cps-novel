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
});
