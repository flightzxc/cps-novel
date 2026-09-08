import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.2): `src/app/layout.tsx`
 * now sets `<html lang>` from the request-locale header (falling back to
 * `en` on anything missing/invalid/throwing) and newly sets `<html dir>`
 * alongside it. `RootLayout` also calls `getSiteSetting(prisma)` (a real DB
 * round trip) — `@/app/_lib/public-deps` and
 * `@/server/site-settings/service` are mocked here so this stays a fast,
 * DB-free unit test, matching how `tests/ui/admin-auth-session-lib.test.ts`
 * mocks `next/headers` for the same reason (a real cookie/header jar, not a
 * source-string scan).
 *
 * `RootLayout`'s return value (`<html lang=... dir=...>...</html>`) is
 * inspected as a plain React element's own props, not mounted via
 * `@testing-library/react` — that library mounts into a `<div>` inside the
 * test document's REAL `<body>`, and nesting a second `<html>` tag inside
 * that would be invalid HTML nesting rather than a meaningful simulation of
 * what Next actually does with this element (replace the document's own
 * `<html>`). Reading `tree.props.lang`/`tree.props.dir` directly is the
 * faithful check here.
 */

const state = vi.hoisted(() => ({
  headerValue: null as string | null,
  headersThrows: false,
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    if (state.headersThrows) throw new Error("headers() boom (simulated)");
    return { get: () => state.headerValue };
  },
}));

vi.mock("@/app/_lib/public-deps", () => ({ prisma: {} }));

const SETTINGS = {
  siteName: "cps-novel",
  siteDescription: "Overseas novels.",
  homeMetaTitle: "cps-novel",
  homeMetaDescription: "Read overseas novels.",
  defaultOgImage: "",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "© test",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  updatedAt: new Date("2026-08-18T00:00:00Z"),
};

vi.mock("@/server/site-settings/service", () => ({
  getSiteSetting: vi.fn(async () => SETTINGS),
}));

const { default: RootLayout } = await import("@/app/layout");

type HtmlElement = ReactElement<{ lang: string; dir: string }>;

async function renderRootLayout(): Promise<HtmlElement> {
  return (await RootLayout({ children: null })) as HtmlElement;
}

describe("RootLayout — <html lang>/<html dir> (WO-2 §8.2)", () => {
  beforeEach(() => {
    state.headerValue = null;
    state.headersThrows = false;
  });

  it("reflects en (today's only open locale) when the header carries it — lang unchanged from before this pass", async () => {
    state.headerValue = "en";
    const tree = await renderRootLayout();
    expect(tree.props.lang).toBe("en");
    expect(tree.props.dir).toBe("ltr");
  });

  it("falls back to en/ltr when the header is simply absent", async () => {
    state.headerValue = null;
    const tree = await renderRootLayout();
    expect(tree.props.lang).toBe("en");
    expect(tree.props.dir).toBe("ltr");
  });

  it("falls back to en/ltr when the header carries a registered-but-unopened locale (never trusts it blindly)", async () => {
    state.headerValue = "ja";
    const tree = await renderRootLayout();
    expect(tree.props.lang).toBe("en");
    expect(tree.props.dir).toBe("ltr");
  });

  it("falls back to en/ltr when the header carries outright garbage", async () => {
    state.headerValue = "<script>";
    const tree = await renderRootLayout();
    expect(tree.props.lang).toBe("en");
  });

  it("falls back to en/ltr, without throwing, when headers() itself throws — the whole read is wrapped in try/catch", async () => {
    state.headersThrows = true;
    await expect(renderRootLayout()).resolves.toBeTruthy();
    const tree = await renderRootLayout();
    expect(tree.props.lang).toBe("en");
    expect(tree.props.dir).toBe("ltr");
  });
});
