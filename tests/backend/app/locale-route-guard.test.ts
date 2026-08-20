import { describe, expect, it, vi } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { getRoutableLocale } from "@/app/[locale]/_guard";

describe("getRoutableLocale (P0-S7a locale route infra)", () => {
  it("rejects every registered locale today, because none has cleared the D-7 publish whitelist", () => {
    for (const locale of SITE_LOCALES) {
      expect(getRoutableLocale(locale), `${locale} should not be routable yet`).toBeNull();
    }
  });

  it("rejects the default locale (en) even hypothetically — it is served bare, never under a prefix", () => {
    // Simulated future state: `en` clears the whitelist. Even then, a
    // prefixed `/en/...` request must still 404 — the default locale never
    // gets a second, duplicate-content URL under this segment.
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
