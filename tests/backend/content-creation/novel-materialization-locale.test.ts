import { describe, expect, it } from "vitest";

import { evaluateNovelMaterializationLocale } from "@/domain/novel-materialization-locale";
import { deriveLocale } from "@/server/content-creation/shared";

describe("novel materialization locale eligibility", () => {
  it.each([null, "", "   "])("classifies missing locale %p consistently", (sourceLocale) => {
    expect(evaluateNovelMaterializationLocale(sourceLocale)).toEqual({
      eligible: false,
      code: "missing_locale",
    });
    expect(() => deriveLocale(sourceLocale)).toThrowError(expect.objectContaining({ code: "missing_locale" }));
  });

  it.each(["fil", "tr", "it", "ms"])("classifies unsupported locale %s consistently", (sourceLocale) => {
    expect(evaluateNovelMaterializationLocale(sourceLocale)).toEqual({
      eligible: false,
      code: "unsupported_locale",
    });
    expect(() => deriveLocale(sourceLocale)).toThrowError(expect.objectContaining({ code: "unsupported_locale" }));
  });

  it.each(["en", "ru", "zh-Hant"] as const)("returns exact registered locale %s", (sourceLocale) => {
    expect(evaluateNovelMaterializationLocale(sourceLocale)).toEqual({ eligible: true, locale: sourceLocale });
    expect(deriveLocale(sourceLocale)).toBe(sourceLocale);
  });

  it("does not normalize an otherwise recognizable locale", () => {
    expect(evaluateNovelMaterializationLocale(" EN ")).toEqual({
      eligible: false,
      code: "unsupported_locale",
    });
  });
});
