import { describe, expect, it } from "vitest";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { CATALOGS, getPublicT, t as renderWithCatalog, type Messages } from "@/lib/locale/messages";
import { SITE_SEARCH_MAX_QUERY_LENGTH, SITE_SEARCH_MIN_QUERY_LENGTH } from "@/lib/site-search/types";

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

/**
 * 第二件事（同一份验收）：捷克语、波兰语的数词词形。
 *
 * 这两个语种的名词随数字变：1 → znak，2～4 → znaky（cs）/ znaki（pl），5 及以上 → znaků（cs）/ znaków（pl）。
 * 最短长度常量 `SITE_SEARCH_MIN_QUERY_LENGTH` 是 2，所以写死 "znaků" / "znaków" 会显示成错误的 "2 znaků"。
 * 渲染路径：`SearchScreen` → `getPublicT` → `t()` → intl-messageformat，支持 ICU plural，
 * 因此 4 条文案改写成 plural，**常量以后改成别的值，词形自动跟着变，不需要有人记得回来改文案**。
 * 下面的表是人工核对过的期望值（不从 Intl.PluralRules 推导，否则等于拿答案对答案）。
 */
describe("search.hintMinLength / hintMaxLength：cs、pl 的名词形式随数字变", () => {
  const MIN_CASES: ReadonlyArray<readonly [number, string, string]> = [
    [1, "Zadejte alespoň 1 znak pro vyhledávání.", "Wpisz co najmniej 1 znak, aby wyszukać."],
    [2, "Zadejte alespoň 2 znaky pro vyhledávání.", "Wpisz co najmniej 2 znaki, aby wyszukać."],
    [3, "Zadejte alespoň 3 znaky pro vyhledávání.", "Wpisz co najmniej 3 znaki, aby wyszukać."],
    [4, "Zadejte alespoň 4 znaky pro vyhledávání.", "Wpisz co najmniej 4 znaki, aby wyszukać."],
    [5, "Zadejte alespoň 5 znaků pro vyhledávání.", "Wpisz co najmniej 5 znaków, aby wyszukać."],
    // 波兰语 12～14 属 many（不是 few）；22～24 回到 few；捷克语 12、22 都是 other。
    [12, "Zadejte alespoň 12 znaků pro vyhledávání.", "Wpisz co najmniej 12 znaków, aby wyszukać."],
    [22, "Zadejte alespoň 22 znaků pro vyhledávání.", "Wpisz co najmniej 22 znaki, aby wyszukać."],
    [25, "Zadejte alespoň 25 znaků pro vyhledávání.", "Wpisz co najmniej 25 znaków, aby wyszukać."],
  ];

  const MAX_CASES: ReadonlyArray<readonly [number, string, string]> = [
    [1, "Zadejte nejvýše 1 znak.", "Wpisz maksymalnie 1 znak."],
    [2, "Zadejte nejvýše 2 znaky.", "Wpisz maksymalnie 2 znaki."],
    [4, "Zadejte nejvýše 4 znaky.", "Wpisz maksymalnie 4 znaki."],
    [5, "Zadejte nejvýše 5 znaků.", "Wpisz maksymalnie 5 znaków."],
    [22, "Zadejte nejvýše 22 znaků.", "Wpisz maksymalnie 22 znaki."],
    [500, "Zadejte nejvýše 500 znaků.", "Wpisz maksymalnie 500 znaków."],
  ];

  it.each(MIN_CASES)("hintMinLength min=%i", (n, cs, pl) => {
    expect(getPublicT("cs")("search.hintMinLength", { min: n })).toBe(cs);
    expect(getPublicT("pl")("search.hintMinLength", { min: n })).toBe(pl);
  });

  it.each(MAX_CASES)("hintMaxLength max=%i", (n, cs, pl) => {
    expect(getPublicT("cs")("search.hintMaxLength", { max: n })).toBe(cs);
    expect(getPublicT("pl")("search.hintMaxLength", { max: n })).toBe(pl);
  });

  // 页面实际传入的是这两个常量。名词形式按 Intl.PluralRules 选出的类别查表（表里是各类别的正确词形），
  // 所以常量改成任何整数这条都不会误报，只会在"词形没跟着数字走"时变红。
  const NOUN_BY_CATEGORY = {
    cs: { one: "znak", few: "znaky", many: "znaku", other: "znaků" },
    pl: { one: "znak", few: "znaki", many: "znaków", other: "znaku" },
  } as const;

  it.each(["cs", "pl"] as const)("%s: 页面实际用的最短/最长常量渲染出与其数值对应的词形", (locale) => {
    const t = getPublicT(locale);
    const rules = new Intl.PluralRules(locale);
    const nounFor = (n: number) => NOUN_BY_CATEGORY[locale][rules.select(n) as keyof (typeof NOUN_BY_CATEGORY)["cs"]];
    expect(t("search.hintMinLength", { min: SITE_SEARCH_MIN_QUERY_LENGTH })).toContain(
      `${SITE_SEARCH_MIN_QUERY_LENGTH} ${nounFor(SITE_SEARCH_MIN_QUERY_LENGTH)}`,
    );
    expect(t("search.hintMaxLength", { max: SITE_SEARCH_MAX_QUERY_LENGTH })).toContain(
      `${SITE_SEARCH_MAX_QUERY_LENGTH} ${nounFor(SITE_SEARCH_MAX_QUERY_LENGTH)}`,
    );
  });

  it("俄语 \"не менее / не более {n} символов\" 是正确的属格用法，不随本次修正改动", () => {
    const t = getPublicT("ru");
    expect(t("search.hintMinLength", { min: 2 })).toBe("Введите не менее 2 символов для поиска.");
    expect(t("search.hintMaxLength", { max: 500 })).toBe("Введите не более 500 символов.");
  });
});

/**
 * 第三件事（v0.5.15 紧随 cs/pl 之后）：阿拉伯语的数词词形。
 *
 * 阿语名词随数字变六种形式（CLDR：zero/one/two/few/many/other），且这两句里数词短语是动词 أدخل 的宾语（宾格）：
 *   0（zero）    数字 + 单数名词            "0 حرف"（沿用 other 的写法；0 不是真实取值，仅为满足"六类写全"的守卫）
 *   1（one）     宾格单数 + 形容词，不带数字  "حرفًا واحدًا"
 *   2（two）     宾格双数，不带数字          "حرفين"（不写成 "2 حرفين"）
 *   3～10（few） 数字 + 复数名词            "3 أحرف"
 *   11～99（many）数字 + 宾格不定单数        "11 حرفًا"
 *   100 起（other）数字 + 属格单数           "100 حرف"、"500 حرف"（旧写法 "500 حرفًا" 是错的）
 * 最短长度常量是 2，旧文案写死 "حرفًا" 会显示成 "2 حرفًا"（应为双数 "حرفين"）。
 *
 * 期望表是人工核对过的字面值（不从 Intl.PluralRules 推导，否则等于拿答案对答案）；类别一列另用 Intl.PluralRules 核对，
 * 这样 Node/ICU 版本升级改变了某个数落入的类别时，是这里变红，而不是被悄悄吞掉。
 * 渲染走原始阿语目录（CATALOGS.ar，不经 loadMessages 的英文兜底合并）+ 真实 t()：
 * 若 ar 的这两个键被删掉或改空，不会被英文文案悄悄补上。
 */
describe("search.hintMinLength / hintMaxLength：ar 的名词形式随数字变（六类全覆盖）", () => {
  type ArCategory = "zero" | "one" | "two" | "few" | "many" | "other";

  const AR_CASES: ReadonlyArray<readonly [number, ArCategory, string, string]> = [
    [0, "zero", "أدخل 0 حرف على الأقل للبحث.", "أدخل بحد أقصى 0 حرف."],
    [1, "one", "أدخل حرفًا واحدًا على الأقل للبحث.", "أدخل بحد أقصى حرفًا واحدًا."],
    [2, "two", "أدخل حرفين على الأقل للبحث.", "أدخل بحد أقصى حرفين."],
    [3, "few", "أدخل 3 أحرف على الأقل للبحث.", "أدخل بحد أقصى 3 أحرف."],
    [10, "few", "أدخل 10 أحرف على الأقل للبحث.", "أدخل بحد أقصى 10 أحرف."],
    [11, "many", "أدخل 11 حرفًا على الأقل للبحث.", "أدخل بحد أقصى 11 حرفًا."],
    [99, "many", "أدخل 99 حرفًا على الأقل للبحث.", "أدخل بحد أقصى 99 حرفًا."],
    [100, "other", "أدخل 100 حرف على الأقل للبحث.", "أدخل بحد أقصى 100 حرف."],
    [101, "other", "أدخل 101 حرف على الأقل للبحث.", "أدخل بحد أقصى 101 حرف."],
    [102, "other", "أدخل 102 حرف على الأقل للبحث.", "أدخل بحد أقصى 102 حرف."],
    [500, "other", "أدخل 500 حرف على الأقل للبحث.", "أدخل بحد أقصى 500 حرف."],
  ];

  const renderRawAr = (key: "search.hintMinLength" | "search.hintMaxLength", vars: { min: number } | { max: number }) =>
    renderWithCatalog(CATALOGS.ar as unknown as Messages, key, "ar", vars);

  it("期望表覆盖阿语全部六个 CLDR 类别，且每行的类别与运行时 Intl.PluralRules 一致", () => {
    const rules = new Intl.PluralRules("ar");
    expect(new Set(AR_CASES.map(([, category]) => category))).toEqual(new Set(rules.resolvedOptions().pluralCategories));
    for (const [n, category] of AR_CASES) {
      expect(rules.select(n), `n=${n}`).toBe(category);
    }
  });

  it.each(AR_CASES)("n=%i（%s）：hintMinLength / hintMaxLength 渲染出对应词形", (n, _category, min, max) => {
    expect(renderRawAr("search.hintMinLength", { min: n })).toBe(min);
    expect(renderRawAr("search.hintMaxLength", { max: n })).toBe(max);
  });

  // 页面实际传入的是这两个常量。词形按 Intl.PluralRules 选出的类别查表（表里是各类别的正确写法），
  // 所以常量改成任何整数这条都不会误报，只会在"词形没跟着数字走"时变红。
  const PHRASE_BY_CATEGORY: Readonly<Record<ArCategory, (n: number) => string>> = {
    zero: (n) => `${n} حرف`,
    one: () => "حرفًا واحدًا",
    two: () => "حرفين",
    few: (n) => `${n} أحرف`,
    many: (n) => `${n} حرفًا`,
    other: (n) => `${n} حرف`,
  };

  it("页面实际用的最短/最长常量渲染出与其数值对应的词形（逐字）", () => {
    const rules = new Intl.PluralRules("ar");
    const phraseFor = (n: number) => PHRASE_BY_CATEGORY[rules.select(n) as ArCategory](n);
    expect(renderRawAr("search.hintMinLength", { min: SITE_SEARCH_MIN_QUERY_LENGTH })).toBe(
      `أدخل ${phraseFor(SITE_SEARCH_MIN_QUERY_LENGTH)} على الأقل للبحث.`,
    );
    expect(renderRawAr("search.hintMaxLength", { max: SITE_SEARCH_MAX_QUERY_LENGTH })).toBe(
      `أدخل بحد أقصى ${phraseFor(SITE_SEARCH_MAX_QUERY_LENGTH)}.`,
    );
  });
});
