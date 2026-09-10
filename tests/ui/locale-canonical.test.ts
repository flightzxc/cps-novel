import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SITE_LOCALES,
  resolveSiteLocale,
} from "@/lib/locale/locale-canonical";

/**
 * 语种归一唯一真源（曾在 `docs/p1/P1_SHARED_CONTRACTS.md` §2 标记 `FROZEN`；
 * L10N P1〔`施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md`〕已按
 * Owner 批准的预研裁决改造该契约本身——旧签名 `resolveSiteLocale(...) →
 * SiteLocale | "unknown"` 换成 CPS 形状 `{ locale, confidence }`，
 * `P1_SHARED_CONTRACTS.md` 已同步更新，不再是与本文件冲突的第二份口径）。
 *
 * L10N P4（2026-09-10）：发布白名单层（`PUBLISHABLE_LOCALES`/
 * `isPublishableLocale`/`listPublishableLocales`/`ARTICLE_TEMPLATE_CRUD_
 * LANDED`/`assertPublishableLocalesFailClosed`）已整体删除，不是改造——本文件
 * 原来验白名单 fail-closed 边界的所有用例（含旧版本 `:336` 的
 * `isPublishableLocale(value)).toBe(false)` 系列锁）一并删除。公开面现在是
 * CPS 同构的两层：**静态层** = `SITE_LOCALES`（本文件继续验），**动态层** =
 * `getActiveLocales()`/`queryActiveLocales()`（`src/lib/locale/active-locales.ts`，
 * ⊆ `SITE_LOCALES` 且恒含 `en`）——这一层需要 Prisma fixture db，本文件是
 * jsdom 环境的 `tests/ui` project，不适合放 DB 相关用例，完整行为覆盖在
 * `tests/backend/locale/active-locales.test.ts`（node project），不在本文件
 * 重复或改用不合适的 project。
 *
 * 验两件事：对外 API 的存在与语义、以及「全仓只有一处映射」这条纪律确实成立
 * （`resolveSiteLocale` 签名定义只能住在 `locale-canonical.ts`；上游码表/别名
 * 表/`resolveChannelLanguage` 只能住在委托目标 `channel-language.ts`——两个
 * 文件合起来才是唯一真源，其余任何文件都不得再造）。第二条是这个模块存在的
 * **全部理由**——CPS 因映射散落四处付过两次全库 normalize 的代价，所以它必须
 * 是自动化断言，不能只写在 README 里。
 *
 * L10N P1（2026-09-10）：上游登记表从 P0-S15 的 2 码子集（`3→en`/`7→ru`）扩到
 * 18 码（`docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`
 * 的真实成对证据），别名表从"只登记过'英语'/'俄语'两个中文名"扩为 CPS
 * `channel-language.ts` 的完整别名表（含大量英文名）。凡是本文件旧版本里靠
 * "这个名字/这个码没有登记"论证 unknown 的用例，逐条核对是否被 P1 扩表打破，
 * 打破的一律换成真正仍未登记的取值，而不是就地删除断言。
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
 * below. `channel-language.ts` is legitimately the *second* file in this
 * list (not a violation of "only one true source") precisely because
 * `locale-canonical.ts` delegates to it rather than reimplementing anything
 * — there is still exactly one mapping decision, it just lives across two
 * files by construction, the same way `README.md`'s "唯一真源" section
 * documents "两个文件合起来算一处". Anything outside these two files is
 * still a violation.
 */
const CANONICAL_SOURCE_PATHS: readonly string[] = [CANONICAL_PATH, CHANNEL_LANGUAGE_PATH];
const canonicalSource = readFileSync(resolve(repoRoot, CANONICAL_PATH), "utf8");

/**
 * Opus 复核 NON_BLOCKING a: `read-source-items.ts`'s `parseSourceLocaleFilter`
 * and `worker/handlers/moboreader.ts`'s `pickBookSourceLocale` both have
 * `Locale` in their name and live outside `CANONICAL_SOURCE_PATHS`, but
 * neither is a second locale-mapping/normalize implementation —
 * `parseSourceLocaleFilter` only classifies an already-resolved
 * `sourceLocale` string into an equality-filter shape (`__unknown` sentinel
 * / exact value / no filter); it never maps a code or name to a locale.
 * `pickBookSourceLocale` only picks between an already-resolved
 * `ChannelLanguageResolution.locale` and `null` based on the circuit
 * breaker's suspended-code set; it never calls the code table or alias
 * table either. The narrow `suspicious` verb-prefix regex below
 * (`normalize|canonical|.../resolve|to|map|coerce` + `Locale|Language|Lang`)
 * happens not to match either name — that is an accident of naming, not a
 * reviewed exemption, and relying on it silently would let a genuinely new
 * mapping table hide behind a regex-dodging name. This registry makes the
 * exemption explicit and self-checking: every function in `LOCALE_NAME_
 * EXEMPTION_SCOPE` whose name contains `Locale`/`Language`/`Lang` must
 * appear here with a one-line reason (see the dedicated test below), and
 * every registered entry must still exist in its named file (so the
 * registry cannot rot into a stale rubber stamp for a function that was
 * since renamed or removed).
 */
type LocaleNameExemption = { file: string; name: string; reason: string };
const LOCALE_NAME_EXEMPTION_SCOPE: readonly string[] = [
  "src/app/(admin)/catalog-sync/_lib/read-source-items.ts",
  "worker/handlers/moboreader.ts",
  "src/app/(admin)/home-carousel/page.tsx",
];
const LOCALE_NAME_EXEMPTIONS: readonly LocaleNameExemption[] = [
  {
    file: "src/app/(admin)/catalog-sync/_lib/read-source-items.ts",
    name: "parseSourceLocaleFilter",
    reason:
      "只把已解析的 sourceLocale 值分类成等值查询过滤器（精确值 / __unknown 哨兵 / 无过滤），不做码→locale映射、别名匹配或大小写折叠。",
  },
  {
    file: "worker/handlers/moboreader.ts",
    name: "pickBookSourceLocale",
    reason:
      "只在已解析的 ChannelLanguageResolution.locale 与熔断挂起集合之间二选一（挂起则 null，否则原样透传），不调用码表/别名表，不是第二份归一实现。",
  },
  {
    // L10N P5 (矩阵 #13): `?locale=` query-param selector for `/home-carousel`.
    file: "src/app/(admin)/home-carousel/page.tsx",
    name: "resolveRequestedLocale",
    reason:
      "只对一个已经是字符串的 query-param 值做 SITE_LOCALES 成员判定，不匹配则回退默认 en——跟 publish-gate/evaluator.ts 的 isRegisteredSiteLocale、[locale]/_guard.ts 同款成员检查，不调用码表/别名表，不做码→locale 映射，不是第二份归一实现。",
  },
];

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

  it("导出契约冻结的函数（L10N P4：白名单层删除后只剩 resolveSiteLocale 一个）", () => {
    expect(typeof resolveSiteLocale).toBe("function");

    // 冻结签名是 resolveSiteLocale(upstreamLanguageCode, upstreamLanguageName?)：
    // 两个声明形参。TS 的可选参数没有默认值，所以照样计入 Function.length。
    expect(resolveSiteLocale.length).toBe(2);
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

  it("🔴 登记表扩到 18 码不等于是站点语种——映射成功与「是站点语种」仍是两道独立的闸（L10N P4：第三道「可发布」闸已删除）", () => {
    expect(resolveSiteLocale(3).locale).toBe("en");
    expect(resolveSiteLocale(7).locale).toBe("ru");
    expect(SITE_LOCALES).toContain("en");
    expect(SITE_LOCALES).toContain("ru");
  });
});

describe("locale 唯一真源 · 静态层 SITE_LOCALES（L10N P4：白名单层已删除）", () => {
  it("SITE_LOCALES 是唯一的静态语种门——注册即成员，不再有第二道可发布闸缩窄它", () => {
    for (const locale of SITE_LOCALES) {
      expect((SITE_LOCALES as readonly string[]).includes(locale)).toBe(true);
    }
    expect(SITE_LOCALES.length).toBe(15);
  });

  it("「映射成功」与「是站点语种」是两道独立的闸——it/fil/ms/tr 映射成功但不是 SITE_LOCALES 成员", () => {
    expect(SITE_LOCALES).toContain("ru");
    expect(resolveSiteLocale(7).locale).toBe("ru");
    for (const locale of ["it", "fil", "ms", "tr"] as const) {
      expect(SITE_LOCALES).not.toContain(locale);
    }
  });
});

describe("locale 唯一真源 · 全仓不得有第二份映射", () => {
  it("冻结 API 只在唯一真源里定义", () => {
    const definitions: Record<string, string[]> = {
      resolveSiteLocale: [],
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
        if (!suspicious.test(match[1])) continue;
        // Defense in depth: even though today's narrow verb-prefix regex
        // does not actually match `parseSourceLocaleFilter`/
        // `pickBookSourceLocale` (see `LOCALE_NAME_EXEMPTIONS` above), a
        // future broadening of `suspicious` should not silently start
        // failing on functions this registry already reviewed and cleared.
        const exempted = LOCALE_NAME_EXEMPTIONS.some(
          (entry) => entry.file === relativePath && entry.name === match[1],
        );
        if (!exempted) offenders.push(`${relativePath} → ${match[1]}`);
      }
    }

    expect(offenders, "locale 归一只能有一处实现，未登记豁免的第二份实现在这里").toEqual([]);
  });

  it("locale-named 函数登记表：豁免范围内任何带 Locale/Language/Lang 的函数都必须登记理由，且登记项必须真实存在（Opus 复核 NON_BLOCKING a）", () => {
    const nameDeclaration = /(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(?:\([^)]*\)|[\w$]+)\s*=>|\()/g;
    const localeNamed = /Locale|Language|Lang/i;

    for (const relativePath of LOCALE_NAME_EXEMPTION_SCOPE) {
      const source = readFileSync(resolve(repoRoot, relativePath), "utf8");
      const foundNames = new Set<string>();
      for (const match of source.matchAll(nameDeclaration)) {
        if (localeNamed.test(match[1])) foundNames.add(match[1]);
      }
      const exemptedNames = new Set(
        LOCALE_NAME_EXEMPTIONS.filter((entry) => entry.file === relativePath).map((entry) => entry.name),
      );

      // 每个在文件里找到的 Locale/Language/Lang 命名函数都必须登记在册——不能
      // 悄悄新增一个未经审查的同类函数（哪怕它今天躲得过上面的窄正则）。
      for (const name of foundNames) {
        expect([...exemptedNames], `${relativePath} → ${name} 未登记豁免理由`).toContain(name);
      }
      // 登记表里的每一条也必须真实存在于文件里——防止函数改名/删除后登记表
      // 悄悄腐烂成一张空对空白名单。
      for (const name of exemptedNames) {
        expect([...foundNames], `${relativePath} → ${name} 登记表已过期：文件里已不存在该函数`).toContain(name);
      }
    }

    for (const entry of LOCALE_NAME_EXEMPTIONS) {
      expect(entry.reason.trim().length, `${entry.file} → ${entry.name} 缺一句理由`).toBeGreaterThan(0);
    }
  });

  it("唯一真源自己不含区域回退或大小写折叠——那是最容易长出来的猜测", () => {
    // split("-") / slice(0,2) / toLowerCase() 是 region fallback 的典型写法。
    expect(canonicalSource).not.toMatch(/split\(\s*["']-["']\s*\)/);
    expect(canonicalSource).not.toMatch(/\.slice\(\s*0\s*,\s*2\s*\)/);
    expect(canonicalSource).not.toMatch(/toLowerCase\(\)|toUpperCase\(\)/);
    expect(canonicalSource).not.toMatch(/startsWith\(/);
  });
});

// L10N P4: the "D-7 条件二 fail-closed 守卫（S14）" describe block that used
// to live here (ARTICLE_TEMPLATE_CRUD_LANDED / assertPublishableLocalesFailClosed)
// is deleted along with the whitelist layer it guarded — there is no longer a
// PUBLISHABLE_LOCALES configuration for it to bound. See this file's header
// comment for the two-layer replacement (SITE_LOCALES static / getActiveLocales
// dynamic) and where each layer's own tests now live.
