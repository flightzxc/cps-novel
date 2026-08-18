import { describe, expect, it } from "vitest";

import { enqueueIndexNowFirstPublish, findPublishedWithoutIndexNowDelivery, releaseDeferredIndexNowOutbox } from "@/lib/indexnow/outbox";

import { FakeIndexNowDb, installTestSiteUrl, testEnv } from "./fake-db";

installTestSiteUrl();

const ENABLED_ENV = testEnv({ FEATURE_INDEXNOW_OUTBOX: "true", INDEXNOW_OUTBOX_ALLOW_WRITE: "true" });
// `isPublishableLocale` (the real default) is an empty whitelist pending
// D-7 — see `eligibility.test.ts` for coverage of that production default.
// These tests exercise the rest of `enqueueIndexNowFirstPublish`'s behavior
// and inject an always-true locale gate so they are not permanently red
// against that shared, already-documented blocker.
const LOCALE_OK = { isLocalePublishable: () => true };

function seedEligibleArticle(fake: FakeIndexNowDb, id: string, updatedAt: Date) {
  fake.seedArticle({
    id,
    novelId: "novel-1",
    locale: "en",
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

  it("is ineligible under the real (empty) locale whitelist even with both flags on — integration-level check of the shared D-7 blocker", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
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

  it("creates exactly one GenericTask + GenericTaskItem for an immediate (non-deferred) enqueue", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    const result = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);
    expect(fake.genericTasks.size).toBe(1);
    expect(fake.genericTaskItems.size).toBe(1);
    const outboxRow = fake.outbox.get(result.outboxId!)!;
    expect(outboxRow.deliveryTaskId).toBe([...fake.genericTasks.values()][0]!.id);
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

  it("a deferred enqueue does not create a delivery task item until released", async () => {
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
  it("releases a deferred row, sets releaseCommit only now (not at enqueue time), and dispatches a delivery item", async () => {
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
    expect(fake.genericTaskItems.size).toBe(1);
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

describe("findPublishedWithoutIndexNowDelivery", () => {
  it("returns published Articles that have no outbox row yet, and excludes ones that already do", async () => {
    const fake = new FakeIndexNowDb();
    seedEligibleArticle(fake, "article-1", new Date("2026-01-01T00:00:00.000Z"));
    seedEligibleArticle(fake, "article-2", new Date("2026-01-01T00:00:00.000Z"));
    await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: "article-1", source: "test" }, ENABLED_ENV, LOCALE_OK);

    const candidates = await findPublishedWithoutIndexNowDelivery(fake.asPrismaClient(), 500, LOCALE_OK);
    expect(candidates.map((c) => c.articleId)).toEqual(["article-2"]);
  });

  it("excludes candidates that fail eligibility even without an outbox row", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedArticle({ id: "article-1", status: "published", novelStatus: "draft", updatedAt: new Date() });
    const candidates = await findPublishedWithoutIndexNowDelivery(fake.asPrismaClient(), 500, LOCALE_OK);
    expect(candidates).toEqual([]);
  });
});
