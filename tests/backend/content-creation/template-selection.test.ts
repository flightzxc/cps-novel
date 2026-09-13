import { describe, expect, it } from "vitest";

import { generateArticleFromNovel } from "@/server/content-creation/generate";
import { DEFAULT_ARTICLE_TEMPLATE_KEY } from "@/server/content-creation/default-article-template";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

describe("Article.templateId — written from the template actually selected", () => {
  it("no usable template: generate is blocked and writes no Article", async () => {
    const fake = new FakeContentCreationDb();
    const novel = fake.seedNovel({ title: "Default Template Novel", locale: "en", slug: "default-template-novel" });
    fake.seedPromoLink({ novelId: novel.id });
    expect(fake.articleTemplates.size).toBe(0);

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-default-template",
    });

    expect(result.outcome).toBe("template_not_available");
    expect(fake.articles.size).toBe(0);
  });

  it("input.templateKey given: writes the id of the explicitly selected template, not the default", async () => {
    const fake = new FakeContentCreationDb();
    const novel = fake.seedNovel({ title: "Custom Template Novel", locale: "en", slug: "custom-template-novel" });
    fake.seedPromoLink({ novelId: novel.id });
    fake.seedArticleTemplate({ templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY, locale: "en", status: "active" });
    const customTemplate = fake.seedArticleTemplate({
      templateKey: "custom-promo-template",
      locale: "en",
      status: "active",
      bodyTemplate: "<article><h1>{novel_title}</h1></article>",
      seoTemplate: { title: "{novel_title}", metaDescription: "{novel_description}" },
    });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
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
  });
});
