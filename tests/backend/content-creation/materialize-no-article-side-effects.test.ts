/**
 * Negative guard: Novel materialize must not grow a second article/template
 * write site. A live Article overwrite via this path is also forbidden.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SERVICE = path.resolve(process.cwd(), "src/server/content-creation/service.ts");
const FORBIDDEN = [
  "article.create",
  "article.createMany",
  "renderArticleDraft",
  "ensureDefaultArticleTemplate",
  "selectActiveArticleTemplate",
  "buildNovelTemplateValues",
  "articleTemplate",
  "templateKey",
];

describe("materializeNovelFromSourceItem must stay Novel-only", () => {
  it("service.ts does not query templates or write Article", async () => {
    const source = await readFile(SERVICE, "utf8");
    const hits = FORBIDDEN.filter((token) => source.includes(token));
    expect(hits).toEqual([]);
  });

  it("sanity: the detector would catch a reintroduced article.create", () => {
    const leaked = 'await tx.article.create({ data: {} });\nselectActiveArticleTemplate';
    expect(FORBIDDEN.filter((token) => leaked.includes(token))).toEqual([
      "article.create",
      "selectActiveArticleTemplate",
    ]);
  });
});
