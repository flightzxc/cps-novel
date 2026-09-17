import { describe, expect, it } from "vitest";

import { generateArticleFromNovel } from "@/server/content-creation/generate";
import { materializeNovelFromSourceItem } from "@/server/content-creation/service";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

function seedReadyNovel(fake: FakeContentCreationDb, title = "Ready Novel") {
  const novel = fake.seedNovel({ title, locale: "en", slug: title.toLowerCase().replace(/\s+/g, "-") });
  const promo = fake.seedPromoLink({ novelId: novel.id });
  fake.seedArticleTemplate({
    templateKey: "system-default-v1",
    locale: "en",
    status: "active",
    bodyTemplate: "<h1>{novel_title}</h1><p>{novel_description}</p>{if promo_redirect_url}<a href=\"{promo_redirect_url}\">Start Reading</a>{endif}",
    seoTemplate: { title: "{novel_title}", metaDescription: "{novel_description}" },
  });
  return { novel, promo };
}

describe("generateArticleFromNovel", () => {
  it("keeps the Article slug health check for a short title", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "Hi");

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "gen-short-title",
    });

    expect(result).toEqual({ outcome: "slug_unhealthy", field: "article", baseSlug: "hi" });
    expect(fake.articles.size).toBe(0);
  });

  it("creates a draft Article bound to the ready promo and selected template", async () => {
    const fake = new FakeContentCreationDb();
    const { novel, promo } = seedReadyNovel(fake, "Bound Story");

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "gen-1",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.promoLinkId).toBe(promo.id);
    expect(result.templateKey).toBe("system-default-v1");
    expect(fake.lastArticleCreateArgs).toMatchObject({
      novelId: novel.id,
      promoLinkId: promo.id,
      contentMode: "template",
      articleType: "novel_article",
    });
    expect(fake.lastArticleCreateArgs).not.toHaveProperty("status");
    expect(String(fake.lastArticleCreateArgs?.body)).toContain("/go/goabc123");
  });

  it("blocks when no ready promo exists (T09)", async () => {
    const fake = new FakeContentCreationDb();
    const novel = fake.seedNovel({ title: "No Promo Yet", locale: "en", slug: "no-promo-yet" });
    fake.seedArticleTemplate({ templateKey: "system-default-v1", locale: "en", status: "active" });

    const missing = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-missing",
    });
    expect(missing.outcome).toBe("promo_link_missing");

    fake.seedPromoLink({ novelId: novel.id, status: "pending", webUrl: null, fetchedAt: null });
    const notReady = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-not-ready",
    });
    expect(notReady.outcome).toBe("promo_link_not_ready");

    const blank = fake.seedNovel({ title: "Blank Promo Url", locale: "en", slug: "blank-promo-url" });
    fake.seedPromoLink({ novelId: blank.id, status: "fetched", webUrl: "   ", appUrl: null });
    fake.seedArticleTemplate({ templateKey: "system-default-v1", locale: "en", status: "active" });
    const blankUrl = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: blank.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-blank-url",
    });
    expect(blankUrl.outcome).toBe("promo_link_not_ready");

    const deletedNovel = fake.seedNovel({ title: "Deleted Promo", locale: "en", slug: "deleted-promo" });
    fake.seedPromoLink({
      novelId: deletedNovel.id,
      status: "fetched",
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const deleted = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: deletedNovel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-deleted-promo",
    });
    expect(deleted.outcome).toBe("promo_link_deleted");
    expect(fake.articles.size).toBe(0);
  });

  it("re-reads promo at execute time, not from an earlier snapshot (T10)", async () => {
    const fake = new FakeContentCreationDb();
    const novel = fake.seedNovel({ title: "Promo Later", locale: "en", slug: "promo-later" });
    const promo = fake.seedPromoLink({ novelId: novel.id, status: "pending", webUrl: null, fetchedAt: null });
    fake.seedArticleTemplate({
      templateKey: "system-default-v1",
      locale: "en",
      status: "active",
      bodyTemplate: "<h1>{novel_title}</h1><p>{novel_description}</p>",
      seoTemplate: { title: "{novel_title}", metaDescription: "{novel_description}" },
    });

    const blocked = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-before-ready",
    });
    expect(blocked.outcome).toBe("promo_link_not_ready");

    promo.status = "fetched";
    promo.webUrl = "https://example.com/read";
    promo.fetchedAt = new Date("2026-09-02T00:00:00.000Z");

    const created = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-after-ready",
    });
    expect(created.outcome).toBe("created");
    expect(fake.lastArticleCreateArgs).toMatchObject({ promoLinkId: promo.id });
  });

  it("after unique conflict, re-reads the winner outside the aborted transaction (T16)", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "Winner Visible");
    fake.articleNovelLocaleFailuresRemaining = 1;
    fake.seedWinnerOnNovelLocaleConflict = true;

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "gen-winner-outside-tx",
    });
    expect(result.outcome).toBe("already_exists");
    if (result.outcome !== "already_exists") throw new Error("unreachable");
    expect(result.articleId).toBe(fake.seededConflictWinnerId);
    expect(result.templateKey).toBeNull();
    expect(fake.calls.filter((call) => call === "novel.lockForUpdate").length).toBeGreaterThan(0);
  });

  it("treats article_novel_locale_key P2002 without a visible winner as concurrent_generation_conflict (T16)", async () => {
    const fake = new FakeContentCreationDb();
    seedReadyNovel(fake, "Race Novel");
    fake.articleNovelLocaleFailuresRemaining = 1;

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: [...fake.novels.values()][0]!.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "gen-race",
    });
    expect(result.outcome).toBe("concurrent_generation_conflict");
    expect(fake.articles.size).toBe(0);
  });

  it("returns already_exists without overwriting a live article (T17)", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "Existing Article Novel");
    fake.seedArticle({
      novelId: novel.id,
      locale: "en",
      title: "Hand edited",
      body: "manual body",
      slug: "hand-edited",
    });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-exists",
    });
    expect(result.outcome).toBe("already_exists");
    expect(fake.lastArticleCreateArgs).toBeNull();
    expect([...fake.articles.values()][0]?.body).toBe("manual body");
  });

  it("returns article_soft_deleted and does not undelete (T18)", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "Soft Deleted Slot");
    const existing = fake.seedArticle({
      novelId: novel.id,
      locale: "en",
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-soft",
    });
    expect(result).toEqual({ outcome: "article_soft_deleted", articleId: existing.id });
    expect(fake.articles.size).toBe(1);
  });

  it("does not silently fallback from an explicit bad template (T14)", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "Bad Template Novel");

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id,
      templateKey: "does-not-exist",
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "gen-bad-template",
    });
    expect(result).toEqual({ outcome: "template_locale_mismatch", locale: "en", templateKey: "does-not-exist" });
    expect(fake.articles.size).toBe(0);
  });

  it("reads current Novel facts, not the source-item snapshot (T13)", async () => {
    const fake = new FakeContentCreationDb();
    const source = fake.seedSourceItem({ title: "Old Source Title", description: "old desc" });
    const created = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: source.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "mat-1",
    });
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") throw new Error("unreachable");
    const novel = fake.novels.get(created.novelId)!;
    novel.title = "Current Novel Title";
    novel.description = "current desc";
    fake.seedPromoLink({ novelId: novel.id });
    fake.seedArticleTemplate({
      templateKey: "system-default-v1",
      locale: "en",
      status: "active",
      bodyTemplate: "<h1>{novel_title}</h1><p>{novel_description}</p>",
      seoTemplate: { title: "{novel_title}", metaDescription: "{novel_description}" },
    });

    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-facts",
    });
    expect(result.outcome).toBe("created");
    expect(fake.lastArticleCreateArgs?.title).toBe("Current Novel Title");
    expect(String(fake.lastArticleCreateArgs?.body)).toContain("current desc");
    expect(String(fake.lastArticleCreateArgs?.body)).not.toContain("old desc");
  });
});
