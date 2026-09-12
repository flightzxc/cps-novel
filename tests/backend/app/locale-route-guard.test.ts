import { describe, expect, it, vi } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { getRoutableLocale } from "@/app/[locale]/_guard";

/**
 * L10N P4 (矩阵 #9): "registered即路由" — the D-7 publish whitelist
 * (`PUBLISHABLE_LOCALES`/`isPublishableLocale`) that used to reject every
 * non-`en` `SITE_LOCALES` member here was deleted. `en` alone is still
 * rejected — that is the SEPARATE, unchanged D-8 structural rule (default
 * locale stays at the bare path).
 */
describe("getRoutableLocale (P0-S7a locale route infra)", () => {
  it("resolves every registered non-en SITE_LOCALES member under a locale prefix", () => {
    for (const locale of SITE_LOCALES) {
      if (locale === "en") continue;
      expect(getRoutableLocale(locale), `${locale} should resolve under a locale prefix`).toBe(locale);
    }
  });

  it("rejects the default locale (en) — it is served bare (D-8, unchanged by P4)", () => {
    expect(getRoutableLocale("en")).toBeNull();
  });

  it("rejects unregistered / malformed input without throwing", () => {
    for (const value of ["", "xx", "EN", "en-US", "not-a-locale", "../../etc"]) {
      expect(getRoutableLocale(value)).toBeNull();
    }
  });
});

describe("[locale]/layout.tsx (P0-S7a locale route infra)", () => {
  it("L10N P4: renders children for a registered, non-en locale — no longer 404s (the D-7 whitelist this used to enforce is deleted)", async () => {
    const { default: LocalePublicLayout } = await import("@/app/[locale]/layout");
    const result = await LocalePublicLayout({
      children: "CHILDREN" as never,
      params: Promise.resolve({ locale: "fr" }),
    });
    expect(result).toBe("CHILDREN");
  });

  it("still 404s via next/navigation's notFound() for en (D-8 default-locale exclusion, unchanged)", async () => {
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
        params: Promise.resolve({ locale: "en" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    vi.doUnmock("next/navigation");
    vi.resetModules();
  });

  it("still 404s via next/navigation's notFound() for an unregistered locale", async () => {
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
        params: Promise.resolve({ locale: "xx" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    vi.doUnmock("next/navigation");
    vi.resetModules();
  });
});
