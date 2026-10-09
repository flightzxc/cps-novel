/**
 * PN-15 站内搜索 SQL：文本 / 结构断言（不连数据库）。
 *
 * 钉住三件事：
 *  1. 反斜杠转义写对了（`Prisma.sql` 是普通模板字符串，`'\'` 会被 JS 当转义吞掉——这里逐字断言最终 SQL 文本）；
 *  2. 可见性只复用 B-38 列表的唯一定义（FROM 段与 WHERE 段逐字等于 `public-list.ts` 导出的那段），
 *     本文件不重复任何一条可见性条件；
 *  3. 两边归一、分档、排序、分页、窗口总数的形状。
 * 行为（字面匹配、折叠、分档次序、⊆ 列表可见集合）由真实库用例证明。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLIC_LIST_FROM_SQL, publicListWhereSql, singleLocale } from "@/lib/site/public-list";
import {
  SEARCH_TITLE_TRIM_CHARACTERS,
  buildSiteSearchCountSql,
  buildSiteSearchPageSql,
} from "@/lib/site-search/search-query";
import { JS_TRIM_WHITESPACE_CHARACTERS } from "@/server/publication/visibility";

const ENV_OFF: NodeJS.ProcessEnv = { NODE_ENV: "test" };
const ENV_ON: NodeJS.ProcessEnv = { NODE_ENV: "test", FEATURE_ARTICLE_SEO_VISIBILITY: "true" };

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("反斜杠转义（最终 SQL 文本逐字）", () => {
  const sql = buildSiteSearchPageSql({ query: "a_b%c\\d", locale: "en", limit: 20, offset: 0, env: ENV_OFF }).sql;

  it("转义表达式：先转义反斜杠自己，再 %、_（顺序不能换）", () => {
    expect(sql).toContain(String.raw`replace(replace(replace(v, '\', '\\'), '%', '\%'), '_', '\_') AS esc`);
  });

  it("LIKE 带 ESCAPE '\\'（单个反斜杠），书名包含 / 以搜索词开头两处都有", () => {
    expect(sql).toContain(String.raw`LIKE '%' || qq.esc || '%' ESCAPE '\'`);
    expect(sql).toContain(String.raw`LIKE qq.esc || '%' ESCAPE '\' THEN 2`);
  });

  it("搜索词是绑定参数，SQL 文本里不出现搜索词本身", () => {
    const built = buildSiteSearchPageSql({ query: "zq-needle%'\";--", locale: "en", limit: 20, offset: 0, env: ENV_OFF });
    expect(built.sql).not.toContain("zq-needle");
    expect(built.values[0]).toBe("zq-needle%'\";--");
  });

  it("没有被 JS 吞掉的转义痕迹：最终文本里不存在孤立的 `'\\''`（单个反斜杠后面紧跟引号结尾的异常串）", () => {
    // ESCAPE '\' 一共 2 处（书名包含、分档的"以搜索词开头"）；replace(..., '\\') 的第三个参数 1 处。
    expect(sql.match(/ESCAPE '\\'/g)).toHaveLength(2);
    expect(sql.match(/'\\\\'/g)).toHaveLength(1); // replace(..., '\\') 的第三个参数
  });
});

describe("可见性只复用 B-38 列表的唯一定义", () => {
  it.each([
    ["开关关", ENV_OFF],
    ["开关开", ENV_ON],
  ])("FROM 段与 WHERE 段逐字等于 public-list.ts 导出的那段（SEO 可见性%s）", (_name, env) => {
    const built = buildSiteSearchPageSql({ query: "alpha", locale: "ko", limit: 20, offset: 40, env });
    const fromSql = squash(PUBLIC_LIST_FROM_SQL.sql);
    const whereSql = squash(publicListWhereSql(singleLocale("ko"), env).sql);
    const text = squash(built.sql);
    expect(text).toContain(fromSql);
    expect(text).toContain(whereSql);
    // 计数那条同样。
    const counted = squash(buildSiteSearchCountSql({ query: "alpha", locale: "ko", env }).sql);
    expect(counted).toContain(fromSql);
    expect(counted).toContain(whereSql);
  });

  it("SEO 可见性开关开：多出 seo_visibility = 'public'；关：没有", () => {
    expect(buildSiteSearchPageSql({ query: "alpha", locale: "en", limit: 20, offset: 0, env: ENV_ON }).sql).toContain("a.seo_visibility = 'public'");
    expect(buildSiteSearchPageSql({ query: "alpha", locale: "en", limit: 20, offset: 0, env: ENV_OFF }).sql).not.toContain("seo_visibility");
  });

  it("语种谓词是单语种绑定参数；推广链接判断带去空白字符集（绑定参数）", () => {
    const built = buildSiteSearchPageSql({ query: "alpha", locale: "es", limit: 20, offset: 0, env: ENV_OFF });
    expect(built.sql).toContain("a.locale = ?");
    expect(built.values).toContain("es");
    expect(built.sql).toContain("coalesce(btrim(p.web_url, ?), '') <> ''");
    expect(built.values.filter((value) => value === JS_TRIM_WHITESPACE_CHARACTERS)).toHaveLength(2);
  });

  it("本文件之外的搜索模块没有自己写任何一条可见性条件", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../../../src/lib/site-search/search-query.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["article_type", "deleted_at", "'published'", "seo_visibility", "web_url", "'fetched'", "n.status", "a.status"]) {
      expect(code, `search-query.ts 不得自己写 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("两边归一、分档、排序、分页、总数", () => {
  const built = buildSiteSearchPageSql({ query: "alpha", locale: "en", limit: 20, offset: 40, env: ENV_OFF });
  const text = squash(built.sql);

  it("搜索词与书名两边都 lower(normalize(…, NFKC))", () => {
    expect(text).toContain("SELECT lower(normalize(?::text, NFKC)) AS v");
    expect(text).toContain("lower(normalize(a.title, NFKC)) LIKE '%' || qq.esc || '%'");
  });

  it("只搜书名：不碰 novel.title / 作者 / 简介", () => {
    expect(text).not.toMatch(/n\.title|description|author/i);
    expect(text.match(/a\.title/g)!.length).toBeGreaterThan(0);
  });

  it("分档：全等 1、开头 2、其余 3；比较前 btrim 掉空白与方向控制符（字符集是绑定参数）", () => {
    expect(text).toContain("CASE WHEN lower(normalize(btrim(a.title, ?), NFKC)) = qq.v THEN 1");
    expect(text).toContain("WHEN lower(normalize(btrim(a.title, ?), NFKC)) LIKE qq.esc || '%' ESCAPE '\\' THEN 2 ELSE 3 END");
    expect(built.values.filter((value) => value === SEARCH_TITLE_TRIM_CHARACTERS)).toHaveLength(2);
    expect(text).not.toContain("\u200f");
  });

  it("去空白字符集 = JS trim 的 25 个字符 + 方向/零宽控制符（U+200B–200F、U+202A–202E、U+2066–2069）", () => {
    expect(SEARCH_TITLE_TRIM_CHARACTERS.startsWith(JS_TRIM_WHITESPACE_CHARACTERS)).toBe(true);
    const extra = [...SEARCH_TITLE_TRIM_CHARACTERS.slice(JS_TRIM_WHITESPACE_CHARACTERS.length)].map((c) => c.codePointAt(0));
    const expected: number[] = [];
    for (let cp = 0x200b; cp <= 0x200f; cp += 1) expected.push(cp);
    for (let cp = 0x202a; cp <= 0x202e; cp += 1) expected.push(cp);
    for (let cp = 0x2066; cp <= 0x2069; cp += 1) expected.push(cp);
    expect(extra).toEqual(expected);
  });

  it("排序：分档 → 发布时间新→旧 → 编号升序；不写 NULLS LAST（与列表页同一语义）", () => {
    expect(text).toMatch(/ORDER BY CASE .* END, a\.published_at DESC, a\.id ASC LIMIT/);
    expect(text).not.toContain("NULLS");
  });

  it("窗口函数总数 + LIMIT/OFFSET 绑定参数（offset 是 bigint）", () => {
    expect(text).toContain("SELECT a.id AS id, count(*) OVER ()::int AS total");
    expect(text).toContain("LIMIT ?::int OFFSET ?::bigint");
    expect(built.values.slice(-2)).toEqual([20, 40]);
  });

  it("计数那条：同条件、不带排序/分页/窗口", () => {
    const counted = squash(buildSiteSearchCountSql({ query: "alpha", locale: "en", env: ENV_OFF }).sql);
    expect(counted).toContain("SELECT count(*)::int AS total");
    expect(counted).toContain("lower(normalize(a.title, NFKC)) LIKE '%' || qq.esc || '%'");
    expect(counted).not.toMatch(/ORDER BY|LIMIT|OFFSET|OVER/);
  });
});
