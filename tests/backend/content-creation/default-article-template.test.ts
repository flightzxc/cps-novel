/**
 * P0-S9: pure unit tests for `DEFAULT_ARTICLE_TEMPLATE`
 * (`@/server/content-creation/default-article-template`), independent of the
 * DB-backed `service.ts` wiring (covered separately in
 * `template-rendering.test.ts` / `publish-gate-e2e.test.ts`). These tests
 * pin down "the built-in template itself is well-formed and renders" so a
 * regression here points straight at the template's own copy/markup, not at
 * the surrounding transaction plumbing.
 */
import { describe, expect, it } from "vitest";

import { TEMPLATE_SEO_SCHEMA_VERSION, buildNovelTemplateValues, renderArticleDraft } from "@/lib/seo/template";
import { DEFAULT_ARTICLE_TEMPLATE, DEFAULT_ARTICLE_TEMPLATE_KEY } from "@/server/content-creation/default-article-template";

const FULL_INPUT = {
  title: "The Great Adventure Begins",
  description: "A sweeping tale of courage.",
  coverUrl: "https://example.com/cover.jpg",
  totalChapterCount: 42,
  previewChapterCount: 3,
  promoRedirectUrl: "/go/AbCd1234",
};

describe("DEFAULT_ARTICLE_TEMPLATE", () => {
  it("has a non-empty templateKey distinct from any real ArticleTemplate row (none exist)", () => {
    expect(DEFAULT_ARTICLE_TEMPLATE_KEY).toBe("system-default-v1");
  });

  it("renders successfully with every optional field populated", () => {
    const values = buildNovelTemplateValues(FULL_INPUT);
    const rendered = renderArticleDraft(DEFAULT_ARTICLE_TEMPLATE, values, {
      templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY,
      novelId: "novel-1",
    });

    expect(rendered.title).toBe("The Great Adventure Begins");
    expect(rendered.body).toBe(
      "<article>" +
        "<h1>The Great Adventure Begins</h1>" +
        '<p><img src="https://example.com/cover.jpg" alt="Cover"></p>' +
        "<p>A sweeping tale of courage.</p>" +
        "<p>Total chapters: 42</p>" +
        "<p>Free preview chapters available: 3</p>" +
        '<p><a href="/go/AbCd1234">Start Reading</a></p>' +
        "</article>",
    );
    expect(rendered.seoMetadata).toEqual({
      metaTitle: "The Great Adventure Begins",
      metaDescription: "A sweeping tale of courage.",
    });
    // P2-02B bumped this to 2 (metaKeywords/slug slots) — assert against the live
    // constant rather than a hardcoded literal so this test doesn't rot on the next bump.
    expect(rendered.seoSchemaVersion).toBe(TEMPLATE_SEO_SCHEMA_VERSION);
  });

  it("renders successfully with every optional field absent — required fields alone are enough", () => {
    const values = buildNovelTemplateValues({
      title: "Minimal Novel",
      description: "Just the required two fields.",
    });
    const rendered = renderArticleDraft(DEFAULT_ARTICLE_TEMPLATE, values, {
      templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY,
    });

    expect(rendered.body).toBe("<article><h1>Minimal Novel</h1><p>Just the required two fields.</p></article>");
    expect(rendered.body).not.toContain("img");
    expect(rendered.body).not.toContain("Total chapters");
    expect(rendered.body).not.toContain("Free preview");
    expect(rendered.body).not.toContain("Start Reading");
  });

  it("treats totalChapterCount: 0 as unknown (CPS-inherited '0 is falsy' rule) and omits the line", () => {
    const values = buildNovelTemplateValues({
      title: "Unknown Chapter Count",
      description: "Description text.",
      totalChapterCount: 0,
    });
    const rendered = renderArticleDraft(DEFAULT_ARTICLE_TEMPLATE, values, {});
    expect(rendered.body).not.toContain("Total chapters");
  });

  it("is deterministic — 50 renders of the same input produce byte-identical output", () => {
    const values = buildNovelTemplateValues(FULL_INPUT);
    const outputs = new Set(
      Array.from({ length: 50 }, () => renderArticleDraft(DEFAULT_ARTICLE_TEMPLATE, values, {}).body),
    );
    expect(outputs.size).toBe(1);
  });

  it("is shaped as an ArticleTemplateSource ready to slot into a future DB-fallback position", () => {
    // Structural pin, not a behavioral test: guards against someone widening
    // DEFAULT_ARTICLE_TEMPLATE's shape (e.g. adding a fifth key) without
    // noticing it would no longer satisfy the type a DB-sourced
    // ArticleTemplateSource must also satisfy.
    const keys = Object.keys(DEFAULT_ARTICLE_TEMPLATE).sort();
    expect(keys).toEqual(["body", "metaDescription", "metaTitle", "title"]);
  });
});
