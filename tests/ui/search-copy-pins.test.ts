import { describe, expect, it } from "vitest";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { CATALOGS } from "@/lib/locale/messages";

/**
 * PN-15 站内搜索译文逐字钉住（v0.5.14，第三方 GPT 验收 ACCEPT_WITH_FIXES，Owner 2026-10-09 同意）。
 *
 * 为什么要钉：`messages-completeness` 只检查"键齐全、占位符一致、不是英文残留"，
 * 搜索页的其它用例又都经 `getPublicT()` 动态取值——于是把译文改回旧写法没有任何用例会变红。
 * 这里按**原始语种目录**（`CATALOGS`，不经英文兜底合并）逐字比对，改动必须连同本用例一起改。
 *
 * 特殊引号一律用码点常量拼，不在源码里直接写弯引号/直引号，避免编辑器或格式化工具悄悄把它们换掉：
 *   ar  « = U+00AB, » = U+00BB
 *   ko  ASCII 直双引号 U+0022（沿用同语种其它 search 键的写法）
 *   pl  „ = U+201E, ” = U+201D
 */
const AR_OPEN = String.fromCodePoint(0x00ab);
const AR_CLOSE = String.fromCodePoint(0x00bb);
const ASCII_DQUOTE = String.fromCodePoint(0x0022);
const PL_OPEN = String.fromCodePoint(0x201e);
const PL_CLOSE = String.fromCodePoint(0x201d);

type SearchKey = "metaDescription" | "inputLabel";

const PINS: ReadonlyArray<{ locale: SiteLocale; key: SearchKey; value: string }> = [
  {
    locale: "ar",
    key: "metaDescription",
    value: `نتائج البحث عن ${AR_OPEN}{query}${AR_CLOSE} على PulseNovel. اكتشف الروايات وابدأ بقراءة فصول مجانية.`,
  },
  {
    locale: "ko",
    key: "metaDescription",
    value: `PulseNovel에서 ${ASCII_DQUOTE}{query}${ASCII_DQUOTE}에 대한 검색 결과입니다. 소설을 만나보고 무료 챕터부터 읽어보세요.`,
  },
  {
    locale: "pl",
    key: "metaDescription",
    value: `Wyniki wyszukiwania dla ${PL_OPEN}{query}${PL_CLOSE} w serwisie PulseNovel. Odkrywaj powieści i zacznij czytać darmowe rozdziały.`,
  },
  {
    locale: "vi",
    key: "inputLabel",
    value: "Tìm tiểu thuyết theo tên sách",
  },
];

function rawSearchValue(locale: SiteLocale, key: SearchKey): unknown {
  const catalog = CATALOGS[locale] as unknown as { search?: Record<string, unknown> };
  return catalog.search?.[key];
}

describe("search.* 译文逐字钉住（PN-15 / v0.5.14 GPT 验收修正）", () => {
  it.each(PINS)("$locale: search.$key 与验收定稿逐码点一致", ({ locale, key, value }) => {
    const actual = rawSearchValue(locale, key);
    expect(actual).toBe(value);
    // 逐码点对比：失败时能直接看到第一个不同的码点，而不是两串肉眼难辨的引号。
    const toCodePoints = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(4, "0"));
    expect(toCodePoints(String(actual))).toEqual(toCodePoints(value));
  });

  it("三条 metaDescription 都保留 {query} 占位符，且占位符被各自语种的成对引号包住", () => {
    const quoted: ReadonlyArray<readonly [SiteLocale, string, string]> = [
      ["ar", AR_OPEN, AR_CLOSE],
      ["ko", ASCII_DQUOTE, ASCII_DQUOTE],
      ["pl", PL_OPEN, PL_CLOSE],
    ];
    for (const [locale, open, close] of quoted) {
      expect(rawSearchValue(locale, "metaDescription"), locale).toContain(`${open}{query}${close}`);
    }
  });
});
