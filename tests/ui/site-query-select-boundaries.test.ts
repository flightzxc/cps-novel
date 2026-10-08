import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * R1-1 结构守卫。
 *
 * 为什么需要源码级断言而不是行为断言：`site-mappers-read-on-upstream.test.ts`
 * 里的用例是自己造数据喂给 mapper 的，验证的是「mapper 会不会算」；而 2026-09-01
 * 断点追踪查明，全站零转化的真凶是「query 没有 select 这个字段」——那一类失败
 * mapper 测试永远看不见。
 *
 * 类型层也拦不住：`PublicArticleDetailRecord.promoLink` 是可选的（为兼容
 * Codex 独占的 backend fixture 而放宽），因此新写的详情查询漏掉
 * `publicRedirectCode` 时 tsc 不会报错，CTA 会静默消失。这道守卫是该场景
 * 唯一的自动化防线。
 *
 * 反向同样承重：卡片绝不能携带公开跳转码
 * （`tests/backend/public/mappers.test.ts:41` 的防泄漏断言）。
 */
const QUERIES_SOURCE = readFileSync(
  path.join(process.cwd(), "src/lib/site/queries.ts"),
  "utf8",
);
// B-38 第二段：卡片 select 搬进了叶子文件 `article-card.ts`（避免 queries.ts ↔ public-list.ts 循环引用），
// `queries.ts` 重新导出；详情 select 仍在 `queries.ts`。守卫两个文件都读，断言一条不放宽。
const CARD_SOURCE = readFileSync(
  path.join(process.cwd(), "src/lib/site/article-card.ts"),
  "utf8",
);

function selectBlock(name: string): string {
  const source = name === "ARTICLE_CARD_SELECT" ? CARD_SOURCE : QUERIES_SOURCE;
  const start = source.indexOf(`const ${name} = {`);
  expect(start, `${name} 未找到——select 常量被重命名或删除时必须同步本守卫`).toBeGreaterThan(-1);
  const end = source.indexOf("} as const;", start);
  expect(end, `${name} 的 as const 结尾未找到`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("public article select boundaries", () => {
  it("detail/chapter select 必须 select publicRedirectCode", () => {
    expect(selectBlock("ARTICLE_DETAIL_SELECT")).toMatch(/publicRedirectCode:\s*true/);
  });

  it("card select 绝不携带 publicRedirectCode", () => {
    expect(selectBlock("ARTICLE_CARD_SELECT")).not.toMatch(/publicRedirectCode/);
  });

  it("queries.ts 仍然导出卡片 select（既有 import 不变），且卡片查询在 public-list 里走它", () => {
    expect(QUERIES_SOURCE).toMatch(/export \{ ARTICLE_CARD_SELECT, filterPromoReady, toPublicArticle \}/);
    const listSource = readFileSync(path.join(process.cwd(), "src/lib/site/public-list.ts"), "utf8");
    expect(listSource).toMatch(/select: ARTICLE_CARD_SELECT/);
    expect(listSource).not.toMatch(/ARTICLE_DETAIL_SELECT|publicRedirectCode/);
  });

  it("详情与章节查询都走 detail select", () => {
    for (const fn of ["getPublicNovelDetail", "getPublicChapterView"]) {
      const at = QUERIES_SOURCE.indexOf(`function ${fn}`);
      expect(at, `${fn} 未找到`).toBeGreaterThan(-1);
      const body = QUERIES_SOURCE.slice(at, at + 2000);
      expect(body, `${fn} 必须使用 ARTICLE_DETAIL_SELECT`).toMatch(/ARTICLE_DETAIL_SELECT/);
    }
  });
});
