import { describe, expect, it } from "vitest";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.1):
 * `chromeFromSiteSetting`'s `brandHref`/nav hrefs are now locale-prefixed.
 * Direct coverage of this function specifically — the page-body tests in
 * `tests/ui/locale-aware-page-links.test.tsx` mock `@/app/_lib/public-load`'s
 * `loadChrome` entirely (a canned `{settings, chrome}` object), so they
 * never actually exercise `chromeFromSiteSetting`'s own prefix arithmetic.
 *
 * No mock on `@/lib/locale/messages`: `chromeFromSiteSetting` calls
 * `getPublicT(locale)` internally to build each nav item's `label`, and
 * WO-3's `loadMessages`/`getPublicT` deep-merge onto `en` rather than
 * throwing, so a real `"es"`/`"pt-BR"` `SiteLocale` renders its own real
 * nav labels here. The non-default-locale cases below assert those real
 * translated labels (e.g. "Inicio", "Início") alongside the href, which
 * doubles as a live check that WO-3's catalog is wired up.
 */

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
    expect(chrome.navItems?.[0]).toEqual(expect.objectContaining({ href: "/es", label: "Inicio" }));
    expect(chrome.navItems?.[1]).toEqual(
      expect.objectContaining({ href: "/es/browse", label: "Todas las obras" }),
    );
  });

  it("preserves a hyphenated locale code verbatim", () => {
    const chrome = chromeFromSiteSetting(SETTINGS, "pt-BR");
    expect(chrome.brandHref).toBe("/pt-BR");
    expect(chrome.navItems?.[0]).toEqual(expect.objectContaining({ href: "/pt-BR", label: "Início" }));
    expect(chrome.navItems?.[1]).toEqual(
      expect.objectContaining({ href: "/pt-BR/browse", label: "Todas as obras" }),
    );
  });
});
