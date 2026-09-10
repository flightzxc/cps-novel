import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CAROUSEL_BATCH_STATUSES } from "@/domain/database-statuses";

import { NOW, FakeHomeCarouselDb } from "./support";

/**
 * Direct tests of `FakeHomeCarouselDb`'s CHECK/uniqueness simulation on the
 * three `home_carousel_*` tables `tests/backend/home-carousel/serving-source-check.test.ts`
 * does not cover: `home_carousel_auto_batch` (this file's primary target —
 * the carousel batch-status schema-contract-drift fix, sibling to
 * `20260912100000_carousel_serving_source_check_fix`), `home_carousel_auto_candidate`,
 * and `home_carousel_manual_slot`. `compute.test.ts`/`merge.test.ts` never
 * exercise the negative branches below (`computeHomeCarouselInTx`, after
 * this fix, never writes an invalid row to any of these tables) — these
 * tests call the fake's `create`/`update`/`createMany` directly, proving the
 * simulation matches what real PostgreSQL would do for each CHECK/unique
 * constraint `20260803090000_p1_initial_schema` installs on these tables,
 * not merely that it agrees with whatever `service.ts` happens to write
 * today.
 */

function batchTx(db: FakeHomeCarouselDb) {
  return db.asTransactionClient() as unknown as {
    homeCarouselAutoBatch: {
      create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
  };
}

function batchData(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    uniqueKey: `manual:${randomUUID()}`,
    runDate: new Date("2026-09-05T00:00:00.000Z"),
    triggerSource: "manual",
    localeScope: "en",
    algorithmVersion: "novel-recency-v1",
    params: {},
    startedAt: NOW,
    createdBy: "admin-1",
    ...overrides,
  };
}

describe("FakeHomeCarouselDb homeCarouselAutoBatch CHECK simulation (home_carousel_auto_batch_status_check)", () => {
  it("create accepts every CAROUSEL_BATCH_STATUSES member", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = batchTx(db);
    for (const status of CAROUSEL_BATCH_STATUSES) {
      const row = await tx.homeCarouselAutoBatch.create({ data: batchData({ status }) });
      expect(row.status).toBe(status);
    }
    expect(db.batches.size).toBe(CAROUSEL_BATCH_STATUSES.length);
  });

  it("create defaults to 'pending' when status is omitted (matches the column's DB DEFAULT)", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = batchTx(db);
    const row = await tx.homeCarouselAutoBatch.create({ data: batchData() });
    expect(row.status).toBe("pending");
  });

  it("create rejects a status outside CAROUSEL_BATCH_STATUSES with a CHECK-shaped error, same as real PostgreSQL 23514, and writes nothing", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = batchTx(db);
    // "success" is the exact stale value the pre-fix `computeHomeCarouselInTx`
    // wrote and no CHECK has ever allowed — see service.ts's fix comment.
    await expect(tx.homeCarouselAutoBatch.create({ data: batchData({ status: "success" }) }))
      .rejects.toThrow(/home_carousel_auto_batch_status_check/);
    expect(db.batches.size).toBe(0);
  });

  it("update rejects a status outside CAROUSEL_BATCH_STATUSES and leaves the existing row unchanged", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = batchTx(db);
    const created = await tx.homeCarouselAutoBatch.create({ data: batchData({ status: "pending" }) });
    await expect(tx.homeCarouselAutoBatch.update({ where: { id: created.id as string }, data: { status: "success", finishedAt: NOW } }))
      .rejects.toThrow(/home_carousel_auto_batch_status_check/);
    expect(db.batches.get(created.id as string)?.status).toBe("pending");
  });

  it("update accepts every CAROUSEL_BATCH_STATUSES member as a transition target", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = batchTx(db);
    const created = await tx.homeCarouselAutoBatch.create({ data: batchData({ status: "pending" }) });
    for (const status of CAROUSEL_BATCH_STATUSES) {
      const updated = await tx.homeCarouselAutoBatch.update({ where: { id: created.id as string }, data: { status } });
      expect(updated.status).toBe(status);
    }
  });
});

function candidateTx(db: FakeHomeCarouselDb) {
  return db.asTransactionClient() as unknown as {
    homeCarouselAutoCandidate: { createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<{ count: number }> };
  };
}

function candidateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    batchId: "batch-1",
    locale: "en",
    novelId: "novel-1",
    articleId: "article-1",
    source: "recency",
    rank: 1,
    reason: {},
    ...overrides,
  };
}

describe("FakeHomeCarouselDb homeCarouselAutoCandidate CHECK/uniqueness simulation (carousel_candidate_rank_check + unique keys)", () => {
  it("rejects rank <= 0 and writes nothing", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = candidateTx(db);
    await expect(tx.homeCarouselAutoCandidate.createMany({ data: [candidateRow({ rank: 0 })] }))
      .rejects.toThrow(/carousel_candidate_rank_check/);
    expect(db.candidates).toHaveLength(0);
  });

  it("rejects a (batch_id, locale, rank) collision against an existing row", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = candidateTx(db);
    await tx.homeCarouselAutoCandidate.createMany({ data: [candidateRow({ rank: 1, novelId: "novel-1" })] });
    await expect(tx.homeCarouselAutoCandidate.createMany({ data: [candidateRow({ rank: 1, novelId: "novel-2", articleId: "article-2" })] }))
      .rejects.toThrow(/carousel_candidate_batch_locale_rank_key/);
    expect(db.candidates).toHaveLength(1);
  });

  it("rejects a (batch_id, novel_id) collision against an existing row", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = candidateTx(db);
    await tx.homeCarouselAutoCandidate.createMany({ data: [candidateRow({ rank: 1, novelId: "novel-1" })] });
    await expect(tx.homeCarouselAutoCandidate.createMany({ data: [candidateRow({ rank: 2, novelId: "novel-1" })] }))
      .rejects.toThrow(/carousel_candidate_batch_novel_key/);
    expect(db.candidates).toHaveLength(1);
  });

  it("is all-or-nothing: one bad row in a batch leaves every other row in that same batch uncommitted too", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = candidateTx(db);
    await expect(tx.homeCarouselAutoCandidate.createMany({
      data: [candidateRow({ rank: 1, novelId: "novel-1" }), candidateRow({ rank: 0, novelId: "novel-2" })],
    })).rejects.toThrow(/carousel_candidate_rank_check/);
    expect(db.candidates).toHaveLength(0);
  });
});

function manualSlotTx(db: FakeHomeCarouselDb) {
  return db.asTransactionClient() as unknown as {
    homeCarouselManualSlot: {
      create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
  };
}

function manualSlotData(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    locale: "en",
    position: 1,
    novelId: "novel-1",
    articleId: "article-1",
    enabled: true,
    createdBy: "admin-1",
    updatedBy: "admin-1",
    ...overrides,
  };
}

describe("FakeHomeCarouselDb homeCarouselManualSlot CHECK/uniqueness simulation (carousel_manual_position_check + carousel_manual_window_check + partial-unique indexes)", () => {
  it("rejects position <= 0", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = manualSlotTx(db);
    await expect(tx.homeCarouselManualSlot.create({ data: manualSlotData({ position: 0 }) }))
      .rejects.toThrow(/carousel_manual_position_check/);
    expect(db.manualSlots.size).toBe(0);
  });

  it("rejects starts_at >= ends_at", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = manualSlotTx(db);
    const startsAt = new Date("2026-09-10T00:00:00.000Z");
    const endsAt = new Date("2026-09-01T00:00:00.000Z");
    await expect(tx.homeCarouselManualSlot.create({ data: manualSlotData({ startsAt, endsAt }) }))
      .rejects.toThrow(/carousel_manual_window_check/);
    expect(db.manualSlots.size).toBe(0);
  });

  it("accepts a null starts_at/ends_at window (both unset)", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = manualSlotTx(db);
    const row = await tx.homeCarouselManualSlot.create({ data: manualSlotData() });
    expect(row.position).toBe(1);
  });

  it("rejects an active (locale, position) collision with another active row", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = manualSlotTx(db);
    await tx.homeCarouselManualSlot.create({ data: manualSlotData({ position: 1, novelId: "novel-1", articleId: "article-1" }) });
    await expect(tx.homeCarouselManualSlot.create({ data: manualSlotData({ position: 1, novelId: "novel-2", articleId: "article-2" }) }))
      .rejects.toThrow(/carousel_manual_position_active_uidx/);
    expect(db.manualSlots.size).toBe(1);
  });

  it("rejects an active (locale, novel_id) collision with another active row", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = manualSlotTx(db);
    await tx.homeCarouselManualSlot.create({ data: manualSlotData({ position: 1, novelId: "novel-1" }) });
    await expect(tx.homeCarouselManualSlot.create({ data: manualSlotData({ position: 2, novelId: "novel-1" }) }))
      .rejects.toThrow(/carousel_manual_novel_active_uidx/);
    expect(db.manualSlots.size).toBe(1);
  });

  it("a disabled (soft-deleted) row does not collide with a new active row at the same position — partial-index semantics", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = manualSlotTx(db);
    const created = await tx.homeCarouselManualSlot.create({ data: manualSlotData({ position: 1, novelId: "novel-1" }) });
    await tx.homeCarouselManualSlot.update({ where: { id: created.id as string }, data: { enabled: false, deletedAt: NOW } });
    const replacement = await tx.homeCarouselManualSlot.create({ data: manualSlotData({ position: 1, novelId: "novel-2", articleId: "article-2" }) });
    expect(replacement.position).toBe(1);
  });

  it("re-saving an unchanged active row through update does not self-collide", async () => {
    const db = new FakeHomeCarouselDb();
    const tx = manualSlotTx(db);
    const created = await tx.homeCarouselManualSlot.create({ data: manualSlotData({ position: 1, novelId: "novel-1" }) });
    const updated = await tx.homeCarouselManualSlot.update({ where: { id: created.id as string }, data: { updatedBy: "admin-2" } });
    expect(updated.position).toBe(1);
  });
});
