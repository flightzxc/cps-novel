import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTENT_CREATION_BATCH_MAX_SELECTION,
  ContentCreationBatchInputError,
  applyContentCreationBatch,
  dryRunContentCreationBatch,
} from "@/server/content-creation/batch";

import { FakeContentCreationDb } from "./fake-db";

/**
 * RC-4 batch wrapper tests. Scope is deliberately narrow — everything about
 * a *single* item's judgment (slug resolution, template rendering, the
 * transaction/idempotency contract) is already covered by
 * `service.test.ts`/`business-id.test.ts`/`template-rendering.test.ts` and
 * is not re-tested here. This file only exercises what `batch.ts` itself
 * adds on top: dedupe, the size cap, strict sequential processing, the
 * wall-clock budget cutoff producing `not_processed`, and per-item failure
 * isolation (including the defensive `ContentCreationInputError` branch,
 * which `service.test.ts` never reaches because every id it uses is already
 * a valid UUID by construction).
 */

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;

describe("batch validation — dedupe + size cap, mirrors createPromoLinkClaimTask's own backstop", () => {
  it("empty selection throws items_required before touching the db", async () => {
    const fake = new FakeContentCreationDb();
    await expect(
      applyContentCreationBatch(fake.asPrismaClient(), {
        novelSourceItemIds: [],
        actor: ADMIN_ACTOR,
        requestId: "req-empty",
      }),
    ).rejects.toMatchObject({ code: "items_required" });
    await expect(
      applyContentCreationBatch(fake.asPrismaClient(), { novelSourceItemIds: [], actor: ADMIN_ACTOR, requestId: "req-empty" }),
    ).rejects.toBeInstanceOf(ContentCreationBatchInputError);
    expect(fake.calls).toHaveLength(0);
  });

  it("selection over CONTENT_CREATION_BATCH_MAX_SELECTION throws batch_size_exceeded before touching the db", async () => {
    const fake = new FakeContentCreationDb();
    const tooMany = Array.from({ length: CONTENT_CREATION_BATCH_MAX_SELECTION + 1 }, (_, i) => `id-${i}`);
    await expect(
      applyContentCreationBatch(fake.asPrismaClient(), {
        novelSourceItemIds: tooMany,
        actor: ADMIN_ACTOR,
        requestId: "req-over",
      }),
    ).rejects.toMatchObject({ code: "batch_size_exceeded" });
    expect(fake.calls).toHaveLength(0);
  });

  it("duplicate ids collapse to a single processed item", async () => {
    const fake = new FakeContentCreationDb();
    const item = fake.seedSourceItem({ title: "Only Once" });

    const result = await applyContentCreationBatch(fake.asPrismaClient(), {
      novelSourceItemIds: [item.id, item.id, item.id],
      actor: ADMIN_ACTOR,
      requestId: "req-dedupe",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe("created");
    expect(result.counts).toEqual({ created: 1, skipped_already_linked: 0, failed: 0, not_processed: 0 });
    // One Novel/Article/audit row, not three — proves the collapse happened
    // before any write, not just before the size check.
    expect(fake.novels.size).toBe(1);
    expect(fake.audits).toHaveLength(1);
  });
});

describe("apply — each item reuses the single-item transaction verbatim, one failure never blocks the rest", () => {
  it("created / skipped_already_linked / failed classify independently in one run", async () => {
    const fake = new FakeContentCreationDb();
    const creatable = fake.seedSourceItem({ title: "Creatable Item" });
    const linkedNovel = fake.seedNovel({ locale: "en" });
    const alreadyLinked = fake.seedSourceItem({
      title: "Already Linked Item",
      novelId: linkedNovel.id,
      status: "linked",
    });
    fake.seedArticle({ novelId: linkedNovel.id, locale: "en" });
    const ignored = fake.seedSourceItem({ title: "Ignored Item", status: "ignored" });

    const result = await applyContentCreationBatch(fake.asPrismaClient(), {
      novelSourceItemIds: [creatable.id, alreadyLinked.id, ignored.id],
      actor: ADMIN_ACTOR,
      requestId: "req-mixed",
    });

    const byId = new Map(result.items.map((entry) => [entry.novelSourceItemId, entry]));
    expect(byId.get(creatable.id)?.status).toBe("created");
    expect(byId.get(creatable.id)?.result?.outcome).toBe("created");
    expect(byId.get(alreadyLinked.id)?.status).toBe("skipped_already_linked");
    expect(byId.get(alreadyLinked.id)?.result?.outcome).toBe("already_exists");
    expect(byId.get(ignored.id)?.status).toBe("failed");
    expect(byId.get(ignored.id)?.result).toEqual({ outcome: "source_item_ignored" });
    expect(result.counts).toEqual({ created: 1, skipped_already_linked: 1, failed: 1, not_processed: 0 });

    // Only the one genuinely-created item wrote a new Novel/Article/audit
    // row (the other Novel in the store is the pre-seeded already-linked
    // fixture, not a new write) — the ignored item's failure did not roll
    // back or skip the creatable item that came after it in the selection.
    expect(fake.novels.size).toBe(2);
    expect(fake.audits).toHaveLength(1);
    expect(fake.sourceItems.get(ignored.id)?.status).toBe("ignored");
  });

  it("a malformed id (defensive ContentCreationInputError branch) fails only that item, not the batch", async () => {
    const fake = new FakeContentCreationDb();
    const good = fake.seedSourceItem({ title: "Valid Item" });

    const result = await applyContentCreationBatch(fake.asPrismaClient(), {
      novelSourceItemIds: ["not-a-uuid", good.id],
      actor: ADMIN_ACTOR,
      requestId: "req-malformed",
    });

    const byId = new Map(result.items.map((entry) => [entry.novelSourceItemId, entry]));
    expect(byId.get("not-a-uuid")).toMatchObject({
      status: "failed",
      inputErrorCode: "invalid_novel_source_item_id",
    });
    expect(byId.get("not-a-uuid")?.result).toBeUndefined();
    expect(byId.get(good.id)?.status).toBe("created");
    expect(result.counts).toEqual({ created: 1, skipped_already_linked: 0, failed: 1, not_processed: 0 });
  });

  it("requestId is suffixed per item (traceable back to the batch, still distinct per audit row)", async () => {
    const fake = new FakeContentCreationDb();
    const item = fake.seedSourceItem({ title: "Traceable Item" });

    await applyContentCreationBatch(fake.asPrismaClient(), {
      novelSourceItemIds: [item.id],
      actor: ADMIN_ACTOR,
      requestId: "batch-req-1",
    });

    expect(fake.audits[0]?.requestId).toBe(`batch-req-1:${item.id}`);
  });
});

describe("wall-clock budget — see batch.ts module header, this is the CPS v7.9.6 504 mitigation", () => {
  it("budgetMs: 0 processes nothing; every id comes back not_processed with zero writes", async () => {
    const fake = new FakeContentCreationDb();
    const a = fake.seedSourceItem({ title: "A" });
    const b = fake.seedSourceItem({ title: "B" });

    const result = await applyContentCreationBatch(fake.asPrismaClient(), {
      novelSourceItemIds: [a.id, b.id],
      actor: ADMIN_ACTOR,
      requestId: "req-budget-zero",
      budgetMs: 0,
    });

    expect(result.items.map((entry) => entry.status)).toEqual(["not_processed", "not_processed"]);
    expect(result.counts).toEqual({ created: 0, skipped_already_linked: 0, failed: 0, not_processed: 2 });
    expect(fake.calls).toHaveLength(0);
    expect(fake.sourceItems.get(a.id)?.status).toBe("pending");
    expect(fake.sourceItems.get(b.id)?.status).toBe("pending");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("budget exhausted mid-batch: already-committed items are not rolled back, the rest come back not_processed untouched", async () => {
    const fake = new FakeContentCreationDb();
    // Titles long enough to clear `MIN_HEALTHY_SLUG_LENGTH` (5) — a
    // one-letter title would fail at the `slug_unhealthy` guard before ever
    // reaching the budget logic this test actually exercises.
    const a = fake.seedSourceItem({ title: "Budget Item A" });
    const b = fake.seedSourceItem({ title: "Budget Item B" });
    const c = fake.seedSourceItem({ title: "Budget Item C" });

    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // Fires once, right after item A's own read — pushes the clock past the
    // budget before the loop's next-iteration check, so B and C are cut off
    // without ever being touched. A's own processing (already past its read)
    // completes normally.
    fake.onSourceItemRead = () => {
      now += 10_000;
    };

    const result = await applyContentCreationBatch(fake.asPrismaClient(), {
      novelSourceItemIds: [a.id, b.id, c.id],
      actor: ADMIN_ACTOR,
      requestId: "req-budget-cutoff",
      budgetMs: 5_000,
    });

    expect(result.items.map((entry) => entry.status)).toEqual(["created", "not_processed", "not_processed"]);
    expect(result.counts).toEqual({ created: 1, skipped_already_linked: 0, failed: 0, not_processed: 2 });
    expect(fake.sourceItems.get(a.id)?.status).toBe("linked");
    expect(fake.sourceItems.get(b.id)?.status).toBe("pending");
    expect(fake.sourceItems.get(c.id)?.status).toBe("pending");
    expect(fake.audits).toHaveLength(1);
  });
});

describe("dry run — same loop, zero writes", () => {
  it("classifies dry_run/already_exists/blocked and writes nothing at all", async () => {
    const fake = new FakeContentCreationDb();
    const creatable = fake.seedSourceItem({ title: "Preview Creatable" });
    const linkedNovel = fake.seedNovel({ locale: "en" });
    const alreadyLinked = fake.seedSourceItem({
      title: "Preview Linked",
      novelId: linkedNovel.id,
      status: "linked",
    });
    fake.seedArticle({ novelId: linkedNovel.id, locale: "en" });
    const stale = fake.seedSourceItem({ title: "Preview Stale", status: "stale" });

    const result = await dryRunContentCreationBatch(fake.asPrismaClient(), {
      novelSourceItemIds: [creatable.id, alreadyLinked.id, stale.id],
      actor: ADMIN_ACTOR,
      requestId: "req-preview",
    });

    const byId = new Map(result.items.map((entry) => [entry.novelSourceItemId, entry]));
    expect(byId.get(creatable.id)?.status).toBe("creatable");
    expect(byId.get(alreadyLinked.id)?.status).toBe("skipped_already_linked");
    expect(byId.get(stale.id)?.status).toBe("failed");
    expect(byId.get(stale.id)?.result).toEqual({ outcome: "source_item_stale" });
    expect(result.counts).toEqual({ creatable: 1, skipped_already_linked: 1, failed: 1, not_processed: 0 });

    expect(fake.novels.size).toBe(1); // only the pre-seeded already-linked fixture, nothing new
    expect(fake.audits).toHaveLength(0);
    expect(fake.calls).not.toContain("novel.create");
    expect(fake.calls).not.toContain("article.create");
    expect(fake.calls).not.toContain("novelSourceItem.updateMany");
  });
});

describe("strict sequential processing is a load-bearing constraint, not an implementation detail", () => {
  it("batch.ts never uses Promise.all/allSettled to fan out per-item calls", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src/server/content-creation/batch.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/Promise\.(all|allSettled)\s*\(/);
  });
});
