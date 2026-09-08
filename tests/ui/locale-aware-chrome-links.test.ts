import { describe, expect, it, vi } from "vitest";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.1):
 * `chromeFromSiteSetting`'s `brandHref`/nav hrefs are now locale-prefixed.
 * Direct coverage of this function specifically — the page-body tests in
 * `tests/ui/locale-aware-page-links.test.tsx` mock `@/app/_lib/public-load`'s
 * `loadChrome` entirely (a canned `{settings, chrome}` object), so they
 * never actually exercise `chromeFromSiteSetting`'s own prefix arithmetic.
 *
 * Same `@/lib/locale/messages` override as that sibling file, for the same
 * reason (see its own doc comment): `chromeFromSiteSetting` calls
 * `getPublicT(locale)` internally, and WO-3's deep-merge-to-English
 * fallback hasn't landed in this worktree, so a real non-"en" `SiteLocale`
 * would otherwise throw before this function's `href` fields are ever
 * built. For `"en"` the override is a transparent passthrough to the real
 * `getPublicT("en")`.
 */
vi.mock("@/lib/locale/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/locale/messages")>();
  return { ...actual, getPublicT: () => actual.getPublicT("en") };
});

const { chromeFromSiteSetting } = await import("@/lib/site/chrome");

const SETTINGS = {
  siteName: "cps-novel",
  footerCopyrightText: "",
  footerDisclaimerText: "",
  friendLinks: [],
} as unknown as Parameters<typeof chromeFromSiteSetting>[0];

describe("chromeFromSiteSetting — brandHref / nav hrefs", () => {
  it("stays bare for en (byte-identical to before WO-2)", () => {
    const chrome = chromeFromSiteSetting(SETTINGS, "en");
    expect(chrome.brandHref).toBe("/");
    expect(chrome.navItems?.[0]).toEqual(expect.objectContaining({ href: "/" }));
    expect(chrome.navItems?.[1]).toEqual(expect.objectContaining({ href: "/browse" }));
  });

  it("prefixes for a non-default locale, WITHOUT doubling the slash on the root-path brand/home link", () => {
    const chrome = chromeFromSiteSetting(SETTINGS, "es");
    expect(chrome.brandHref).toBe("/es");
    expect(chrome.navItems?.[0]).toEqual(expect.objectContaining({ href: "/es" }));
    expect(chrome.navItems?.[1]).toEqual(expect.objectContaining({ href: "/es/browse" }));
  });

  it("preserves a hyphenated locale code verbatim", () => {
    const chrome = chromeFromSiteSetting(SETTINGS, "pt-BR");
    expect(chrome.brandHref).toBe("/pt-BR");
    expect(chrome.navItems?.[1]).toEqual(expect.objectContaining({ href: "/pt-BR/browse" }));
  });
});
