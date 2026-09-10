/**
 * PR6 lane D — locks in `runCreateTransaction`'s `Article.templateId` write
 * (`src/server/content-creation/service.ts:495-580`, specifically the
 * `templateId: template.id` field on the `tx.article.create` call around line
 * 577). No other suite in `tests/backend/content-creation/**` asserts on
 * `templateId` directly: `template-rendering.test.ts` only reads `article.body`
 * /`article.title`, and `default-article-template.test.ts` is a pure,
 * DB-free unit suite for the template's own markup. This file is
 * test-only — the write path itself is unchanged, confirmed already correct
 * by reading the source before adding coverage (see lane report).
 *
 * Mutation target: delete the `templateId: template.id,` line from
 * `runCreateTransaction`'s `tx.article.create({ data: {...} })` call and
 * every test below turns red — `FakeContentCreationDb`'s `articleCreate`
 * mock defaults a missing `data.templateId` to `null`
 * (`tests/backend/content-creation/fake-db.ts`'s `articleCreate`), so the
 * created row's `templateId` would silently become `null` instead of the
 * selected template's id.
 */
import { describe, expect, it } from "vitest";

import { createContentFromSourceItem } from "@/server/content-creation/service";
import { DEFAULT_ARTICLE_TEMPLATE_KEY } from "@/server/content-creation/default-article-template";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

describe("Article.templateId — written from the template actually selected (lane D)", () => {
  it("no ArticleTemplate registered yet: writes the id of the auto-created system-default-v1 row", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Default Template Novel", description: "Description." });
    expect(fake.articleTemplates.size).toBe(0);

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-default-template",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    // `ensureDefaultArticleTemplate` (@/server/article-templates) creates
    // exactly one row when none exist yet — that is the id this write must
    // reference.
    expect(fake.articleTemplates.size).toBe(1);
    const defaultTemplate = [...fake.articleTemplates.values()][0]!;
    expect(defaultTemplate.templateKey).toBe(DEFAULT_ARTICLE_TEMPLATE_KEY);

    const article = fake.articles.get(result.articleId);
    expect(article?.templateId).toBe(defaultTemplate.id);
    // Direct on the write call's own data, not just the row this fake
    // happens to construct from a subset of it — same discipline
    // `template-rendering.test.ts` uses for `promoLinkId`.
    expect(fake.lastArticleCreateArgs).toMatchObject({ templateId: defaultTemplate.id });
  });

  it("input.templateKey given: writes the id of the explicitly selected template, not the default", async () => {
    const fake = new FakeContentCreationDb();
    // Seed the default first — its mere existence must not win once a
    // specific `templateKey` is requested, and `ensureDefaultArticleTemplate`
    // only auto-creates when the template table is empty, so this also
    // proves that early call is a no-op once any template already exists.
    fake.seedArticleTemplate({ templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY, locale: "en", status: "active" });
    const customTemplate = fake.seedArticleTemplate({
      templateKey: "custom-promo-template",
      locale: "en",
      status: "active",
      bodyTemplate: "<article><h1>{novel_title}</h1></article>",
    });
    const sourceItem = fake.seedSourceItem({ title: "Custom Template Novel", description: "Description." });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-custom-template",
      templateKey: "custom-promo-template",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    const article = fake.articles.get(result.articleId);
    expect(article?.templateId).toBe(customTemplate.id);
    expect(fake.lastArticleCreateArgs).toMatchObject({ templateId: customTemplate.id });
    // And not the id of the other active, same-locale template that would
    // have won on a plain (no templateKey) selection.
    const defaultTemplate = [...fake.articleTemplates.values()].find(
      (row) => row.templateKey === DEFAULT_ARTICLE_TEMPLATE_KEY,
    )!;
    expect(article?.templateId).not.toBe(defaultTemplate.id);
  });
});
