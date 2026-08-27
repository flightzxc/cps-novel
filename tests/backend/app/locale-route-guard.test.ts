import { describe, expect, it, vi } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { getRoutableLocale } from "@/app/[locale]/_guard";

describe("getRoutableLocale (P0-S7a locale route infra)", () => {
  it("rejects every locale prefix: en is served bare and other locales have not cleared D-7", () => {
    for (const locale of SITE_LOCALES) {
      expect(getRoutableLocale(locale), `${locale} should not resolve under a locale prefix`).toBeNull();
    }
  });

  it("rejects the default locale (en) despite D-7 admission — it is served bare", () => {
    // U6 admitted en to the real whitelist. A prefixed `/en/...` request
    // must still 404: the default-locale structural guard takes precedence.
    expect(getRoutableLocale("en")).toBeNull();
  });

  it("rejects unregistered / malformed input without throwing", () => {
    for (const value of ["", "xx", "EN", "en-US", "not-a-locale", "../../etc"]) {
      expect(getRoutableLocale(value)).toBeNull();
    }
  });
});

describe("[locale]/layout.tsx (P0-S7a locale route infra)", () => {
  it("404s every request today via next/navigation's notFound()", async () => {
    vi.resetModules();
    vi.doMock("next/navigation", () => ({
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
    }));

    const { default: LocalePublicLayout } = await import("@/app/[locale]/layout");
    await expect(
      LocalePublicLayout({
        children: "CHILDREN" as never,
        params: Promise.resolve({ locale: "fr" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    vi.doUnmock("next/navigation");
    vi.resetModules();
  });
});
