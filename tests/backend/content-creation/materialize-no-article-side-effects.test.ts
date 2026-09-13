/**
 * Negative guard: Novel materialize must not grow a second article/template
 * write site. A live Article overwrite via this path is also forbidden.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SERVICE = path.resolve(process.cwd(), "src/server/content-creation/service.ts");
const MATERIALIZE_HANDLER = path.resolve(process.cwd(), "worker/handlers/novel-materialize.ts");
const CATALOG_BATCH_HANDLER = path.resolve(process.cwd(), "worker/handlers/catalog-batch.ts");
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
const MATERIALIZE_BOUNDARY_FORBIDDEN = FORBIDDEN.filter((token) => token !== "templateKey");

describe("materializeNovelFromSourceItem must stay Novel-only", () => {
  it("service.ts does not query templates or write Article", async () => {
    const source = await readFile(SERVICE, "utf8");
    const hits = FORBIDDEN.filter((token) => source.includes(token));
    expect(hits).toEqual([]);
  });

  it("materialize worker/catalog-batch handlers do not write Article or render templates", async () => {
    const [handler, catalog] = await Promise.all([
      readFile(MATERIALIZE_HANDLER, "utf8"),
      readFile(CATALOG_BATCH_HANDLER, "utf8"),
    ]);
    expect(MATERIALIZE_BOUNDARY_FORBIDDEN.filter((token) => handler.includes(token))).toEqual([]);
    expect(MATERIALIZE_BOUNDARY_FORBIDDEN.filter((token) => catalog.includes(token))).toEqual([]);
    expect(handler).toContain("legacy_template_on_materialize");
  });

  it("sanity: the detector would catch a reintroduced article.create", () => {
    const leaked = 'await tx.article.create({ data: {} });\nselectActiveArticleTemplate';
    expect(FORBIDDEN.filter((token) => leaked.includes(token))).toEqual([
      "article.create",
      "selectActiveArticleTemplate",
    ]);
  });
});
