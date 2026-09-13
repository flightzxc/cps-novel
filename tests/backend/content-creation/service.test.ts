import { describe, expect, it } from "vitest";

import { ContentCreationInputError, materializeNovelFromSourceItem } from "@/server/content-creation/service";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

describe("materializeNovelFromSourceItem — apply, success path", () => {
  it("creates a draft Novel only and writes one audit row", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({
      title: "The Great Adventure Begins",
      description: "A sweeping tale of courage.",
      coverUrl: "https://example.com/cover.jpg",
      totalChapterCount: 42,
      paidFromChapter: 6,
    });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
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

    expect(fake.articles.size).toBe(0);
    expect(fake.lastArticleCreateArgs).toBeNull();

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

  it("never writes an Article and omits status on Novel.create", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Some Title Here" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-2",
    });
    expect(result.outcome).toBe("created");
    expect(fake.articles.size).toBe(0);
    expect(fake.lastArticleCreateArgs).toBeNull();
    expect(fake.lastNovelCreateArgs).not.toHaveProperty("status");
  });

  it("still materializes when no article template exists for the locale (T01)", async () => {
    const fake = new FakeContentCreationDb();
    fake.seedArticleTemplate({ templateKey: "system-default-v1", locale: "fr", status: "active" });
    const sourceItem = fake.seedSourceItem({ title: "No Matching Locale Template", sourceLocale: "ru" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-template-locale-mismatch",
    });
    expect(result.outcome).toBe("created");
    expect(fake.novels.size).toBe(1);
    expect(fake.articles.size).toBe(0);
  });
});

describe("materializeNovelFromSourceItem — locale derivation (L10N P2)", () => {
  it("ru source: sourceLocale='ru' derives Novel.locale=ru", async () => {
    const fake = new FakeContentCreationDb();
    fake.seedArticleTemplate({ templateKey: "system-default-v1", locale: "ru", status: "active" });
    const sourceItem = fake.seedSourceItem({ title: "Русский заголовок", sourceLocale: "ru" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-ru-1",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.locale).toBe("ru");
    expect(fake.novels.get(result.novelId)?.locale).toBe("ru");
    expect(fake.articles.size).toBe(0);
  });

  it("NULL sourceLocale throws ContentCreationInputError('missing_locale') — no writes", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Unresolved Source", sourceLocale: null });

    const error = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-missing-locale",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContentCreationInputError);
    expect((error as ContentCreationInputError).code).toBe("missing_locale");
    expect(fake.novels.size).toBe(0);
    expect(fake.articles.size).toBe(0);
    // Fails closed before any write — the source item itself is untouched.
    expect(fake.sourceItems.get(sourceItem.id)?.status).toBe("pending");
  });

  // L10N P5 §1.E: deriveLocale's missing-value check used to be a strict
  // `=== null`, so a blank (non-null) sourceLocale fell through to the
  // SITE_LOCALES membership check and was misclassified as
  // unsupported_locale — see service.ts's deriveLocale doc comment.
  it("blank/whitespace-only sourceLocale (not null) also throws 'missing_locale', not 'unsupported_locale'", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Blank Locale Source", sourceLocale: "  " });

    const error = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-blank-locale",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContentCreationInputError);
    expect((error as ContentCreationInputError).code).toBe("missing_locale");
    expect(fake.novels.size).toBe(0);
    expect(fake.articles.size).toBe(0);
  });

  it("a resolved locale that is not a registered SITE_LOCALES member (it) throws ContentCreationInputError('unsupported_locale') — no writes", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Italian Source, Not A Site Locale", sourceLocale: "it" });

    const error = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-unsupported-locale",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContentCreationInputError);
    expect((error as ContentCreationInputError).code).toBe("unsupported_locale");
    expect(fake.novels.size).toBe(0);
    expect(fake.articles.size).toBe(0);
  });

  it("missing_locale/unsupported_locale fail closed in dry_run mode too, before loadPlan ever reaches a template check", async () => {
    const fake = new FakeContentCreationDb();
    const nullItem = fake.seedSourceItem({ title: "Null Locale Dry Run", sourceLocale: null });
    const unsupportedItem = fake.seedSourceItem({ title: "Unsupported Locale Dry Run", sourceLocale: "fil" });

    await expect(
      materializeNovelFromSourceItem(fake.asPrismaClient(), {
        novelSourceItemId: nullItem.id,
        mode: "dry_run",
        actor: ADMIN_ACTOR,
        requestId: "req-dry-missing",
      }),
    ).rejects.toMatchObject({ code: "missing_locale" });

    await expect(
      materializeNovelFromSourceItem(fake.asPrismaClient(), {
        novelSourceItemId: unsupportedItem.id,
        mode: "dry_run",
        actor: ADMIN_ACTOR,
        requestId: "req-dry-unsupported",
      }),
    ).rejects.toMatchObject({ code: "unsupported_locale" });
  });
});

describe("materializeNovelFromSourceItem — dry run (default mode)", () => {
  it("performs zero writes and returns the plan", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Preview Only Story" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      actor: ADMIN_ACTOR,
      requestId: "req-3",
      // mode omitted — defaults to "dry_run".
    });

    expect(result.outcome).toBe("dry_run");
    if (result.outcome !== "dry_run") throw new Error("unreachable");
    expect(result.plan.novelSlug).toBe("preview-only-story");
    expect(result.plan.locale).toBe("en");
    expect(result.plan).not.toHaveProperty("articleSlug");

    expect(fake.novels.size).toBe(0);
    expect(fake.articles.size).toBe(0);
    expect(fake.audits).toHaveLength(0);
    expect(fake.lastSourceItemFindFirstArgs?.select).toEqual({
      id: true,
      novelId: true,
      status: true,
      title: true,
      description: true,
      coverUrl: true,
      totalChapterCount: true,
      paidFromChapter: true,
      splitRatio: true,
      sourceLocale: true,
      deletedAt: true,
    });
    expect(fake.lastSourceItemFindFirstArgs?.select).not.toHaveProperty("rawPayload");
    const untouchedSourceItem = fake.sourceItems.get(sourceItem.id);
    expect(untouchedSourceItem?.novelId).toBeNull();
    expect(untouchedSourceItem?.status).toBe("pending");
  });

  it("dry run with explicit mode: 'dry_run' behaves identically", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Explicit Dry Run" });
    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
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
    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: "00000000-0000-4000-8000-000000000000",
      actor: ADMIN_ACTOR,
      requestId: "req-5",
    });
    expect(result).toEqual({ outcome: "source_item_not_found" });
  });
});

describe("materializeNovelFromSourceItem — idempotent repeat calls", () => {
  it("a second apply call for the same source item returns already_exists and creates no second entity set", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Repeatable Story" });

    const first = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-a",
    });
    expect(first.outcome).toBe("created");

    const second = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-b", // deliberately a *different* requestId — idempotency here is business-state-keyed, not requestId-keyed.
    });

    expect(second.outcome).toBe("already_exists");
    if (first.outcome !== "created" || second.outcome !== "already_exists") throw new Error("unreachable");
    expect(second.novelId).toBe(first.novelId);

    expect(fake.novels.size).toBe(1);
    expect(fake.articles.size).toBe(0);
    expect(fake.audits).toHaveLength(1);
  });

  it("a dry run after a real creation reports already_exists too", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Dry Run After Real" });
    const created = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-c",
    });
    expect(created.outcome).toBe("created");

    const previewed = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "dry_run",
      actor: ADMIN_ACTOR,
      requestId: "req-d",
    });
    expect(previewed.outcome).toBe("already_exists");
  });

  it("already_exists: derived locale matches the linked Novel's locale, replays idempotently", async () => {
    const fake = new FakeContentCreationDb();
    const novel = fake.seedNovel({ locale: "en" });
    // `sourceLocale` defaults to `"en"` in `seedSourceItem` — matches the
    // linked Novel's own locale, so `loadPlan` derives "en" too.
    const sourceItem = fake.seedSourceItem({ novelId: novel.id, status: "linked" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e",
    });
    expect(result.outcome).toBe("already_exists");
  });

  it("locale_conflict when the source item's derived locale no longer matches the Novel it is already linked to", async () => {
    const fake = new FakeContentCreationDb();
    // The linked Novel is "fr"; the source item's own `sourceLocale`
    // defaults to `"en"` in `seedSourceItem` (not overridden here) — `en` !==
    // `fr` derives the conflict. This models data drift (e.g. a mapping-table
    // correction that changed what this source item resolves to since it was
    // first linked), the one legitimate way this branch is reachable now that
    // locale is never caller-supplied.
    const novel = fake.seedNovel({ locale: "fr" });
    const sourceItem = fake.seedSourceItem({ novelId: novel.id, status: "linked" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-e2",
    });
    expect(result).toEqual({
      outcome: "locale_conflict",
      reason: "source_item_already_linked_to_different_locale",
      existingNovelId: novel.id,
      existingLocale: "fr",
      derivedLocale: "en",
    });
  });
});

describe("materializeNovelFromSourceItem — source item state guards", () => {
  it("refuses an ignored source item", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ status: "ignored" });
    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
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
    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
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
    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-h",
    });
    expect(result).toEqual({ outcome: "source_item_deleted" });
  });
});

describe("materializeNovelFromSourceItem — slug health and conflict", () => {
  it("returns slug_unhealthy without writing when the title normalizes below the minimum length", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Hi" });
    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
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

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-j",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.novelSlug).toBe("same-title-story-2");
  });

  it("a taken Article slug does not block Novel materialization (T02)", async () => {
    const fake = new FakeContentCreationDb();
    const other = fake.seedNovel({ locale: "en", slug: "other-book" });
    fake.seedArticle({ novelId: other.id, locale: "en", slug: "independent-story" });
    const sourceItem = fake.seedSourceItem({ title: "Independent Story" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-k",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.novelSlug).toBe("independent-story");
    expect(fake.articles.size).toBe(1);
  });
});

describe("materializeNovelFromSourceItem — generator retry wiring", () => {
  it("retries past a businessId collision and still creates exactly one Novel", async () => {
    const fake = new FakeContentCreationDb();
    fake.novelBusinessIdFailuresRemaining = 2;
    const sourceItem = fake.seedSourceItem({ title: "Business Id Retry Story" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-l",
    });

    expect(result.outcome).toBe("created");
    expect(fake.novels.size).toBe(1);
    expect(fake.novelBusinessIdFailuresRemaining).toBe(0);
  });

});

describe("materializeNovelFromSourceItem — concurrent creation race", () => {
  it("the losing transaction rolls back its own Novel and reports concurrent_creation_conflict", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Racing Story Title" });

    // Simulates a concurrent, already-committed transaction winning the
    // link race: right after this transaction's own guard read, another
    // Novel gets linked to the same source item.
    fake.onSourceItemRead = () => {
      const winnerNovel = fake.seedNovel({ locale: "en", slug: "racing-story-title-winner" });
      const item = fake.sourceItems.get(sourceItem.id)!;
      item.novelId = winnerNovel.id;
      item.status = "linked";
    };

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-n",
    });

    expect(result).toEqual({ outcome: "concurrent_creation_conflict" });
    expect(fake.novels.size).toBe(1);
    expect(fake.articles.size).toBe(0);
    // No audit row from the losing attempt.
    expect(fake.audits).toHaveLength(0);
  });
});

describe("materializeNovelFromSourceItem — input validation", () => {
  it("throws ContentCreationInputError for a malformed novelSourceItemId", async () => {
    const fake = new FakeContentCreationDb();
    await expect(
      materializeNovelFromSourceItem(fake.asPrismaClient(), {
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
      materializeNovelFromSourceItem(fake.asPrismaClient(), {
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
      materializeNovelFromSourceItem(fake.asPrismaClient(), {
        novelSourceItemId: sourceItem.id,
        actor: { type: "admin", adminId: "" },
        requestId: "req-p",
      }),
    ).rejects.toBeInstanceOf(ContentCreationInputError);
  });
});
