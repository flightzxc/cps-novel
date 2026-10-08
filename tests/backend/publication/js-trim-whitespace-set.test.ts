/**
 * B-38：`JS_TRIM_WHITESPACE_CHARACTERS`（数据库侧 `promoReadySql` 的 `btrim` 字符集）与当前 Node 的
 * `String.prototype.trim` 完全一致。
 *
 * 遍历 U+0000–U+10FFFF（跳过代理区 U+D800–U+DFFF，它们不是合法的单独字符），断言：
 *   `String.fromCodePoint(c).trim() === ""` 当且仅当 c 在常量里。
 *
 * 这条用例是"数据库判断 = 程序 `isPromoReady`"的第一半证明（常量 = 当前 Node 的 trim）；第二半（数据库
 * `btrim` 对每个字符的实际行为）在 `tests/integration/site/promo-ready-sql-equivalence-postgres.test.ts`。
 * 将来 Node / V8 升级改变了空白字符集，这里会立刻变红。
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { JS_TRIM_WHITESPACE_CHARACTERS, isPromoReady, promoReadySql } from "@/server/publication/visibility";

const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

describe("JS_TRIM_WHITESPACE_CHARACTERS === 当前 Node 的 String.prototype.trim 空白集", () => {
  const inSet = new Set([...JS_TRIM_WHITESPACE_CHARACTERS].map((char) => char.codePointAt(0)!));

  it("常量恰好是 25 个互不相同的字符，且都在基本平面", () => {
    expect([...JS_TRIM_WHITESPACE_CHARACTERS]).toHaveLength(25);
    expect(inSet.size).toBe(25);
    expect([...inSet].every((codePoint) => codePoint <= 0xffff)).toBe(true);
    expect([...inSet].sort((a, b) => a - b)).toEqual([
      0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
      0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
      0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ]);
  });

  it("U+0000–U+10FFFF（跳过代理区）逐个：trim 后为空串 ⟺ 在常量里", () => {
    const disagreements: string[] = [];
    let visited = 0;
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= SURROGATE_FIRST && codePoint <= SURROGATE_LAST) continue;
      visited += 1;
      const blankByTrim = String.fromCodePoint(codePoint).trim() === "";
      if (blankByTrim !== inSet.has(codePoint)) {
        disagreements.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} trim=${blankByTrim} set=${inSet.has(codePoint)}`);
      }
    }
    expect(visited).toBe(0x110000 - (SURROGATE_LAST - SURROGATE_FIRST + 1));
    expect(disagreements).toEqual([]);
  });

  it("U+180E（蒙古文元音分隔符）不在集合里，trim 也不当它是空白", () => {
    expect("᠎".trim()).toBe("᠎");
    expect(inSet.has(0x180e)).toBe(false);
  });

  it("isPromoReady 与常量一致：只由集合内字符组成的链接不可用，夹带集合外字符的可用", () => {
    const blank = JS_TRIM_WHITESPACE_CHARACTERS;
    expect(isPromoReady({ status: "fetched", webUrl: blank, appUrl: null })).toBe(false);
    expect(isPromoReady({ status: "fetched", webUrl: null, appUrl: `${blank}${blank}` })).toBe(false);
    expect(isPromoReady({ status: "fetched", webUrl: `${blank}x${blank}`, appUrl: null })).toBe(true);
    expect(isPromoReady({ status: "fetched", webUrl: "᠎", appUrl: null })).toBe(true);
    expect(isPromoReady({ status: "pending", webUrl: "https://x.example", appUrl: null })).toBe(false);
  });
});

describe("promoReadySql 的形状", () => {
  it("字符集作为绑定参数传入（SQL 文本里不含原始字符），web/app 各一份", () => {
    const fragment = promoReadySql("p");
    expect(fragment.values).toEqual([JS_TRIM_WHITESPACE_CHARACTERS, JS_TRIM_WHITESPACE_CHARACTERS]);
    // 语句文本里不能出现任何一个原始空白字符（除了排版用的普通空白）。
    const exotic = [...JS_TRIM_WHITESPACE_CHARACTERS].filter((char) => !" \n\t".includes(char));
    expect(exotic.filter((char) => fragment.sql.includes(char))).toEqual([]);
    expect(fragment.text.replace(/\s+/g, " ")).toBe(
      "p.status = 'fetched' AND (coalesce(btrim(p.web_url, $1), '') <> '' OR coalesce(btrim(p.app_url, $2), '') <> '')",
    );
  });

  it("别名原样拼进列名；非标识符的别名被拒绝（它会被拼进语句文本）", () => {
    expect(promoReadySql("promo").sql).toContain("promo.web_url");
    expect(promoReadySql("promo").sql).toContain("promo.app_url");
    expect(() => promoReadySql("p; DROP TABLE article")).toThrow();
    expect(() => promoReadySql("")).toThrow();
    expect(() => promoReadySql("P")).toThrow();
  });

  it("可嵌进更大的 Prisma.sql 片段，绑定参数顺序随之后移", () => {
    const sql = Prisma.sql`SELECT 1 FROM promo_link p WHERE p.id = ${"x"} AND ${promoReadySql("p")}`;
    expect(sql.values[0]).toBe("x");
    expect(sql.values).toHaveLength(3);
  });
});
