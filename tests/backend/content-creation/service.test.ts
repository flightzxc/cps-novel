import { describe, expect, it } from "vitest";

import { ContentCreationInputError, createContentFromSourceItem } from "@/server/content-creation/service";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

describe("createContentFromSourceItem — apply, success path", () => {
  it("creates a draft Novel + same-locale draft Article and writes one audit row", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({
      title: "The Great Adventure Begins",
      description: "A sweeping tale of courage.",
      coverUrl: "https://example.com/cover.jpg",
      totalChapterCount: 42,
      paidFromChapter: 6,
    });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      locale: "en",
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-1",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    const novel = fake.novels.get(result.novelId);
    expect(novel).toBeDefined();
    expect(novel?.title).toBe("The Great Adventure Begins");
    expect(novel?.description).toBe("A sweeping tale of courage.");
    expect(novel?.coverUrl).toBe("https://example.com/cover.jpg");
    expect(novel?.locale).toBe("en");
    expect(novel?.slug).toBe("the-great-adventure-begins");
    expect(novel?.totalChapterCount).toBe(42);
    expect(novel?.paidFromChapter).toBe(6);
    expect(novel?.businessId).toBeTruthy();

    const article = fake.articles.get(result.articleId);
    expect(article).toBeDefined();
    expect(article?.novelId).toBe(result.novelId);
    expect(article?.locale).toBe("en");
    expect(article?.slug).toBe("the-great-adventure-begins");
    expect(article?.title).toBe("The Great Adventure Begins");
    expect(article?.body).toBe("");
    expect(article?.publicPageShortId).toHaveLength(8);
    expect(article?.publicPageShortId).toBe(result.publicPageShortId);

    // NovelSourceItem is linked and transitioned.
    const linkedSourceItem = fake.sourceItems.get(sourceItem.id);
    expect(linkedSourceItem?.novelId).toBe(result.novelId);
    expect(linkedSourceItem?.status).toBe("linked");

    // Exactly one audit row, same-transaction, entity = the created Novel.
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      actorType: "admin",
      actorId: "admin-1",
      action: "novel.create",
      entityType: "Novel",
      entityId: result.novelId,
      requestId: "req-1",
    });
  });

  it("never sets promoLinkId/templateId/status keys on the created rows (red-line boundaries)", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Some Title Here" });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-2",
    });
    expect(result.outcome).toBe("created");

    // Asserts on the *keys actually sent* to `.create()`, not merely on the
    // row this fake happens to construct — PromoLink claiming is S5's
    // territory (this service must never set it), and `status` is a
    // schema-default, never a literal key here (see
    // tests/backend/publish-gate/no-bypass.test.ts, which would fail the
    // whole suite if a literal `status:` key ever appeared outside
    // src/server/publish-gate/).
    expect(fake.lastArticleCreateArgs).not.toHaveProperty("promoLinkId");
    expect(fake.lastArticleCreateArgs).not.toHaveProperty("templateId");
    expect(fake.lastArticleCreateArgs).not.toHaveProperty("status");
    expect(fake.lastNovelCreateArgs).not.toHaveProperty("status");
  });
});

describe("createContentFromSourceItem — dry run (default mode)", () => {
  it("performs zero writes and returns the plan", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Preview Only Story" });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      actor: ADMIN_ACTOR,
      requestId: "req-3",
      // mode omitted — defaults to "dry_run".
    });

    expect(result.outcome).toBe("dry_run");
    if (result.outcome !== "dry_run") throw new Error("unreachable");
    expect(result.plan.novelSlug).toBe("preview-only-story");
    expect(result.plan.articleSlug).toBe("preview-only-story");
    expect(result.plan.locale).toBe("en");
    expect(result.plan.provisionalPublicPageShortId).toHaveLength(8);

    expect(fake.novels.size).toBe(0);
    expect(fake.articles.size).toBe(0);
    expect(fake.audits).toHaveLength(0);
    const untouchedSourceItem = fake.sourceItems.get(sourceItem.id);
    expect(untouchedSourceItem?.novelId).toBeNull();
    expect(untouchedSourceItem?.status).toBe("pending");
  });

  it("dry run with explicit mode: 'dry_run' behaves identically", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Explicit Dry Run" });
    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "dry_run",
      actor: ADMIN_ACTOR,
      requestId: "req-4",
    });
    expect(result.outcome).toBe("dry_run");
    expect(fake.novels.size).toBe(0);
  });

  it("reports source_item_not_found without writing", async () => {
    const fake = new FakeContentCreationDb();
    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: "00000000-0000-4000-8000-000000000000",
      actor: ADMIN_ACTOR,
      requestId: "req-5",
    });
    expect(result).toEqual({ outcome: "source_item_not_found" });
  });
});

describe("createContentFromSourceItem — idempotent repeat calls", () => {
  it("a second apply call for the same source item returns already_exists and creates no second entity set", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Repeatable Story" });

    const first = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-a",
    });
    expect(first.outcome).toBe("created");

    const second = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-b", // deliberately a *different* requestId — idempotency here is business-state-keyed, not requestId-keyed.
    });

    expect(second.outcome).toBe("already_exists");
    if (first.outcome !== "created" || second.outcome !== "already_exists") throw new Error("unreachable");
    expect(second.novelId).toBe(first.novelId);
    expect(second.articleId).toBe(first.articleId);

    // Still exactly one Novel, one Article, one audit row.
    expect(fake.novels.size).toBe(1);
    expect(fake.articles.size).toBe(1);
    expect(fake.audits).toHaveLength(1);
  });

  it("a dry run after a real creation reports already_exists too", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Dry Run After Real" });
    const created = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-c",
    });
    expect(created.outcome).toBe("created");

    const previewed = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "dry_run",
      actor: ADMIN_ACTOR,
      requestId: "req-d",
    });
    expect(previewed.outcome).toBe("already_exists");
  });

  it("already_exists: same locale as the linked Novel replays idempotently", async () => {
    const fake = new FakeContentCreationDb();
    const novel = fake.seedNovel({ locale: "en" });
    fake.seedArticle({ novelId: novel.id, locale: "en" });
    const sourceItem = fake.seedSourceItem({ novelId: novel.id, status: "linked" });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      locale: "en",
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e",
    });
    expect(result.outcome).toBe("already_exists");
  });

  it("locale_conflict when the source item is already linked to a Novel in a different locale", async () => {
    const fake = new FakeContentCreationDb();
    // `SiteLocale` is frozen to `"en"` only today, so a genuinely different
    // locale can only be represented through the fake's plain-string field
    // (real production data cannot reach this state until a second
    // `SiteLocale` is registered — this test exercises the defensive branch
    // ahead of that, exactly as the mismatch check itself is written
    // defensively ahead of it).
    const novel = fake.seedNovel({ locale: "fr" });
    fake.seedArticle({ novelId: novel.id, locale: "fr" });
    const sourceItem = fake.seedSourceItem({ novelId: novel.id, status: "linked" });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      locale: "en",
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e2",
    });
    expect(result).toEqual({
      outcome: "locale_conflict",
      reason: "source_item_already_linked_to_different_locale",
      existingNovelId: novel.id,
      existingLocale: "fr",
    });
  });
});

describe("createContentFromSourceItem — source item state guards", () => {
  it("refuses an ignored source item", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ status: "ignored" });
    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-f",
    });
    expect(result).toEqual({ outcome: "source_item_ignored" });
    expect(fake.novels.size).toBe(0);
  });

  it("refuses a stale source item", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ status: "stale" });
    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-g",
    });
    expect(result).toEqual({ outcome: "source_item_stale" });
    expect(fake.novels.size).toBe(0);
  });

  it("refuses a soft-deleted source item", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ deletedAt: new Date() });
    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-h",
    });
    expect(result).toEqual({ outcome: "source_item_deleted" });
  });
});

describe("createContentFromSourceItem — slug health and conflict", () => {
  it("returns slug_unhealthy without writing when the title normalizes below the minimum length", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Hi" });
    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-i",
    });
    expect(result).toEqual({ outcome: "slug_unhealthy", field: "novel", baseSlug: "hi" });
    expect(fake.novels.size).toBe(0);
    expect(fake.articles.size).toBe(0);
  });

  it("appends a numeric suffix when the base slug is already taken by an active Novel", async () => {
    const fake = new FakeContentCreationDb();
    fake.seedNovel({ locale: "en", slug: "same-title-story" });
    const sourceItem = fake.seedSourceItem({ title: "Same Title Story" });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-j",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.novelSlug).toBe("same-title-story-2");
  });

  it("Novel and Article slugs resolve independently — a taken Novel slug does not force a suffix on the Article slug", async () => {
    const fake = new FakeContentCreationDb();
    fake.seedNovel({ locale: "en", slug: "independent-story" });
    const sourceItem = fake.seedSourceItem({ title: "Independent Story" });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-k",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.novelSlug).toBe("independent-story-2");
    expect(result.articleSlug).toBe("independent-story");
  });
});

describe("createContentFromSourceItem — generator retry wiring", () => {
  it("retries past a businessId collision and still creates exactly one Novel", async () => {
    const fake = new FakeContentCreationDb();
    fake.novelBusinessIdFailuresRemaining = 2;
    const sourceItem = fake.seedSourceItem({ title: "Business Id Retry Story" });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-l",
    });

    expect(result.outcome).toBe("created");
    expect(fake.novels.size).toBe(1);
    expect(fake.novelBusinessIdFailuresRemaining).toBe(0);
  });

  it("retries past a publicPageShortId collision and still creates exactly one Article", async () => {
    const fake = new FakeContentCreationDb();
    fake.articleShortIdFailuresRemaining = 3;
    const sourceItem = fake.seedSourceItem({ title: "Short Id Retry Story" });

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-m",
    });

    expect(result.outcome).toBe("created");
    expect(fake.articles.size).toBe(1);
    expect(fake.articleShortIdFailuresRemaining).toBe(0);
  });
});

describe("createContentFromSourceItem — concurrent creation race", () => {
  it("the losing transaction rolls back its own Novel/Article and reports concurrent_creation_conflict", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Racing Story Title" });

    // Simulates a concurrent, already-committed transaction winning the
    // link race: right after this transaction's own guard read, another
    // Novel gets linked to the same source item.
    fake.onSourceItemRead = () => {
      const winnerNovel = fake.seedNovel({ locale: "en", slug: "racing-story-title-winner" });
      fake.seedArticle({ novelId: winnerNovel.id, locale: "en", slug: "racing-story-title-winner" });
      const item = fake.sourceItems.get(sourceItem.id)!;
      item.novelId = winnerNovel.id;
      item.status = "linked";
    };

    const result = await createContentFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-n",
    });

    expect(result).toEqual({ outcome: "concurrent_creation_conflict" });
    // The loser's own Novel/Article were rolled back — only the winner's remain.
    expect(fake.novels.size).toBe(1);
    expect(fake.articles.size).toBe(1);
    // No audit row from the losing attempt.
    expect(fake.audits).toHaveLength(0);
  });
});

describe("createContentFromSourceItem — input validation", () => {
  it("throws ContentCreationInputError for a malformed novelSourceItemId", async () => {
    const fake = new FakeContentCreationDb();
    await expect(
      createContentFromSourceItem(fake.asPrismaClient(), {
        novelSourceItemId: "not-a-uuid",
        actor: ADMIN_ACTOR,
        requestId: "req-o",
      }),
    ).rejects.toBeInstanceOf(ContentCreationInputError);
  });

  it("throws ContentCreationInputError for an empty requestId", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({});
    await expect(
      createContentFromSourceItem(fake.asPrismaClient(), {
        novelSourceItemId: sourceItem.id,
        actor: ADMIN_ACTOR,
        requestId: "",
      }),
    ).rejects.toBeInstanceOf(ContentCreationInputError);
  });

  it("throws ContentCreationInputError for a blank admin actor id", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({});
    await expect(
      createContentFromSourceItem(fake.asPrismaClient(), {
        novelSourceItemId: sourceItem.id,
        actor: { type: "admin", adminId: "" },
        requestId: "req-p",
      }),
    ).rejects.toBeInstanceOf(ContentCreationInputError);
  });
});
