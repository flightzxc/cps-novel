import { describe, expect, it } from "vitest";

import {
  backfillNovelTitleNormalized,
  type BackfillNovelTitleNormalizedDb,
} from "../../../scripts/backfill-novel-title-normalized";

/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.1). Fake-db unit
 * coverage for the backfill's own batching/idempotency contract — the real-
 * PostgreSQL confirmation lives in
 * `tests/integration/article-rebind/two-field-atomic.test.ts` (test 4,
 * env-gated); this file exists so the core loop logic (which rows get
 * selected, what a conditional re-write does, the `maxRows` cap) has a
 * fast, always-run regression net independent of a real database.
 */

type FakeRow = { id: string; title: string; titleNormalized: string | null };

class FakeNovelBackfillDb implements BackfillNovelTitleNormalizedDb {
  readonly rows: FakeRow[] = [];
  readonly novel = {
    findMany: async (args: { where: { titleNormalized: null }; select: { id: true; title: true }; orderBy: { id: "asc" }; take: number }) => {
      return this.rows
        .filter((row) => row.titleNormalized === null)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args.take)
        .map((row) => ({ id: row.id, title: row.title }));
    },
    updateMany: async (args: { where: { id: string; titleNormalized: null }; data: { titleNormalized: string } }) => {
      const row = this.rows.find((candidate) => candidate.id === args.where.id && candidate.titleNormalized === null);
      if (!row) return { count: 0 };
      row.titleNormalized = args.data.titleNormalized;
      return { count: 1 };
    },
  };
}

function seed(db: FakeNovelBackfillDb, id: string, title: string, titleNormalized: string | null = null) {
  db.rows.push({ id, title, titleNormalized });
}

describe("backfillNovelTitleNormalized", () => {
  it("only selects and writes rows where title_normalized IS NULL", async () => {
    const db = new FakeNovelBackfillDb();
    seed(db, "1", "The King's Return");
    seed(db, "2", "Already Normalized", "already normalized");

    const report = await backfillNovelTitleNormalized(db);

    expect(report.scanned).toBe(1);
    expect(report.updated).toBe(1);
    expect(db.rows.find((row) => row.id === "1")!.titleNormalized).toBe("the kings return"); // normalizeNovelTitle strips quote characters entirely
    expect(db.rows.find((row) => row.id === "2")!.titleNormalized).toBe("already normalized"); // untouched
  });

  it("second run against the same data performs zero writes (idempotent)", async () => {
    const db = new FakeNovelBackfillDb();
    seed(db, "1", "Some Title");
    seed(db, "2", "Another Title");

    const first = await backfillNovelTitleNormalized(db);
    expect(first.updated).toBe(2);

    const second = await backfillNovelTitleNormalized(db);
    expect(second.scanned).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.batches).toBe(0);
  });

  it("respects maxRows and reports hitMaxRows, letting a second invocation continue", async () => {
    const db = new FakeNovelBackfillDb();
    for (let i = 0; i < 5; i += 1) seed(db, String(i), `Title ${i}`);

    const first = await backfillNovelTitleNormalized(db, { maxRows: 3, batchSize: 2 });
    expect(first.scanned).toBe(3);
    expect(first.updated).toBe(3);
    expect(first.hitMaxRows).toBe(true);

    const second = await backfillNovelTitleNormalized(db, { maxRows: 3, batchSize: 2 });
    expect(second.scanned).toBe(2); // the remaining two rows
    expect(second.updated).toBe(2);
    expect(second.hitMaxRows).toBe(false);
  });

  it("--dry-run reports would-be updates without writing anything", async () => {
    const db = new FakeNovelBackfillDb();
    seed(db, "1", "Some Title");

    const report = await backfillNovelTitleNormalized(db, { dryRun: true });
    expect(report.updated).toBe(1);
    expect(db.rows[0]!.titleNormalized).toBeNull(); // never actually written
  });

  it("a row normalized concurrently between the read and the conditional write is counted as skipped, not double-applied", async () => {
    const db = new FakeNovelBackfillDb();
    seed(db, "1", "Some Title");
    const originalFindMany = db.novel.findMany.bind(db.novel);
    let firstCall = true;
    // Simulate the row being normalized by a concurrent writer between this
    // script's own read and its conditional write.
    (db.novel as unknown as { findMany: typeof db.novel.findMany }).findMany = async (args) => {
      const rows = await originalFindMany(args);
      if (firstCall) {
        firstCall = false;
        db.rows[0]!.titleNormalized = "concurrently written";
      }
      return rows;
    };

    const report = await backfillNovelTitleNormalized(db);
    expect(report.updated).toBe(0);
    expect(report.skippedConcurrentlyFilled).toBe(1);
    expect(db.rows[0]!.titleNormalized).toBe("concurrently written"); // not clobbered
  });

  it("rejects a non-positive batchSize/maxRows", async () => {
    const db = new FakeNovelBackfillDb();
    await expect(backfillNovelTitleNormalized(db, { batchSize: 0 })).rejects.toThrow();
    await expect(backfillNovelTitleNormalized(db, { maxRows: -1 })).rejects.toThrow();
  });
});
