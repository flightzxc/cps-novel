import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// RC-6: verifies the write gate (`PUBLIC_TRACKING_WRITE_DISABLED`) and bot
// user-agent filter wired into `GET /go/[code]` never change redirect
// semantics (302/404 and the target URL) -- they only decide whether a
// `TrackingEvent` row is attempted. This is a *new* file alongside the
// existing `tests/backend/public/go-redirect.test.ts` (left unmodified);
// some scenarios below (e.g. the create()-throws regression, the 404 case)
// intentionally re-verify behavior already covered there, from the gate's
// point of view.

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
const TARGET = "https://partner.example/read";
const PROMO_ID = "11111111-1111-1111-1111-111111111111";
const NOVEL_ID = "22222222-2222-2222-2222-222222222222";
const NORMAL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) NovelTest/1.0";
const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function promo(overrides: Record<string, unknown> = {}) {
  return {
    id: PROMO_ID,
    novelId: NOVEL_ID,
    publicRedirectCode: PUBLIC_CODE,
    webUrl: TARGET,
    appUrl: null,
    status: "fetched",
    deletedAt: null,
    ...overrides,
  };
}

function requestFor(code: string, headers?: HeadersInit): NextRequest {
  return new NextRequest(`https://novel.example/go/${encodeURIComponent(code)}`, { headers });
}

async function invoke(code: string, headers?: HeadersInit) {
  return GET(requestFor(code, headers), { params: Promise.resolve({ code }) });
}

describe("GET /go/[code] tracking write gate (RC-6)", () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
    create.mockResolvedValue({ id: 1n });
    process.env.TRACKING_HASH_SALT = "test-salt";
    delete process.env.PUBLIC_TRACKING_WRITE_DISABLED;
  });

  afterEach(() => {
    delete process.env.TRACKING_HASH_SALT;
    delete process.env.PUBLIC_TRACKING_WRITE_DISABLED;
  });

  it("skips the tracking write but still redirects 302 when PUBLIC_TRACKING_WRITE_DISABLED=1", async () => {
    process.env.PUBLIC_TRACKING_WRITE_DISABLED = "1";
    findUnique.mockResolvedValue(promo());

    const response = await invoke(PUBLIC_CODE, { "user-agent": NORMAL_UA });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(create).not.toHaveBeenCalled();
  });

  it("skips the tracking write but still redirects 302 when PUBLIC_TRACKING_WRITE_DISABLED=true", async () => {
    process.env.PUBLIC_TRACKING_WRITE_DISABLED = "true";
    findUnique.mockResolvedValue(promo());

    const response = await invoke(PUBLIC_CODE, { "user-agent": NORMAL_UA });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(create).not.toHaveBeenCalled();
  });

  it("skips the tracking write but still redirects 302 when PUBLIC_TRACKING_WRITE_DISABLED=on", async () => {
    // CPS `isTruthyEnv` accepts `on`/`yes` too, and this repo copies that set
    // rather than its usual exact `=== "true"`. Asserted at the route (not
    // just the pure function) so the widened set is proven to reach the real
    // write site an operator would be relying on.
    process.env.PUBLIC_TRACKING_WRITE_DISABLED = "on";
    findUnique.mockResolvedValue(promo());

    const response = await invoke(PUBLIC_CODE, { "user-agent": NORMAL_UA });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(create).not.toHaveBeenCalled();
  });

  it("skips the tracking write but still redirects 302 for an obvious bot user-agent", async () => {
    findUnique.mockResolvedValue(promo());

    const response = await invoke(PUBLIC_CODE, { "user-agent": BOT_UA });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(create).not.toHaveBeenCalled();
  });

  it("writes the tracking event and redirects 302 for a normal user-agent with the gate open", async () => {
    findUnique.mockResolvedValue(promo());

    const response = await invoke(PUBLIC_CODE, { "user-agent": NORMAL_UA });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(create).toHaveBeenCalledOnce();
  });

  it("still redirects 302 when trackingEvent.create throws (tracking never blocks the redirect)", async () => {
    findUnique.mockResolvedValue(promo());
    create.mockRejectedValue(new Error("write failed"));

    const response = await invoke(PUBLIC_CODE, { "user-agent": NORMAL_UA });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(TARGET);
    expect(create).toHaveBeenCalledOnce();
  });

  it("returns 404 for an unknown code regardless of the write gate state (redirect semantics never change)", async () => {
    process.env.PUBLIC_TRACKING_WRITE_DISABLED = "1";
    findUnique.mockResolvedValue(null);

    const response = await invoke(PUBLIC_CODE, { "user-agent": NORMAL_UA });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(create).not.toHaveBeenCalled();
  });
});
