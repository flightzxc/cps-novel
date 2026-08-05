import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SITE_LOCALES,
  isPublishableLocale,
  listPublishableLocales,
  resolveSiteLocale,
} from "@/lib/locale/locale-canonical";

/**
 * 语种归一唯一真源（`docs/p1/P1_SHARED_CONTRACTS.md` §2，级别 FROZEN，硬前置 2）。
 *
 * 验三件事：三个冻结 API 的存在与语义、fail-closed 的边界、以及「全仓只有一处
 * 映射」这条纪律确实成立。第三条是这个模块存在的**全部理由**——CPS 因映射散落
 * 四处付过两次全库 normalize 的代价，所以它必须是自动化断言，不能只写在 README 里。
 *
 * 🔴 上游登记表与发布白名单当前都为空，这是契约要求的 fail-closed 状态：
 * 上游 `language` 数值码的枚举证据不在本仓库内，D-7（首发白名单）仍是 OPEN。
 * 因此下面关于「返回 unknown / 恒不可发布」的断言验的是**语义正确**，
 * 不是「还没实现」。表一旦落地，这些用例会立刻变成真实数据的回归网。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const CANONICAL_PATH = "src/lib/locale/locale-canonical.ts";
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

  it("站点 locale 集合是冻结的，且不含 README 未声明的语种", () => {
    expect([...SITE_LOCALES]).toEqual(["en"]);
    expect(Object.isFrozen(SITE_LOCALES)).toBe(true);
  });
});

describe("locale 唯一真源 · resolveSiteLocale 映射不到就是 unknown", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["空串", ""],
    ["未登记的数值码", 3],
    ["未登记数值码的字符串写法", "3"],
    ["负数", -1],
    ["小数", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["布尔", true],
    ["对象", {}],
    ["数组", []],
    ["前导零写法", "03"],
    ["带空格", " 3"],
    ["十六进制写法", "0x3"],
  ])("%s → unknown", (_label, input) => {
    expect(resolveSiteLocale(input)).toBe("unknown");
  });

  it("🔴 长得像 locale 的字符串也不认——上游给的是数值码，认字符串就是在猜", () => {
    for (const value of ["en", "EN", "en-US", "en_US", "eng", "english"]) {
      expect(resolveSiteLocale(value), `${value} 不该被认成 locale`).toBe("unknown");
    }
  });

  it("🔴 不拿上游原值当 locale：返回值只可能是已登记 locale 或 unknown", () => {
    const inputs: unknown[] = ["zh", 7, "Français", { locale: "en" }, "en"];
    for (const input of inputs) {
      const resolved = resolveSiteLocale(input);
      expect(resolved === "unknown" || SITE_LOCALES.includes(resolved)).toBe(true);
      expect(resolved).not.toBe(input);
    }
  });

  it("languageName 不做模糊匹配——未登记的文案一律 unknown", () => {
    for (const name of ["English", "english", "英语", "Français", ""]) {
      expect(resolveSiteLocale(0, name)).toBe("unknown");
    }
  });

  it("两个参数都给也不会拼出一个 locale", () => {
    expect(resolveSiteLocale(1, "English")).toBe("unknown");
  });
});

describe("locale 唯一真源 · 发布白名单 fail-closed", () => {
  it("白名单当前为空：D-7 未定案，连 en 也不可发布", () => {
    expect(listPublishableLocales()).toEqual([]);
    expect(isPublishableLocale("en")).toBe(false);
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
    first.push("en");
    expect(listPublishableLocales()).toEqual([]);
    expect(listPublishableLocales()).not.toBe(first);
  });

  it("「映射成功」与「可发布」是两道独立的闸", () => {
    // 同一个 locale 可以既是站点 locale、又不可发布——这正是当前 en 的状态。
    expect(SITE_LOCALES).toContain("en");
    expect(isPublishableLocale("en")).toBe(false);
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
      if (relativePath === CANONICAL_PATH) continue;
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
      if (relativePath === CANONICAL_PATH) continue;
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
