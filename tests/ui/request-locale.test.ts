import { describe, expect, it } from "vitest";

import { pickPublishableLocale, SITE_LOCALE_REQUEST_HEADER } from "@/lib/site/request-locale";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.2): the shared
 * validate-with-fallback rule `src/proxy.ts` (building the request header)
 * and `src/app/layout.tsx` (reading it back for `<html lang>`) both apply.
 * Reads the SAME open/publishable locale gate as every other exit point
 * (`isPublishableLocale`) — today that gate is `{"en"}`, so anything other
 * than the literal string `"en"` falls back to `"en"`.
 */
describe("pickPublishableLocale", () => {
  it("accepts the one open locale (en) as-is", () => {
    expect(pickPublishableLocale("en")).toBe("en");
  });

  it("falls back to en for a registered-but-unopened locale", () => {
    for (const candidate of ["es", "fr", "ja", "ru", "ar", "zh-Hant", "pt-BR"]) {
      expect(pickPublishableLocale(candidate), candidate).toBe("en");
    }
  });

  it("falls back to en for missing/invalid input, never throws", () => {
    for (const candidate of [null, undefined, "", "not-a-locale", "EN", "en-US", 0, {}, []]) {
      expect(() => pickPublishableLocale(candidate)).not.toThrow();
      expect(pickPublishableLocale(candidate), JSON.stringify(candidate)).toBe("en");
    }
  });

  it("does not case-fold or region-fallback (consistent with the canonical gate's own no-guessing rule)", () => {
    expect(pickPublishableLocale("En")).toBe("en");
    expect(pickPublishableLocale(" en")).toBe("en");
    expect(pickPublishableLocale("en ")).toBe("en");
  });
});

describe("SITE_LOCALE_REQUEST_HEADER", () => {
  it("is a stable, lowercase header name", () => {
    expect(SITE_LOCALE_REQUEST_HEADER).toBe("x-novel-locale");
  });
});
