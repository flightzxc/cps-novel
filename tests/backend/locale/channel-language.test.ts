import { describe, expect, it } from "vitest";

import {
  MAPPING_VERSION,
  MOBOREADER_LANGUAGE_CODE_TO_LOCALE,
  MOBOREADER_SOURCE_APP_CODE,
  UNKNOWN_SOURCE_LOCALE_FILTER,
  evaluateLanguageMappingSuspensions,
  resolveChannelLanguage,
  type ChannelLanguageWarning,
} from "@/lib/locale/channel-language";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

/**
 * `施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md` §1.H.
 *
 * CPS `3a76877:tests/channel-language.test.ts` is a `node:test` file whose
 * cases mostly exercise multi-channel/multi-source-app registry
 * differences (`beidou` vs `changdu_moboreels` vs `changdu_flickreels`
 * mapping the same numeric code to different locales) — this repo has
 * exactly one source app, so that dimension doesn't exist here and those
 * specific cases don't port. What DOES port 1:1 is `evaluateLanguageMapping
 * Suspensions`'s threshold behavior (verbatim COPY, see `channel-language.ts`)
 * and the resolution precedence (code > name alias > unknown) — those are
 * this file's spine, ADAPTed to vitest and to the moboreader single-registry
 * shape. See `docs/governance/port-registry.md`'s L10N P1 section for the
 * full COPY/ADAPT line mapping.
 *
 * Code-table snapshot values come from
 * `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md` (this
 * repo's own X8 evidence), not from CPS — CPS's changdu table is a
 * cross-check reference only, never the source of truth for this repo.
 */

describe("channel-language · moboreader 18 码表快照", () => {
  it("与证据文档逐条一致，一个不多一个不少", () => {
    expect(MOBOREADER_LANGUAGE_CODE_TO_LOCALE).toEqual({
      "2": "zh-Hant",
      "3": "en",
      "4": "es",
      "5": "pt-BR",
      "6": "fr",
      "7": "ru",
      "8": "it",
      "9": "ja",
      "10": "ar",
      "11": "id",
      "12": "th",
      "13": "vi",
      "14": "ko",
      "15": "fil",
      "16": "de",
      "21": "ms",
      "22": "tr",
      "23": "pl",
    });
    expect(Object.keys(MOBOREADER_LANGUAGE_CODE_TO_LOCALE)).toHaveLength(18);
  });

  it("MAPPING_VERSION 与 sourceAppCode 已钉死", () => {
    expect(MAPPING_VERSION).toBe("channel-language:moboreader:v1:2026-09-10");
    expect(MOBOREADER_SOURCE_APP_CODE).toBe("moboreader");
    expect(UNKNOWN_SOURCE_LOCALE_FILTER).toBe("__unknown");
  });

  it.each(
    Object.entries(MOBOREADER_LANGUAGE_CODE_TO_LOCALE) as Array<[string, string]>,
  )("code %s → %s，confidence=code，confirmed_code_mapping", (code, locale) => {
    const resolution = resolveChannelLanguage({ sourceLanguageCode: code });
    expect(resolution.locale).toBe(locale);
    expect(resolution.confidence).toBe("code");
    expect(resolution.evidence).toBe("confirmed_code_mapping");
    expect(resolution.sourceAppCode).toBe("moboreader");
    expect(resolution.warning).toBeNull();
  });

  it("sourceAppCode 省略时默认 moboreader", () => {
    const withDefault = resolveChannelLanguage({ sourceLanguageCode: "3" });
    const explicit = resolveChannelLanguage({ sourceAppCode: "moboreader", sourceLanguageCode: "3" });
    expect(withDefault).toEqual(explicit);
  });

  it("未注册的 sourceAppCode 不解析——码表按 sourceApp 索引，不是全局唯一码空间", () => {
    const resolution = resolveChannelLanguage({ sourceAppCode: "some-other-app", sourceLanguageCode: "3" });
    expect(resolution.locale).toBeNull();
    expect(resolution.confidence).toBe("unknown");
  });
});

describe("channel-language · code 19/20 无成对证据 → null（MAPPING_EVIDENCE_MISSING）", () => {
  it.each(["19", "20", 19, 20])("code %s → locale null, confidence unknown", (code) => {
    const resolution = resolveChannelLanguage({ sourceLanguageCode: code });
    expect(resolution.locale).toBeNull();
    expect(resolution.confidence).toBe("unknown");
    expect(resolution.evidence).toBe("unknown");
  });

  it("19/20 不在 MOBOREADER_LANGUAGE_CODE_TO_LOCALE 里——不是漏读，是压根没登记", () => {
    expect(MOBOREADER_LANGUAGE_CODE_TO_LOCALE).not.toHaveProperty("19");
    expect(MOBOREADER_LANGUAGE_CODE_TO_LOCALE).not.toHaveProperty("20");
  });
});

describe("channel-language · it/fil/ms/tr 解析成功但非站点语种", () => {
  it.each([
    ["8", "it"],
    ["15", "fil"],
    ["21", "ms"],
    ["22", "tr"],
  ])("code %s → %s，解析成功但不是 SITE_LOCALES 成员", (code, locale) => {
    const resolution = resolveChannelLanguage({ sourceLanguageCode: code });
    expect(resolution.locale).toBe(locale);
    expect(SITE_LOCALES as readonly string[]).not.toContain(locale);
  });
});

describe("channel-language · 别名命中（name_alias）", () => {
  it("已注册的中文/英文文案在 code 未命中时解得出 locale", () => {
    for (const [name, locale] of [
      ["英语", "en"],
      ["English", "en"],
      ["english", "en"],
      ["俄语", "ru"],
      ["Russian", "ru"],
      ["西班牙语", "es"],
      ["繁体", "zh-Hant"],
      ["繁體", "zh-Hant"],
    ] as const) {
      const resolution = resolveChannelLanguage({ sourceLanguageCode: "9999", sourceLanguageName: name });
      expect(resolution.locale, `${name} → ${locale}`).toBe(locale);
      expect(resolution.confidence).toBe("name_alias");
      expect(resolution.evidence).toBe("confirmed_name_alias");
    }
  });

  it("简体中文文案显式落 null，不折叠进 zh-Hant 或任何 locale", () => {
    for (const name of ["简体中文", "简体", "簡體", "zh", "zh-CN", "chinese"]) {
      const resolution = resolveChannelLanguage({ sourceLanguageCode: "9999", sourceLanguageName: name });
      expect(resolution.locale, `${name} 不该解出 locale`).toBeNull();
      expect(resolution.confidence).toBe("unknown");
    }
  });

  it("code 命中优先于 name，且冲突时产出 code_name_conflict warning", () => {
    // code=3 → en，name="俄语" → ru：两者不一致，locale 仍取 code 结果，但产出 warning。
    const resolution = resolveChannelLanguage({ sourceLanguageCode: "3", sourceLanguageName: "俄语" });
    expect(resolution.locale).toBe("en");
    expect(resolution.confidence).toBe("code");
    expect(resolution.warning).toEqual<ChannelLanguageWarning>({
      type: "code_name_conflict",
      sourceAppCode: "moboreader",
      rawSourceLanguageCode: "3",
      resolvedLocale: "en",
      evidence: "confirmed_code_mapping",
      codeLocale: "en",
      nameLocale: "ru",
      sourceLanguageCode: "3",
      sourceLanguageName: "俄语",
    });
  });

  it("code 与 name 一致时不产出 warning", () => {
    const resolution = resolveChannelLanguage({ sourceLanguageCode: "3", sourceLanguageName: "英语" });
    expect(resolution.locale).toBe("en");
    expect(resolution.warning).toBeNull();
  });
});

describe("channel-language · 从不返回字面串 \"unknown\"——unknown 只能是 confidence 取值，locale 恒为 null", () => {
  it.each([
    [null, null],
    ["1", null],
    ["17", null],
    ["24", null],
    ["19", null],
    ["20", null],
    ["9999", "俄罗斯语"],
    ["9999", ""],
  ])("code=%s name=%s → locale 是 null 而不是字符串 \"unknown\"", (code, name) => {
    const resolution = resolveChannelLanguage({ sourceLanguageCode: code, sourceLanguageName: name });
    expect(resolution.locale).not.toBe("unknown");
    expect(resolution.locale).toBeNull();
  });

  it("worker 写库口径：sourceLocale 只能是已解析 locale 或 null，永不写字面串 \"unknown\"", () => {
    // worker/handlers/moboreader.ts 的写入表达式是
    // `suspendedLanguageCodes.has(...) ? null : (resolution.locale ?? null)`——
    // 对任何输入，`resolution.locale` 本身就不可能是字符串 "unknown"（上面
    // 整组用例已穷举验证），所以这条不变量在源头就成立，写入前无需再做
    // 一次字符串比较兜底。
    for (const code of ["1", "2", "3", "19", "20", "9999"]) {
      const resolution = resolveChannelLanguage({ sourceLanguageCode: code });
      const sourceLocale = resolution.locale ?? null;
      expect(sourceLocale).not.toBe("unknown");
    }
  });
});

describe("channel-language · evaluateLanguageMappingSuspensions 熔断 10/3/20% 三阈值边界", () => {
  function conflictWarning(sourceLanguageCode: string): ChannelLanguageWarning {
    return {
      type: "code_name_conflict",
      sourceAppCode: "moboreader",
      rawSourceLanguageCode: sourceLanguageCode,
      resolvedLocale: "en",
      evidence: "confirmed_code_mapping",
      codeLocale: "en",
      nameLocale: "id",
      sourceLanguageCode,
      sourceLanguageName: "Indonesian",
    };
  }

  function makeBatch(total: number, conflicts: number, sourceLanguageCode = "3") {
    return Array.from({ length: total }, (_, index) => ({
      sourceLanguageCode,
      warning: index < conflicts ? conflictWarning(sourceLanguageCode) : null,
    }));
  }

  it("9 总量 / 3 冲突（rate=0.33）→ 不触发：total 未达 10", () => {
    expect(evaluateLanguageMappingSuspensions(makeBatch(9, 3)).has("3")).toBe(false);
  });

  it("10 总量 / 2 冲突（rate=0.2）→ 不触发：conflicts 未达 3", () => {
    expect(evaluateLanguageMappingSuspensions(makeBatch(10, 2)).has("3")).toBe(false);
  });

  it(
    // 施工提示词原文写的是「10/3/0.19 不触发」，但 3/10 恒等于 0.3，不可能是
    // 0.19——三阈值边界要独立验证 rate 这一维，用满足 total>=10 且
    // conflicts>=3、但 rate<0.2 的真实组合（16 总量/3 冲突=0.1875≈0.19）替
    // 换，判定记入报告 ⑦「规划与代码事实冲突，按最接近原意的做法处理」。
    "16 总量 / 3 冲突（rate=0.1875≈0.19）→ 不触发：rate 未达 0.2（施工提示词「10/3/0.19」的算术更正，见 ⑦）",
    () => {
      expect(evaluateLanguageMappingSuspensions(makeBatch(16, 3)).has("3")).toBe(false);
    },
  );

  it("10 总量 / 3 冲突（rate=0.3）→ 触发：三条件同时满足", () => {
    expect(evaluateLanguageMappingSuspensions(makeBatch(10, 3)).has("3")).toBe(true);
  });

  it("只熔断命中阈值的那个 sourceLanguageCode，不殃及同批次其它码", () => {
    const suspended = evaluateLanguageMappingSuspensions([
      ...makeBatch(10, 3, "3"),
      ...makeBatch(10, 0, "7"),
    ]);
    expect(suspended.has("3")).toBe(true);
    expect(suspended.has("7")).toBe(false);
  });

  it("空批次不熔断任何码", () => {
    expect(evaluateLanguageMappingSuspensions([]).size).toBe(0);
  });
});
