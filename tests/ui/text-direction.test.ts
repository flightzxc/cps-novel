import { describe, expect, it } from "vitest";

import { getTextDirection } from "@/lib/site/text-direction";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.2): the site's
 * sole `<html dir>` determination rule, ported from CPS's shared
 * `getTextDirection` helper (same regex, same semantics). CPS itself has
 * this exact rule implemented three separate times with no single caller —
 * this repo starts with (and stays at) one.
 */
describe("getTextDirection", () => {
  it("returns rtl for the four RTL-script locales, including region variants", () => {
    for (const locale of ["ar", "fa", "he", "ur", "ar-EG", "fa-IR", "he-IL", "ur-PK"]) {
      expect(getTextDirection(locale), locale).toBe("rtl");
    }
  });

  it("returns ltr for every registered non-RTL SiteLocale", () => {
    for (const locale of ["en", "es", "pt-BR", "id", "vi", "th", "ja", "ko", "zh-Hant", "fr", "de", "pl", "cs", "ru"]) {
      expect(getTextDirection(locale), locale).toBe("ltr");
    }
  });

  it("does not false-positive on a locale that merely starts with the same letters (arbitrary string safety)", () => {
    expect(getTextDirection("architecture")).toBe("ltr");
    expect(getTextDirection("art")).toBe("ltr");
    expect(getTextDirection("")).toBe("ltr");
  });
});
