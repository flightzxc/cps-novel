import { describe, expect, it } from "vitest";

import { DEFAULT_ARTICLE_TEMPLATE } from "@/server/content-creation/default-article-template";
import { generateArticleFromNovel } from "@/server/content-creation/generate";
import { materializeNovelFromSourceItem } from "@/server/content-creation/service";
import { evaluatePublishGate, type PublishGateFacts } from "@/server/publish-gate";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

describe("content creation → real evaluatePublishGate", () => {
  it("required_metadata_missing no longer fires after explicit article generation", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({
      title: "The Great Adventure Begins",
      description: "A sweeping tale of courage.",
      coverUrl: "https://example.com/cover.jpg",
      totalChapterCount: 42,
    });

    const materialized = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e2e-mat",
    });
    expect(materialized.outcome).toBe("created");
    if (materialized.outcome !== "created") throw new Error("unreachable");
    expect(fake.articles.size).toBe(0);

    fake.seedPromoLink({ novelId: materialized.novelId });
    fake.seedArticleTemplate({
      templateKey: "system-default-v1",
      locale: "en",
      status: "active",
      bodyTemplate: DEFAULT_ARTICLE_TEMPLATE.body,
      seoTemplate: {
        title: DEFAULT_ARTICLE_TEMPLATE.title,
        metaTitle: DEFAULT_ARTICLE_TEMPLATE.metaTitle,
        metaDescription: DEFAULT_ARTICLE_TEMPLATE.metaDescription,
      },
    });

    const generated = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: materialized.novelId,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e2e-gen",
    });
    expect(generated.outcome).toBe("created");
    if (generated.outcome !== "created") throw new Error("unreachable");

    const novel = fake.novels.get(generated.novelId);
    const article = fake.articles.get(generated.articleId);
    if (!novel || !article) throw new Error("unreachable");

    const facts: PublishGateFacts = {
      novel: { status: "draft" },
      article: { status: "draft", locale: article.locale, title: article.title, slug: article.slug, body: article.body },
      promoLink: { status: "fetched", webUrl: "https://example.com/read", appUrl: null },
      preview: { hasPreviewChapter: false, hasPreviewBody: false },
      pageIdentity: { conflicting: false },
    };

    const evaluation = evaluatePublishGate(facts);
    expect(evaluation.reasons).not.toContain("required_metadata_missing");
    expect(evaluation.requiredMetadataMissing).toBeNull();
    expect(evaluation.reasons).toEqual(["preview_chapter_missing"]);
    expect(evaluation.publishable).toBe(false);
  });

  it("(control) the same facts with body forced back to '' still fail required_metadata_missing", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Control Case", description: "Control description." });
    const materialized = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e2e-control-mat",
    });
    expect(materialized.outcome).toBe("created");
    if (materialized.outcome !== "created") throw new Error("unreachable");
    fake.seedPromoLink({ novelId: materialized.novelId });
    fake.seedArticleTemplate({
      templateKey: "system-default-v1",
      locale: "en",
      status: "active",
      bodyTemplate: DEFAULT_ARTICLE_TEMPLATE.body,
      seoTemplate: { title: "{novel_title}", metaDescription: "{novel_description}" },
    });
    const generated = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: materialized.novelId,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e2e-control-gen",
    });
    expect(generated.outcome).toBe("created");
    if (generated.outcome !== "created") throw new Error("unreachable");
    const article = fake.articles.get(generated.articleId);
    if (!article) throw new Error("unreachable");
    expect(article.body).not.toBe("");

    const blankBodyFacts: PublishGateFacts = {
      novel: { status: "draft" },
      article: { status: "draft", locale: article.locale, title: article.title, slug: article.slug, body: "" },
      promoLink: { status: "fetched", webUrl: "https://example.com/read", appUrl: null },
      preview: { hasPreviewChapter: true, hasPreviewBody: true },
      pageIdentity: { conflicting: false },
    };
    expect(evaluatePublishGate(blankBodyFacts).reasons).toContain("required_metadata_missing");
  });
});
