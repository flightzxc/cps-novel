import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ARTICLE_TEMPLATE_CRUD_LANDED,
  SITE_LOCALES,
  assertPublishableLocalesFailClosed,
  isPublishableLocale,
  listPublishableLocales,
  resolveSiteLocale,
} from "@/lib/locale/locale-canonical";

/**
 * 语种归一唯一真源（曾在 `docs/p1/P1_SHARED_CONTRACTS.md` §2 标记 `FROZEN`；
 * L10N P1〔`施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md`〕已按
 * Owner 批准的预研裁决改造该契约本身——旧签名 `resolveSiteLocale(...) →
 * SiteLocale | "unknown"` 换成 CPS 形状 `{ locale, confidence }`，
 * `P1_SHARED_CONTRACTS.md` 已同步更新，不再是与本文件冲突的第二份口径）。
 *
 * 验三件事：三个对外 API 的存在与语义、fail-closed 的边界、以及「全仓只有一处
 * 映射」这条纪律确实成立（`resolve Site Locale`/`isPublishableLocale`/
 * `listPublishableLocales` 三个签名定义只能住在 `locale-canonical.ts`；上游码
 * 表/别名表/`resolveChannelLanguage` 只能住在委托目标 `channel-language.ts`——
 * 两个文件合起来才是唯一真源，其余任何文件都不得再造）。第三条是这个模块存在
 * 的**全部理由**——CPS 因映射散落四处付过两次全库 normalize 的代价，所以它
 * 必须是自动化断言，不能只写在 README 里。
 *
 * L10N P1（2026-09-10）：上游登记表从 P0-S15 的 2 码子集（`3→en`/`7→ru`）扩到
 * 18 码（`docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`
 * 的真实成对证据），别名表从"只登记过'英语'/'俄语'两个中文名"扩为 CPS
 * `channel-language.ts` 的完整别名表（含大量英文名）。凡是本文件旧版本里靠
 * "这个名字/这个码没有登记"论证 unknown 的用例，逐条核对是否被 P1 扩表打破，
 * 打破的一律换成真正仍未登记的取值，而不是就地删除断言。
 *
 * 🔴 发布白名单现为 `{en}`（U6 Owner D-7 明示放行），P1 未改动。登记表扩到
 * 18 项不自动等于可发布——「解出 locale」「是站点语种」「可发布」是三道各自
 * 独立的闸，见专门的边界用例。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const CANONICAL_PATH = "src/lib/locale/locale-canonical.ts";
const CHANNEL_LANGUAGE_PATH = "src/lib/locale/channel-language.ts";
/**
 * L10N P1: the upstream code/alias tables and `resolveChannelLanguage` now
 * live in `channel-language.ts`, which `locale-canonical.ts` delegates to —
 * together they are the one true source, so both paths are excluded from the
 * "no second mapping table" / "no second normalize implementation" scans
 * below. Anything outside these two files is still a violation.
 */
const CANONICAL_SOURCE_PATHS: readonly string[] = [CANONICAL_PATH, CHANNEL_LANGUAGE_PATH];
const canonicalSource = readFileSync(resolve(repoRoot, CANONICAL_PATH), "utf8");

/** 递归收集一批目录下的 .ts / .tsx。 */
function sourceFiles(roots: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // 目录不存在（worker/ 等本轮尚未落地）
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next") continue;
      const target = join(dir, entry);
      if (statSync(target).isDirectory()) walk(target);
      else if (/\.tsx?$/.test(target)) found.push(target);
    }
  };
  for (const root of roots) walk(resolve(repoRoot, root));
  return found;
}

const ALL_SOURCES = sourceFiles(["src", "worker", "scheduler", "scripts", "tests"]);

describe("locale 唯一真源 · 冻结 API", () => {
  it("文件就在 README 冻结的路径上", () => {
    expect(statSync(resolve(repoRoot, CANONICAL_PATH)).isFile()).toBe(true);
  });

  it("导出契约冻结的三个函数，一个不多一个不少", () => {
    expect(typeof resolveSiteLocale).toBe("function");
    expect(typeof isPublishableLocale).toBe("function");
    expect(typeof listPublishableLocales).toBe("function");

    // 冻结签名是 resolveSiteLocale(upstreamLanguageCode, upstreamLanguageName?)：
    // 两个声明形参。TS 的可选参数没有默认值，所以照样计入 Function.length。
    expect(resolveSiteLocale.length).toBe(2);
    expect(isPublishableLocale.length).toBe(1);
    expect(listPublishableLocales.length).toBe(0);
  });

  it("站点 locale 集合是冻结的，对齐短剧站 15 语（P0-S7a Owner 裁决）", () => {
    expect([...SITE_LOCALES]).toEqual([
      "en",
      "es",
      "pt-BR",
      "id",
      "vi",
      "th",
      "ja",
      "ko",
      "zh-Hant",
      "ar",
      "fr",
      "de",
      "pl",
      "cs",
      "ru",
    ]);
    expect(Object.isFrozen(SITE_LOCALES)).toBe(true);
  });

  it("登记表扩到 15 语后，仍不包含 CPS 的别名写法（pt / zh-TW 折叠进 pt-BR / zh-Hant）", () => {
    expect(SITE_LOCALES).not.toContain("pt");
    expect(SITE_LOCALES).not.toContain("zh-TW");
  });
});

describe("locale 唯一真源 · resolveSiteLocale 映射不到就是 { locale: null, confidence: \"unknown\" }", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["空串", ""],
    // L10N P1 把登记表从 {3,7} 扩到 18 码（见下方专门的 describe 块），
    // 这里改用登记表仍未覆盖的数值码，验的仍是「未登记就是 unknown」。
    ["未登记的数值码 · 1", 1],
    ["未登记数值码的字符串写法 · 1", "1"],
    ["未登记的数值码 · 17（CPS changdu_moboreels 有 17→hi，moboreader 无此码）", 17],
    ["未登记的数值码 · 18", 18],
    ["未登记的数值码 · 24（CPS 北斗表有 24→cs，moboreader 无此码）", 24],
    // 19/20：上游 languageName 为 JSON null，零成对证据，MAPPING_EVIDENCE_MISSING。
    ["无名码 19（MAPPING_EVIDENCE_MISSING）", 19],
    ["无名码 20（MAPPING_EVIDENCE_MISSING）", 20],
    ["负数", -1],
    ["小数", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["布尔", true],
    ["对象", {}],
    ["数组", []],
    // 以下两项特意用「登记表里真实存在的码 3」拼出非法形态，证明即便码本身
    // 已登记，不精确匹配十进制整数写法照样不认。前导空格的情形不在这里——
    // 见下方专门用例，委托 channel-language.ts 后该写法已改为可识别。
    ["前导零写法（码本身已登记）", "03"],
    ["十六进制写法（码本身已登记）", "0x3"],
  ])("%s → unknown", (_label, input) => {
    expect(resolveSiteLocale(input)).toEqual({ locale: null, confidence: "unknown" });
  });

  it("🔴 前导/尾随空白会被裁剪后精确匹配（委托 channel-language.ts 的 `String(...).trim()`，与旧版 codeKey() 的行为差异——COPY CPS 算法时的已知、刻意变更）", () => {
    expect(resolveSiteLocale(" 3")).toEqual({ locale: "en", confidence: "code" });
    expect(resolveSiteLocale("3 ")).toEqual({ locale: "en", confidence: "code" });
  });

  it("🔴 长得像 locale 的字符串当作『码』传入也不认——上游码位给的是数值码，认字符串就是在猜（作为 languageName 传入是另一件事，见下方别名用例）", () => {
    for (const value of ["en", "EN", "en-US", "en_US", "eng"]) {
      expect(resolveSiteLocale(value), `${value} 不该被当码认成 locale`).toEqual({
        locale: null,
        confidence: "unknown",
      });
    }
  });

  it("languageName 精确匹配的别名之外，未登记文案一律 unknown", () => {
    // L10N P1 COPY 了 CPS 完整别名表（不只是「英语」「俄语」两个中文名），
    // 这里换成表里真正没有的取值：不精确的中文变体、法语的非规范写法、空串。
    for (const name of ["俄罗斯语", "Français", "法蘭西語", ""]) {
      expect(resolveSiteLocale(0, name)).toEqual({ locale: null, confidence: "unknown" });
    }
  });

  it("两个参数都给、且两者均未登记，也不会拼出一个 locale", () => {
    expect(resolveSiteLocale(1, "Foobarese")).toEqual({ locale: null, confidence: "unknown" });
  });
});

describe("locale 唯一真源 · 上游登记表（L10N P1，18 码）", () => {
  /**
   * 证据来源：`docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`
   * ——海阅自己 X8 库 `novel_source_item` 的真实成对 `(source_language_code,
   * source_language_name)` 样本，18 码全部有证据；CPS 表只做交叉核对。
   * 这组用例既锁定「已证 18 码全部解得出正确 locale、正确 confidence」，也
   * 锁定「code 19/20（无成对证据）依旧 unknown、不得推测补齐」——见上一个
   * describe 块。`it/fil/ms/tr` 解析成功但不是 `SITE_LOCALES` 成员，这里一并
   * 钉死，避免"能解析"被误当成"是站点语种"。
   */

  it.each([
    [2, "zh-Hant"],
    [3, "en"],
    [4, "es"],
    [5, "pt-BR"],
    [6, "fr"],
    [7, "ru"],
    [8, "it"],
    [9, "ja"],
    [10, "ar"],
    [11, "id"],
    [12, "th"],
    [13, "vi"],
    [14, "ko"],
    [15, "fil"],
    [16, "de"],
    [21, "ms"],
    [22, "tr"],
    [23, "pl"],
  ] as const)("code %i（及其字符串写法）→ %s，confidence=code", (code, locale) => {
    expect(resolveSiteLocale(code)).toEqual({ locale, confidence: "code" });
    expect(resolveSiteLocale(String(code))).toEqual({ locale, confidence: "code" });
  });

  it("🔴 it/fil/ms/tr 解析成功但不是 SITE_LOCALES 成员——「解析成功」≠「是站点语种」", () => {
    for (const locale of ["it", "fil", "ms", "tr"] as const) {
      expect(SITE_LOCALES).not.toContain(locale);
    }
    expect(resolveSiteLocale(8).locale).toBe("it");
    expect(resolveSiteLocale(15).locale).toBe("fil");
    expect(resolveSiteLocale(21).locale).toBe("ms");
    expect(resolveSiteLocale(22).locale).toBe("tr");
  });

  it("languageName 备用键：已登记文案精确匹配也能解出 locale，confidence=name_alias", () => {
    // code 传一个不在登记表里的值，逼 resolveSiteLocale 落到 name 兜底路径。
    expect(resolveSiteLocale(99, "英语")).toEqual({ locale: "en", confidence: "name_alias" });
    expect(resolveSiteLocale(99, "俄语")).toEqual({ locale: "ru", confidence: "name_alias" });
  });

  it("简体中文文案显式落 null——不猜成 zh-Hant 或任何其它 locale", () => {
    for (const name of ["简体中文", "简体", "簡體", "zh", "zh-CN"]) {
      expect(resolveSiteLocale(99, name)).toEqual({ locale: null, confidence: "unknown" });
    }
  });

  it("code 命中优先于 name：两者都给时不看 name", () => {
    // code=3 已经命中 en，name="俄语" 不会被查——name 只是 code 未命中时的
    // 备用键，不是覆盖，也不是二次校验。confidence 仍是 code。
    expect(resolveSiteLocale(3, "俄语")).toEqual({ locale: "en", confidence: "code" });
  });

  it("🔴 无名码 19/20 依旧 unknown——零成对证据，MAPPING_EVIDENCE_MISSING，不得推测补齐", () => {
    for (const code of [19, 20]) {
      expect(resolveSiteLocale(code)).toEqual({ locale: null, confidence: "unknown" });
      expect(resolveSiteLocale(String(code))).toEqual({ locale: null, confidence: "unknown" });
    }
  });

  it("🔴 登记表扩到 18 码不把未放行的 locale 送进白名单——映射成功与可发布仍是两道独立的闸", () => {
    expect(resolveSiteLocale(3).locale).toBe("en");
    expect(resolveSiteLocale(7).locale).toBe("ru");
    expect(isPublishableLocale("en")).toBe(true);
    expect(isPublishableLocale("ru")).toBe(false);
    expect(listPublishableLocales()).toEqual(["en"]);
  });
});

describe("locale 唯一真源 · 发布白名单 fail-closed", () => {
  it("白名单现为 {en}：Owner D-7 明示放行，其余 14 语仍拒绝", () => {
    expect(listPublishableLocales()).toEqual(["en"]);
    expect(isPublishableLocale("en")).toBe(true);
  });

  it("P0-S7a 的 15 语登记没有让非 en 绕过白名单闸——一个不多", () => {
    for (const locale of SITE_LOCALES) {
      expect(isPublishableLocale(locale), `${locale}`).toBe(locale === "en");
    }
  });

  it("白名单永远是站点 locale 的子集——不能发布一个站点都不认的语种", () => {
    for (const locale of listPublishableLocales()) {
      expect(SITE_LOCALES).toContain(locale);
    }
  });

  it("🔴 不做大小写折叠，也不做区域回退", () => {
    for (const value of ["EN", "En", "en-US", "en_US", "en-us", " en", "en "]) {
      expect(isPublishableLocale(value), `${value} 不该被当成 en`).toBe(false);
    }
  });

  it("非字符串输入一律拒绝，不抛异常", () => {
    for (const value of [null, undefined, 0, 1, true, {}, [], Number.NaN]) {
      expect(isPublishableLocale(value)).toBe(false);
    }
  });

  it("listPublishableLocales 返回副本，调用方改不动真源", () => {
    const first = listPublishableLocales();
    first.push("ru");
    expect(listPublishableLocales()).toEqual(["en"]);
    expect(listPublishableLocales()).not.toBe(first);
  });

  it("「映射成功」与「可发布」是两道独立的闸", () => {
    // ru 已映射、仍不可发布——en 可发布并不把两道闸合成一道。
    expect(SITE_LOCALES).toContain("ru");
    expect(resolveSiteLocale(7).locale).toBe("ru");
    expect(isPublishableLocale("ru")).toBe(false);
    expect(isPublishableLocale("en")).toBe(true);
  });
});

describe("locale 唯一真源 · 全仓不得有第二份映射", () => {
  it("三个冻结 API 只在唯一真源里定义", () => {
    const definitions: Record<string, string[]> = {
      resolveSiteLocale: [],
      isPublishableLocale: [],
      listPublishableLocales: [],
    };

    for (const file of ALL_SOURCES) {
      const source = readFileSync(file, "utf8");
      for (const name of Object.keys(definitions)) {
        // 只算定义，不算 import 与调用。
        if (new RegExp(`(?:function|const|let|var)\\s+${name}\\b`).test(source)) {
          definitions[name].push(relative(repoRoot, file));
        }
      }
    }

    for (const [name, files] of Object.entries(definitions)) {
      expect(files, `${name} 应当只有一处定义`).toEqual([CANONICAL_PATH]);
    }
  });

  it("没有第二张语种映射表", () => {
    // 找「名字带 locale/language 且值是字面量集合」的声明——第二份映射表长这样。
    const mappingDeclaration =
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*(?:LOCALE|LANGUAGE|Locale|Language)[\w$]*)\s*(?::[^=]+)?=\s*(?:new Map|new Set|\{|\[)/g;

    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const relativePath = relative(repoRoot, file);
      if (CANONICAL_SOURCE_PATHS.includes(relativePath)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(mappingDeclaration)) {
        offenders.push(`${relativePath} → ${match[1]}`);
      }
    }

    expect(offenders, "语种映射只能住在唯一真源里").toEqual([]);
  });

  it("没有第二份 locale normalize 实现", () => {
    const normalizeDeclaration =
      /(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(?:\([^)]*\)|[\w$]+)\s*=>|\()/g;
    const suspicious = /^(?:normalize|canonical|canonicalize|resolve|to|map|coerce)[\w$]*(?:Locale|Language|Lang)[\w$]*$/i;

    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const relativePath = relative(repoRoot, file);
      if (CANONICAL_SOURCE_PATHS.includes(relativePath)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(normalizeDeclaration)) {
        if (suspicious.test(match[1])) {
          offenders.push(`${relativePath} → ${match[1]}`);
        }
      }
    }

    expect(offenders, "locale 归一只能有一处实现").toEqual([]);
  });

  it("唯一真源自己不含区域回退或大小写折叠——那是最容易长出来的猜测", () => {
    // split("-") / slice(0,2) / toLowerCase() 是 region fallback 的典型写法。
    expect(canonicalSource).not.toMatch(/split\(\s*["']-["']\s*\)/);
    expect(canonicalSource).not.toMatch(/\.slice\(\s*0\s*,\s*2\s*\)/);
    expect(canonicalSource).not.toMatch(/toLowerCase\(\)|toUpperCase\(\)/);
    expect(canonicalSource).not.toMatch(/startsWith\(/);
  });
});

describe("locale 唯一真源 · D-7 条件二 fail-closed 守卫（S14）", () => {
  /**
   * 背景：CPS v6.0.4 事故——只注册了前台 locale，漏了后台模板枚举。Opus 终审
   * 对本仓库 D-7 条件二的裁定是「内置默认模板对 en 实质满足，但这份安全是
   * 巧合，不是机制」。这组用例验的正是「巧合已经变成机制」：只要
   * `ARTICLE_TEMPLATE_CRUD_LANDED` 还是 false，任何越出 `{"en"}` 的
   * `PUBLISHABLE_LOCALES` 配置都必须在断言执行的那一刻抛出，不能留到运行时。
   */

  it("模块常量今天确实是 false——这是守卫本身生效的前提，不是附带断言", () => {
    expect(ARTICLE_TEMPLATE_CRUD_LANDED).toBe(false);
  });

  it("真实模块加载不抛：当前 PUBLISHABLE_LOCALES 为 {\"en\"}，满足 ⊆ {\"en\"}", () => {
    // 走到这一行本身就是「真实模块加载没有抛」的证据——import 在文件顶部，
    // 若守卫在模块加载时抛出，整个测试文件都跑不起来。这里再显式断言一次
    // 前提事实，避免这条证据只靠"没崩"这种隐式信号。
    expect(listPublishableLocales()).toEqual(["en"]);
  });

  it("🔴 越界即抛：CRUD 未落地时，非 en 的 locale 混进白名单必须抛出", () => {
    expect(() => assertPublishableLocalesFailClosed(["es"], false)).toThrow(
      /D-7 条件二 fail-closed 守卫触发/,
    );
    expect(() => assertPublishableLocalesFailClosed(["en", "ja"], false)).toThrow(/ja/);
    expect(() => assertPublishableLocalesFailClosed(["en", "es", "ko"], false)).toThrow(
      /es, ko/,
    );
  });

  it("空集与 {\"en\"} 的任意子集都不抛——这两种是当前允许的唯一状态", () => {
    expect(() => assertPublishableLocalesFailClosed([], false)).not.toThrow();
    expect(() => assertPublishableLocalesFailClosed(["en"], false)).not.toThrow();
  });

  it("CRUD 落地后（articleTemplateCrudLanded=true）守卫让路，不再拦截", () => {
    expect(() => assertPublishableLocalesFailClosed(["es", "ja", "ko"], true)).not.toThrow();
  });

  it("错误信息里点名 CPS v6.0.4 事故——这是守卫来历的可追溯性，不是装饰", () => {
    expect(() => assertPublishableLocalesFailClosed(["fr"], false)).toThrow(/v6\.0\.4/);
  });
});
