import { describe, expect, it } from "vitest";

import { pickSiteLocale, SITE_LOCALE_REQUEST_HEADER } from "@/lib/site/request-locale";

/**
 * L10N P4: the shared validate-with-fallback rule `src/proxy.ts` (building
 * the request header) and `src/app/layout.tsx` (reading it back for
 * `<html lang>`) both apply. Reads `SITE_LOCALES` (the static registration
 * gate) — the narrower D-7 publish whitelist (`isPublishableLocale`,
 * `pickPublishableLocale`'s previous gate) was deleted this round, so a
 * registered-but-previously-unopened locale like `"ru"` now passes through
 * as-is instead of falling back to `en`.
 */
describe("pickSiteLocale", () => {
  it("accepts en as-is", () => {
    expect(pickSiteLocale("en")).toBe("en");
  });

  it("accepts any registered SITE_LOCALES member as-is (the old publish-whitelist fallback is gone)", () => {
    for (const candidate of ["es", "fr", "ja", "ru", "ar", "zh-Hant", "pt-BR"]) {
      expect(pickSiteLocale(candidate), candidate).toBe(candidate);
    }
  });

  it("falls back to en for missing/invalid input, never throws", () => {
    for (const candidate of [null, undefined, "", "not-a-locale", "EN", "en-US", 0, {}, []]) {
      expect(() => pickSiteLocale(candidate)).not.toThrow();
      expect(pickSiteLocale(candidate), JSON.stringify(candidate)).toBe("en");
    }
  });

  it("does not case-fold or region-fallback (consistent with the canonical gate's own no-guessing rule)", () => {
    expect(pickSiteLocale("En")).toBe("en");
    expect(pickSiteLocale(" en")).toBe("en");
    expect(pickSiteLocale("en ")).toBe("en");
  });
});

describe("SITE_LOCALE_REQUEST_HEADER", () => {
  it("is a stable, lowercase header name", () => {
    expect(SITE_LOCALE_REQUEST_HEADER).toBe("x-novel-locale");
  });
});
