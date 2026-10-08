import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { isNovelLocaleSlugUniqueViolation } from "@/server/content-creation/shared";
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
  it("creates a Novel for a title that normalizes below the Article minimum length", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Hi" });
    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-i",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.novelSlug).toBe("hi");
    expect(fake.novels.size).toBe(1);
    expect(fake.articles.size).toBe(0);
  });

  it("materializes the UAT short-title regression sample without creating an Article", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "HIS(18+)" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-short-title-regression",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.novelSlug).toBe("his-18");
    expect(fake.novels.size).toBe(1);
    expect(fake.articles.size).toBe(0);
  });

  it("keeps numeric collision suffixing for a short Novel slug", async () => {
    const fake = new FakeContentCreationDb();
    fake.seedNovel({ locale: "en", slug: "his-18" });
    const sourceItem = fake.seedSourceItem({ title: "HIS(18+)" });

    const result = await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId: "req-short-title-collision",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.novelSlug).toBe("his-18-2");
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

describe("materializeNovelFromSourceItem — novel(locale, slug) 唯一冲突收敛", () => {
  const apply = (fake: FakeContentCreationDb, novelSourceItemId: string, requestId: string) =>
    materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId,
    });

  it("并发 P2002、重读命中绑定：返回与再次 materialize 完全一致的 already_exists", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Slug Race Story" });

    // 对手事务在"本事务已选定 slug、尚未插入"的窗口里建好同 slug 的 Novel、绑定同一个 source item 并提交。
    let winner: ReturnType<FakeContentCreationDb["seedNovel"]> | null = null;
    fake.onNovelCreate = () => {
      winner = fake.seedNovel({ locale: "en", slug: "slug-race-story", title: "Slug Race Story" });
      const item = fake.sourceItems.get(sourceItem.id)!;
      item.novelId = winner.id;
      item.status = "linked";
    };

    const result = await apply(fake, sourceItem.id, "req-slug-race-a");

    expect(winner).not.toBeNull();
    expect(result).toEqual({
      outcome: "already_exists",
      novelId: winner!.id,
      novelBusinessId: winner!.businessId,
      locale: "en",
      novelSlug: "slug-race-story",
    });
    // 与非并发场景下"同一个 source item 再 materialize 一次"的返回逐字段一致。
    expect(await apply(fake, sourceItem.id, "req-slug-race-b")).toEqual(result);
    // 重读发生在 novel.create 失败之后（事务外），且没有多建书、没有审计、没有文章。
    const afterCreate = fake.calls.slice(fake.calls.indexOf("novel.create") + 1);
    expect(afterCreate).toContain("novelSourceItem.findFirst");
    expect(fake.novels.size).toBe(1);
    expect(fake.audits).toHaveLength(0);
    expect(fake.articles.size).toBe(0);
  });

  it("P2002、重读未命中绑定（别的书占了 slug）：原样抛出，不认领别人的书", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Slug Collision Story" });
    const other = { id: "" };

    // 另一本无关小说抢走了这个 slug；本 source item 始终没有被绑定。
    fake.onNovelCreate = () => {
      other.id = fake.seedNovel({ locale: "en", slug: "slug-collision-story", title: "A Different Book" }).id;
    };

    await expect(apply(fake, sourceItem.id, "req-slug-collision")).rejects.toMatchObject({
      code: "P2002",
      meta: { modelName: "Novel", target: ["locale", "slug"] },
    });

    expect(fake.sourceItems.get(sourceItem.id)).toMatchObject({ novelId: null, status: "pending" });
    expect(fake.novels.size).toBe(1);
    expect(fake.novels.get(other.id)).toBeDefined();
    expect(fake.audits).toHaveLength(0);
  });

  it("其它约束的 P2002（business_id 用尽重试）：即使 source item 此刻已被绑定也原样抛出，不做重读", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Business Id Exhausted Story" });
    // business_id 冲突连续 5 次 = createNovelWithBusinessIdRetry 用尽，最后一次 P2002 抛出。
    fake.novelBusinessIdFailuresRemaining = 5;
    // 若实现误把任何 P2002 都当成 slug 冲突去重读，这里的绑定会让它错误地返回 already_exists。
    fake.onNovelCreate = () => {
      const winner = fake.seedNovel({ locale: "en", slug: "some-other-slug" });
      const item = fake.sourceItems.get(sourceItem.id)!;
      item.novelId = winner.id;
      item.status = "linked";
    };

    await expect(apply(fake, sourceItem.id, "req-bid-exhausted")).rejects.toMatchObject({
      code: "P2002",
      meta: { target: ["novel_business_id_key"] },
    });

    const afterLastCreate = fake.calls.slice(fake.calls.lastIndexOf("novel.create") + 1);
    expect(afterLastCreate).not.toContain("novelSourceItem.findFirst");
    expect(fake.audits).toHaveLength(0);
  });
});

describe("isNovelLocaleSlugUniqueViolation — 只认 novel(locale, slug) 这一个唯一约束", () => {
  const p2002 = (meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test", meta });

  it("认：Prisma 6.19 实测形态、列顺序颠倒、索引名（字符串/数组）", () => {
    expect(isNovelLocaleSlugUniqueViolation(p2002({ modelName: "Novel", target: ["locale", "slug"] }))).toBe(true);
    expect(isNovelLocaleSlugUniqueViolation(p2002({ modelName: "Novel", target: ["slug", "locale"] }))).toBe(true);
    expect(isNovelLocaleSlugUniqueViolation(p2002({ target: "novel_locale_slug_active_uidx" }))).toBe(true);
    expect(isNovelLocaleSlugUniqueViolation(p2002({ target: ["novel_locale_slug_active_uidx"] }))).toBe(true);
  });

  it("不认：别的约束、别的模型、只含其中一列、缺 target、非 P2002、非 Prisma 错误", () => {
    expect(isNovelLocaleSlugUniqueViolation(p2002({ modelName: "Novel", target: ["business_id"] }))).toBe(false);
    expect(isNovelLocaleSlugUniqueViolation(p2002({ target: ["novel_business_id_key"] }))).toBe(false);
    expect(isNovelLocaleSlugUniqueViolation(p2002({ modelName: "OperationAudit", target: ["request_id", "action"] }))).toBe(false);
    expect(isNovelLocaleSlugUniqueViolation(p2002({ modelName: "Article", target: ["locale", "slug"] }))).toBe(false);
    expect(isNovelLocaleSlugUniqueViolation(p2002({ modelName: "Novel", target: ["slug"] }))).toBe(false);
    expect(isNovelLocaleSlugUniqueViolation(p2002({ modelName: "Novel", target: ["locale", "slug", "business_id"] }))).toBe(false);
    expect(isNovelLocaleSlugUniqueViolation(p2002({ modelName: "Novel" }))).toBe(false);
    expect(
      isNovelLocaleSlugUniqueViolation(
        new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test", meta: { target: ["locale", "slug"] } }),
      ),
    ).toBe(false);
    expect(isNovelLocaleSlugUniqueViolation(new Error("Unique constraint failed on (locale, slug)"))).toBe(false);
    expect(isNovelLocaleSlugUniqueViolation(null)).toBe(false);
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

describe("materializeNovelFromSourceItem — B-38 分类归属重算（novel_effective_tag）", () => {
  const apply = (fake: FakeContentCreationDb, novelSourceItemId: string, requestId: string) =>
    materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId,
      mode: "apply",
      actor: ADMIN_ACTOR,
      requestId,
    });

  it("绑定书目之后、写审计之前，在同一个事务里对新书做一次重算", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Effective Tag Refresh Story" });

    const result = await apply(fake, sourceItem.id, "req-b38-refresh");
    if (result.outcome !== "created") throw new Error("expected created");

    expect(fake.effectiveTagRefreshNovelIds).toEqual([[result.novelId]]);
    const order = ["novelSourceItem.updateMany", "effectiveTag.lockShared", "effectiveTag.lockNovels", "effectiveTag.apply", "operationAudit.create"]
      .map((name) => fake.calls.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("重算失败 → 整个创建事务回滚：没有新书、书目仍未绑定、没有审计", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Effective Tag Refresh Failure" });
    fake.effectiveTagApplyError = new Error("effective tag apply failed");

    await expect(apply(fake, sourceItem.id, "req-b38-refresh-fail")).rejects.toThrow("effective tag apply failed");

    expect(fake.novels.size).toBe(0);
    expect(fake.sourceItems.get(sourceItem.id)).toMatchObject({ novelId: null, status: "pending" });
    expect(fake.audits).toHaveLength(0);
  });

  it("dry_run 与 already_exists 重放都不发起重算（没有真源改动）", async () => {
    const fake = new FakeContentCreationDb();
    const sourceItem = fake.seedSourceItem({ title: "Effective Tag No Refresh" });

    await materializeNovelFromSourceItem(fake.asPrismaClient(), {
      novelSourceItemId: sourceItem.id,
      mode: "dry_run",
      actor: ADMIN_ACTOR,
      requestId: "req-b38-dry",
    });
    expect(fake.effectiveTagRefreshNovelIds).toEqual([]);

    await apply(fake, sourceItem.id, "req-b38-first");
    expect(fake.effectiveTagRefreshNovelIds).toHaveLength(1);
    const repeat = await apply(fake, sourceItem.id, "req-b38-repeat");
    expect(repeat.outcome).toBe("already_exists");
    expect(fake.effectiveTagRefreshNovelIds).toHaveLength(1);
  });
});
