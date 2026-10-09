/**
 * PN-15 站内搜索：查询归一（移植 CPS v8.7.2 `tests/site-search-normalize.test.ts` 中仍适用的部分）。
 *
 * 不适用而删掉的：`buildCaseVariants` / `toComparable` 相关（SQLite 兼容层，PostgreSQL 在数据库里折叠大小写）。
 * 改动的：最长从 64 改为 500（= 书名字段宽度）；输出字段 `probe`/`comparable`/`variants` 合并为 `query`。
 * 不可见字符一律用 `\u` 转义写，免得编辑器/格式化工具悄悄改掉。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { allowsCjkSingleCharacter, countCodePoints, normalizeSearchInput } from "@/lib/site-search/query-normalizer";
import {
  SITE_SEARCH_CACHE_MAX_ENTRIES,
  SITE_SEARCH_CACHE_TTL_SECONDS,
  SITE_SEARCH_CJK_SINGLE_CHAR_LANGS,
  SITE_SEARCH_MAX_QUERY_LENGTH,
  SITE_SEARCH_MIN_QUERY_LENGTH,
  SITE_SEARCH_PAGE_SIZE,
  SITE_SEARCH_SLOW_QUERY_MS,
  buildSiteSearchCacheKey,
} from "@/lib/site-search/types";
import { BROWSE_PAGE_SIZE } from "@/lib/site/queries";

function ok(raw: unknown, locale?: string): string {
  const result = normalizeSearchInput(raw, locale);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.displayQuery).toBe(result.query);
  return result.query;
}

function rejected(raw: unknown, locale?: string): { reason: string; displayQuery: string } {
  const result = normalizeSearchInput(raw, locale);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return { reason: result.reason, displayQuery: result.displayQuery };
}

describe("常量（上限清单第六节：都是代码常量）", () => {
  it("数值钉死", () => {
    expect(SITE_SEARCH_PAGE_SIZE).toBe(20);
    expect(SITE_SEARCH_MIN_QUERY_LENGTH).toBe(2);
    expect(SITE_SEARCH_MAX_QUERY_LENGTH).toBe(500);
    expect([...SITE_SEARCH_CJK_SINGLE_CHAR_LANGS]).toEqual(["zh", "ja", "ko"]);
    expect(SITE_SEARCH_CACHE_TTL_SECONDS).toBe(60);
    expect(SITE_SEARCH_CACHE_MAX_ENTRIES).toBe(200);
    expect(SITE_SEARCH_SLOW_QUERY_MS).toBe(1000);
  });

  it("每页本数 = 全部作品页的页大小（同一个翻页组件、同一个页大小）", () => {
    expect(SITE_SEARCH_PAGE_SIZE).toBe(BROWSE_PAGE_SIZE);
  });

  it("最长 ≥ Article.title 的 VarChar 宽度：读取数据库结构定义（哪天加宽书名字段而没改上限，这条变红）", () => {
    const schema = readFileSync(path.resolve(import.meta.dirname, "../../../prisma/schema.prisma"), "utf8");
    const model = /^model Article \{[\s\S]*?^\}/m.exec(schema)?.[0];
    expect(model, "schema.prisma 里找不到 model Article").toBeTruthy();
    const width = /^\s+title\s+String\s+@db\.VarChar\((\d+)\)/m.exec(model!)?.[1];
    expect(width, "Article.title 不是 VarChar(n)").toBeTruthy();
    expect(SITE_SEARCH_MAX_QUERY_LENGTH).toBeGreaterThanOrEqual(Number(width));
  });

  it("缓存键含语种、页码、归一词，`\\u0000` 分隔，不同页不共用", () => {
    expect(buildSiteSearchCacheKey("en", 1, "x y")).toBe("en\u00001\u0000x y");
    expect(buildSiteSearchCacheKey("en", 1, "x y")).not.toBe(buildSiteSearchCacheKey("en", 2, "x y"));
    expect(buildSiteSearchCacheKey("en", 1, "x y")).not.toBe(buildSiteSearchCacheKey("en x", 1, "y"));
    expect(buildSiteSearchCacheKey("en", 1, "a")).not.toBe(buildSiteSearchCacheKey("ja", 1, "a"));
  });
});

describe("空白折叠 / trim", () => {
  it("去首尾空白、折叠内部连续空白", () => {
    expect(normalizeSearchInput("  hello   world  ")).toEqual({ ok: true, query: "hello world", displayQuery: "hello world" });
  });

  it("NBSP（U+00A0）与全角空格（U+3000）当空白折叠", () => {
    expect(ok("hello  world　again")).toBe("hello world again");
  });

  it("LF / CR / TAB 折叠成单个空格（跨行的词保留词边界）", () => {
    expect(ok("hello\n\nworld")).toBe("hello world");
    expect(ok("hello\t\r\nworld\tagain")).toBe("hello world again");
  });

  it("非空白的控制字符（NUL、SOH）直接删除，不产生词边界", () => {
    expect(ok("hello\u0000\u0001world")).toBe("helloworld");
  });

  it("行分隔符 U+2028 折成一个空格", () => {
    expect(ok("hello world")).toBe("hello world");
  });
});

describe("零宽 / 格式类码点剔除，且折叠必须发生在剔除之后", () => {
  it("空格-ZWSP-空格 剔除后不留双空格", () => {
    const query = ok("a ​ b");
    expect(query).toBe("a b");
    expect(/ {2,}/.test(query)).toBe(false);
  });

  it("没有相邻空白的 ZWSP 直接删除", () => {
    expect(ok("a​b")).toBe("ab");
  });

  it("BOM（U+FEFF）、LRM（U+200E）、RLM（U+200F）、方向嵌入（U+202B）被删除", () => {
    expect(ok("﻿hello‎world‏")).toBe("helloworld");
    expect(ok("‫ab‬")).toBe("ab");
  });
});

describe("NFKC", () => {
  it("全角拉丁 → 半角（保留大小写）", () => {
    expect(ok("Ａｂｃ")).toBe("Abc");
  });

  it("带圈数字、连字", () => {
    expect(ok("①season")).toBe("1season");
    expect(ok("ﬁre")).toBe("fire");
  });

  it("全角 '％' 归一成 '%'（转义必须发生在归一之后，所以归一器不能剥离它）", () => {
    expect(ok("100％ Sweet")).toBe("100% Sweet");
  });

  it("泰语 U+0E33 归一成 U+0E4D U+0E32（与数据库一侧的 NFKC 同形）", () => {
    expect(ok("ทำ")).toBe("ทํา");
  });
});

describe("码点门槛（按码点数，不是 UTF-16 length）", () => {
  it("countCodePoints 把代理对 emoji 算 1 个", () => {
    expect(countCodePoints("\u{1f600}\u{1f600}")).toBe(2);
    expect("\u{1f600}\u{1f600}".length).toBe(4);
  });

  it("2 个 emoji 过最短门槛", () => {
    expect(ok("\u{1f600}\u{1f600}")).toBe("\u{1f600}\u{1f600}");
  });

  it("不传语种时单个汉字仍是 too_short", () => {
    expect(rejected("汉")).toEqual({ reason: "too_short", displayQuery: "汉" });
  });

  it("恰好 500 个码点通过，501 个 too_long（64 不再是上限）", () => {
    expect([...ok("a".repeat(500))]).toHaveLength(500);
    expect(rejected("a".repeat(501)).reason).toBe("too_long");
    // CPS 的 64 会拒掉海阅 420 本书的完整书名（英语最长 100 字）：100 字、65 字都必须放行。
    expect(normalizeSearchInput("a".repeat(65)).ok).toBe(true);
    expect(normalizeSearchInput("a".repeat(100)).ok).toBe(true);
  });

  it("码点计数：500 个代理对字符通过，501 个 too_long", () => {
    expect(normalizeSearchInput("\u{20bb7}".repeat(500), "ja").ok).toBe(true);
    expect(rejected("\u{20bb7}".repeat(501), "ja").reason).toBe("too_long");
  });

  it("少于最短长度 too_short", () => {
    expect(rejected("a".repeat(SITE_SEARCH_MIN_QUERY_LENGTH - 1)).reason).toBe("too_short");
  });
});

describe("idle", () => {
  it("空串 / 纯空白 / null / undefined / 数字 / 空数组", () => {
    expect(normalizeSearchInput("")).toEqual({ ok: false, reason: "idle", displayQuery: "" });
    expect(normalizeSearchInput("   \n\t  ")).toEqual({ ok: false, reason: "idle", displayQuery: "" });
    expect(normalizeSearchInput(null)).toEqual({ ok: false, reason: "idle", displayQuery: "" });
    expect(normalizeSearchInput(undefined)).toEqual({ ok: false, reason: "idle", displayQuery: "" });
    expect(normalizeSearchInput(42)).toEqual({ ok: false, reason: "idle", displayQuery: "" });
    expect(normalizeSearchInput([])).toEqual({ ok: false, reason: "idle", displayQuery: "" });
  });

  it("重复的 q 参数（数组）取第一个", () => {
    expect(ok(["hello", "world"])).toBe("hello");
  });
});

describe("displayQuery 永远是归一后的串", () => {
  it("成功与拒绝都是", () => {
    expect(ok("  hello   world  ")).toBe("hello world");
    expect(rejected("  汉  ")).toEqual({ reason: "too_short", displayQuery: "汉" });
  });
});

describe("LIKE 元字符：搜索词里原样保留（转义在数据库里做）", () => {
  it("'%' 不被剥离", () => {
    expect(ok("100% Sweet")).toBe("100% Sweet");
  });

  it("'_' 与反斜杠不被剥离", () => {
    expect(ok("a_b")).toBe("a_b");
    expect(ok("back\\slash")).toBe("back\\slash");
  });

  it("纯通配符查询（'%%'、'__'、'%_'）按 too_short 拒绝", () => {
    expect(rejected("%%")).toEqual({ reason: "too_short", displayQuery: "%%" });
    expect(rejected("__")).toEqual({ reason: "too_short", displayQuery: "__" });
    expect(rejected("%_").reason).toBe("too_short");
  });

  it("逗号保持字面（证明没有走会折叠标点的名称归一）", () => {
    expect(ok("Love, Actually")).toBe("Love, Actually");
  });
});

describe("CJK 单字放行（zh / ja / ko；Han / Hiragana / Katakana / Hangul）", () => {
  it("allowsCjkSingleCharacter 按 BCP-47 语言子标签、不分大小写", () => {
    for (const locale of ["ja", "ko", "zh", "zh-Hant", "ZH-TW"]) expect(allowsCjkSingleCharacter(locale)).toBe(true);
    for (const locale of ["en", "ru", "th", "ar", "", undefined]) expect(allowsCjkSingleCharacter(locale)).toBe(false);
  });

  it("放行：日语汉字 / 平假名 / 片假名 / 半角片假名 / 增补平面汉字", () => {
    expect(ok("愛", "ja")).toBe("愛");
    expect(ok("あ", "ja")).toBe("あ");
    expect(ok("ア", "ja")).toBe("ア");
    expect(ok("ｱ", "ja")).toBe("ア"); // 半角 ｱ → ア
    expect(ok("\u{20bb7}", "ja")).toBe("\u{20bb7}");
  });

  it("放行：韩语谚文、繁体中文汉字、zh-TW 别名", () => {
    expect(ok("사", "ko")).toBe("사");
    expect(ok("愛", "zh-Hant")).toBe("愛");
    expect(ok("汉", "zh-TW")).toBe("汉");
  });

  it("放行：剔除不可见码点后只剩一个汉字", () => {
    expect(ok("愛​", "ja")).toBe("愛");
  });

  it("拒绝：非 CJK 语种的单个汉字、不传语种、单个拉丁 / 西里尔字母", () => {
    expect(rejected("愛", "en").reason).toBe("too_short");
    expect(rejected("愛").reason).toBe("too_short");
    expect(rejected("a", "ja").reason).toBe("too_short");
    expect(rejected("я", "ru").reason).toBe("too_short");
  });

  it("拒绝：标点 '。'、emoji、长音符 ー（Script=Common）、全角拉丁 Ａ、单个 '%' / '_'", () => {
    for (const lone of ["。", "\u{1f600}", "ー", "Ａ", "%", "_"]) {
      expect(rejected(lone, "ja").reason).toBe("too_short");
    }
  });

  it("孤零零的零宽字符是 idle，不是 too_short", () => {
    expect(rejected("​", "ja").reason).toBe("idle");
    expect(rejected("\u0001", "ja").reason).toBe("idle");
  });

  it("两个汉字走常规路径", () => {
    expect(ok("愛憎", "ja")).toBe("愛憎");
  });
});
