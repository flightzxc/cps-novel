import { describe, expect, it } from "vitest";

import {
  articleHasAnyIndexNowOutbox,
  enqueueIndexNowFirstPublish,
  ensureIndexNowBatchDeliveryTask,
  listPublishedWithoutIndexNowDelivery,
  releaseDeferredIndexNowOutbox,
} from "@/lib/indexnow/outbox";
import { INDEXNOW_BATCH_OPERATION_SCOPE_HASH } from "@/lib/indexnow/outbox-contract";

import { FakeIndexNowDb, installTestSiteUrl, testEnv } from "./fake-db";

installTestSiteUrl();

const ENABLED_ENV = testEnv({ FEATURE_INDEXNOW_OUTBOX: "true", INDEXNOW_OUTBOX_ALLOW_WRITE: "true" });
// L10N P4: the real default locale gate is now `isRegisteredSiteLocale`
// (SITE_LOCALES membership — the narrower D-7 publish whitelist
// `isPublishableLocale` was deleted). `LOCALE_OK` still lets tests that only
// care about the two feature flags look past the locale gate unconditionally
// (useful for an unregistered-locale fixture, not needed for any real
// SITE_LOCALES member anymore).
const LOCALE_OK = { isLocalePublishable: () => true };

function seedEligibleArticle(fake: FakeIndexNowDb, id: string, updatedAt: Date, locale = "en") {
  fake.seedArticle({
    id,
    novelId: "novel-1",
    locale,
    slug: "great-novel",
    publicPageShortId: "abc123",
    status: "published",
    updatedAt,
    novelStatus: "published",
    promoLink: { status: "fetched", webUrl: "https://x.example/w", appUrl: null },
  });
}

describe("enqueueIndexNowFirstPublish — double-gate boundary", () => {
  it("is a no-op when both flags are off (default)", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const result = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, testEnv(), LOCALE_OK);
    expect(result).toEqual({ outcome: "disabled" });
    expect(fake.outbox.size).toBe(0);
  });

  it("is a no-op when only FEATURE is on but ALLOW_WRITE is off", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const result = await enqueueIndexNowFirstPublish(
      fake.asPrismaClient(),
      { articleId: "article-1", source: "test" },
      testEnv({ FEATURE_INDEXNOW_OUTBOX: "true" }),
      LOCALE_OK,
    );
    expect(result).toEqual({ outcome: "disabled" });
    expect(fake.outbox.size).toBe(0);
  });

  it("is a no-op when only ALLOW_WRITE is on but FEATURE is off", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const result = await enqueueIndexNowFirstPublish(
      fake.asPrismaClient(),
      { articleId: "article-1", source: "test" },
      testEnv({ INDEXNOW_OUTBOX_ALLOW_WRITE: "true" }),
      LOCALE_OK,
    );
    expect(result).toEqual({ outcome: "disabled" });
    expect(fake.outbox.size).toBe(0);
  });

  it("writes when both flags are true", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const result = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);
    expect(result.outcome).toBe("enqueued");
    expect(fake.outbox.size).toBe(1);
  });

  it("enqueues en under the real SITE_LOCALES gate without a locale override", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"), "en");
    const result = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV);
    expect(result.outcome).toBe("enqueued");
    expect(fake.outbox.size).toBe(1);
  });

  it("L10N P4: also enqueues es under the real gate — the D-7 publish whitelist that used to block a registered-but-unopened locale here is deleted", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"), "es");
    const result = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV);
    expect(result.outcome).toBe("enqueued");
    expect(fake.outbox.size).toBe(1);
  });

  it("is ineligible under the real gate for a locale not registered in SITE_LOCALES at all", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"), "xx-not-a-real-locale");
    const result = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV);
    expect(result).toEqual({ outcome: "ineligible" });
    expect(fake.outbox.size).toBe(0);
  });
});

describe("enqueueIndexNowFirstPublish — (url, revision) idempotency", () => {
  it("returns ineligible when the Article does not satisfy isNovelIndexNowEligible (unpublished Novel)", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedArticle({
      id: "article-1",
      status: "published",
      novelStatus: "draft",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const result = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);
    expect(result).toEqual({ outcome: "ineligible" });
  });

  it("returns ineligible for a nonexistent article", async () => {
    const fake = new FakeIndexNowDb();
    const result = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "missing", source: "test" }, ENABLED_ENV, LOCALE_OK);
    expect(result).toEqual({ outcome: "ineligible" });
  });

  it("a byte-identical resubmission (same url, same revision) is a duplicate no-op", async () => {
    const fake = new FakeIndexNowDb();
    const updatedAt = new Date("2026-01-01T00:00:00.000Z");
    seedEligibleArticle(fake, "article-1", updatedAt);
    const first = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);
    expect(first.outcome).toBe("enqueued");
    expect(fake.outbox.size).toBe(1);

    // Same Article, same updatedAt (same revision) — a second enqueue call
    // (e.g. a retried publish transition) must not create a second row.
    const second = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);
    expect(second.outcome).toBe("duplicate");
    expect(fake.outbox.size).toBe(1);
  });

  it("a later edit (new revision, same URL) produces a second, distinct row — the intentional behavior change from CPS", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const first = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);
    expect(first.outcome).toBe("enqueued");

    // Article edited and its updatedAt bumped — same canonical URL, new revision.
    fake.articles.get("article-1")!.updatedAt = new Date("2026-01-02T00:00:00.000Z");
    const second = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);
    expect(second.outcome).toBe("enqueued");
    expect(fake.outbox.size).toBe(2);

    const rows = [...fake.outbox.values()];
    expect(rows[0]!.url).toBe(rows[1]!.url);
    expect(rows[0]!.revision).not.toBe(rows[1]!.revision);
  });

  it("[13] publishing only writes the outbox record — it creates NO generic_task and NO generic_task_item", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const result = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);
    expect(result.outcome).toBe("enqueued");
    expect(fake.outbox.size).toBe(1);
    expect(fake.genericTasks.size).toBe(0);
    expect(fake.genericTaskItems.size).toBe(0);
    expect(fake.outbox.get(result.outboxId!)!.deliveryTaskId).toBeNull();
    expect(fake.outbox.get(result.outboxId!)!.status).toBe("pending");
  });

  it("throws when deferUntil is given without deferReason (or vice versa)", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    await expect(
      enqueueIndexNowFirstPublish(
        fake.asPrismaClient(),
        { articleId: "article-1", source: "test", deferUntil: new Date(Date.now() + 60_000) },
        ENABLED_ENV,
        LOCALE_OK,
      ),
    ).rejects.toThrow(/deferUntil and deferReason/);
  });

  it("a deferred enqueue stays pending behind its availableAt until released", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const result = await enqueueIndexNowFirstPublish(
      fake.asPrismaClient(),
      { articleId: "article-1", source: "test", deferUntil: new Date(Date.now() + 3_600_000), deferReason: "await_review" },
      ENABLED_ENV,
      LOCALE_OK,
    );
    expect(result.outcome).toBe("deferred");
    expect(fake.genericTaskItems.size).toBe(0);
    const row = fake.outbox.get(result.outboxId!)!;
    expect(row.deferReason).toBe("await_review");
    expect(row.availableAt).not.toBeNull();
  });
});

describe("releaseDeferredIndexNowOutbox", () => {
  it("releases a deferred row, sets releaseCommit only now (not at enqueue time), and creates no task (the minute sweep picks it up)", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const enqueued = await enqueueIndexNowFirstPublish(
      fake.asPrismaClient(),
      { articleId: "article-1", source: "test", deferUntil: new Date(Date.now() + 3_600_000), deferReason: "await_review" },
      ENABLED_ENV,
      LOCALE_OK,
    );
    expect(fake.outbox.get(enqueued.outboxId!)!.releaseCommit).toBe("");

    const released = await releaseDeferredIndexNowOutbox(
      fake.asPrismaClient(),
      { outboxIds: [enqueued.outboxId!], reason: "manual_release", releaseCommit: "abc1234" },
      ENABLED_ENV,
    );
    expect(released.released).toBe(1);
    const row = fake.outbox.get(enqueued.outboxId!)!;
    expect(row.releasedAt).not.toBeNull();
    expect(row.releaseReason).toBe("manual_release");
    expect(row.releaseCommit).toBe("abc1234");
    expect(fake.genericTaskItems.size).toBe(0);
    expect(fake.genericTasks.size).toBe(0);
    expect(row.availableAt).not.toBeNull();
  });

  it("is a no-op for a row that was never deferred", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const enqueued = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);
    const released = await releaseDeferredIndexNowOutbox(
      fake.asPrismaClient(),
      { outboxIds: [enqueued.outboxId!], reason: "manual_release" },
      ENABLED_ENV,
    );
    expect(released.released).toBe(0);
  });

  it("is a no-op when the double gate is off", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "https://example.com/novel/x-p1", revision: 1n, status: "pending", deferReason: "await_review", availableAt: new Date(Date.now() + 3_600_000) });
    const released = await releaseDeferredIndexNowOutbox(fake.asPrismaClient(), { outboxIds: ["outbox-1"], reason: "manual" }, testEnv());
    expect(released.released).toBe(0);
    expect(fake.outbox.get("outbox-1")!.releasedAt).toBeNull();
  });
});

describe("articleHasAnyIndexNowOutbox", () => {
  it("is true for ANY record — any status, any source, any revision — and false for none", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "o-1", articleId: "with-record", url: "https://x.example/a", revision: 1n, status: "cancelled", source: "whatever" });
    expect(await articleHasAnyIndexNowOutbox(fake.asPrismaClient(), "with-record")).toBe(true);
    expect(await articleHasAnyIndexNowOutbox(fake.asPrismaClient(), "without-record")).toBe(false);
  });
});

describe("ensureIndexNowBatchDeliveryTask", () => {
  it("creates one task + one item, and a second call while it is in flight reports created: false", async () => {
    const fake = new FakeIndexNowDb();
    const first = await ensureIndexNowBatchDeliveryTask(fake.asTransactionClient(), { reason: "r", triggeredBy: "t" });
    expect(first.created).toBe(true);
    const second = await ensureIndexNowBatchDeliveryTask(fake.asTransactionClient(), { reason: "r", triggeredBy: "t" });
    expect(second).toEqual({ created: false, taskId: first.taskId });
    expect(fake.genericTasks.size).toBe(1);
    expect(fake.genericTaskItems.size).toBe(1);
    expect([...fake.genericTasks.values()][0]!.operationScopeHash).toBe(INDEXNOW_BATCH_OPERATION_SCOPE_HASH);
  });

  it("a bare client is wrapped in a transaction: if the item insert fails the task row rolls back too (never an item-less task holding the scope)", async () => {
    const fake = new FakeIndexNowDb();
    const realTx = fake.asTransactionClient.bind(fake);
    fake.asTransactionClient = () => {
      const tx = realTx() as unknown as { genericTaskItem: Record<string, unknown> };
      tx.genericTaskItem = {
        ...tx.genericTaskItem,
        createMany: async () => {
          throw new Error("item insert failed");
        },
      };
      return tx as never;
    };
    await expect(ensureIndexNowBatchDeliveryTask(fake.asPrismaClient(), { reason: "r", triggeredBy: "t" })).rejects.toThrow("item insert failed");
    expect(fake.genericTasks.size).toBe(0);

    const healthy = new FakeIndexNowDb();
    expect((await ensureIndexNowBatchDeliveryTask(healthy.asPrismaClient(), { reason: "r", triggeredBy: "t" })).created).toBe(true);
    expect(healthy.genericTasks.size).toBe(1);
    expect(healthy.genericTaskItems.size).toBe(1);
  });
});

describe("[14] listPublishedWithoutIndexNowDelivery — cursor-complete difference query", () => {
  function seedMany(fake: FakeIndexNowDb, count: number, withOutbox: (index: number) => boolean = () => false) {
    for (let index = 0; index < count; index++) {
      const id = `art-${String(index).padStart(6, "0")}`;
      fake.seedArticle({ id, novelId: `n-${index}`, slug: `s-${index}`, publicPageShortId: `x${index}`, publishedAt: new Date(2026, 0, 1 + (index % 28)) });
      if (withOutbox(index)) fake.seedOutbox({ id: `o-${index}`, articleId: id, url: `https://x.example/${index}`, revision: 1n });
    }
  }

  it("walks past 5,000 articles across many pages: the candidate list equals ALL of them (the old cap was 5,000)", async () => {
    const fake = new FakeIndexNowDb();
    seedMany(fake, 5_321);
    const { candidates, stats } = await listPublishedWithoutIndexNowDelivery(fake.asPrismaClient(), { pageSize: 700, eligibilityOptions: LOCALE_OK });
    expect(candidates).toHaveLength(5_321);
    expect(stats).toEqual({ scanned: 5_321, alreadyHasDelivery: 0, ineligible: 0, eligible: 5_321 });
    expect(candidates[0]!.articleId).toBe("art-000000");
    expect(candidates[5_320]!.articleId).toBe("art-005320");
    expect(candidates[0]!.publishedAt).toBeInstanceOf(Date);
  });

  it("a final page that is exactly full still gets one more page fetched (an EMPTY page is the end)", async () => {
    const fake = new FakeIndexNowDb();
    seedMany(fake, 30);
    const pages: number[] = [];
    const db = fake.asPrismaClient();
    const original = db.article.findMany;
    (db.article as { findMany: unknown }).findMany = async (args: Parameters<typeof original>[0]) => {
      const rows = await original(args);
      // Only the cursor pages (they carry an orderBy); the batch eligibility loader also uses article.findMany.
      if (args?.orderBy) pages.push(rows.length);
      return rows;
    };
    const { candidates } = await listPublishedWithoutIndexNowDelivery(db, { pageSize: 10, eligibilityOptions: LOCALE_OK });
    expect(candidates).toHaveLength(30);
    expect(pages).toEqual([10, 10, 10, 0]);
  });

  it("a SHORT page in the middle is not the end: it keeps paging until an empty page (a source that serves fewer rows than asked must not lose the rest)", async () => {
    const fake = new FakeIndexNowDb();
    seedMany(fake, 25);
    const db = fake.asPrismaClient();
    const original = db.article.findMany;
    // Serve at most 3 rows per call even though 1000 were requested.
    (db.article as { findMany: unknown }).findMany = async (args: Parameters<typeof original>[0]) =>
      original({ ...args, take: Math.min(args?.take ?? 3, 3) });
    const { candidates, stats } = await listPublishedWithoutIndexNowDelivery(db, { pageSize: 1000, eligibilityOptions: LOCALE_OK });
    expect(candidates).toHaveLength(25);
    expect(stats.scanned).toBe(25);
  });

  it("excludes articles that already have any record, counts them, and rechecks eligibility for the rest", async () => {
    const fake = new FakeIndexNowDb();
    seedMany(fake, 10, (index) => index % 2 === 0); // 5 with a record
    fake.articles.get("art-000001")!.novelStatus = "draft"; // candidate but ineligible
    const { candidates, stats } = await listPublishedWithoutIndexNowDelivery(fake.asPrismaClient(), { pageSize: 4, eligibilityOptions: LOCALE_OK });
    expect(stats).toEqual({ scanned: 10, alreadyHasDelivery: 5, ineligible: 1, eligible: 4 });
    expect(candidates.map((candidate) => candidate.articleId)).toEqual(["art-000003", "art-000005", "art-000007", "art-000009"]);
  });

  it("skips drafts, soft-deleted articles and the blog family", async () => {
    const fake = new FakeIndexNowDb();
    seedMany(fake, 3);
    fake.seedArticle({ id: "draft", status: "draft", slug: "d", publicPageShortId: "d1" });
    fake.seedArticle({ id: "deleted", deletedAt: new Date(), slug: "x", publicPageShortId: "x1" });
    fake.seedArticle({ id: "blog", articleType: "blog_article", slug: "b", publicPageShortId: "b1" });
    const { candidates, stats } = await listPublishedWithoutIndexNowDelivery(fake.asPrismaClient(), { eligibilityOptions: LOCALE_OK });
    expect(candidates).toHaveLength(3);
    expect(stats.scanned).toBe(3);
  });
});
