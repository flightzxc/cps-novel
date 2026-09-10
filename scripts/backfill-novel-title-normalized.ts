/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.1) one-time
 * backfill for `Novel.titleNormalized` (`novel.title_normalized`, added by
 * `prisma/migrations/20260911090000_c30_novel_rebind_foundation/migration.sql`
 * as a nullable, no-DEFAULT column — see that migration's own header for why
 * the backfill is deliberately NOT folded into the DDL).
 *
 * Idempotent and re-runnable: only ever selects and writes rows where
 * `title_normalized IS NULL`, and each row's write is itself a conditional
 * `updateMany` re-asserting that same `IS NULL` predicate — a row normalized
 * by a concurrent run (or by the one live write point,
 * `src/server/content-creation/service.ts`'s `runCreateTransaction`, though
 * that only ever creates NEW rows, never touches an existing NULL one) is
 * silently skipped rather than double-written. A second full run against an
 * already-backfilled table performs zero writes.
 *
 * Batched with an explicit upper bound (`--max-rows`, default 5000) so a
 * single invocation cannot runaway-scan/write an unbounded number of rows —
 * re-run the script (same idempotent contract) to continue past the cap.
 *
 * Usage:
 *   npx tsx scripts/backfill-novel-title-normalized.ts [--batch-size N] [--max-rows N] [--dry-run]
 *
 * `--dry-run` (default false) reports how many rows would be touched without
 * writing anything — useful to size the real run before committing to it.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { normalizeNovelTitle } from "../src/lib/novel/novel-identity";

export const BACKFILL_DEFAULT_BATCH_SIZE = 200;
export const BACKFILL_DEFAULT_MAX_ROWS = 5000;

export type BackfillNovelTitleNormalizedDb = {
  novel: {
    findMany(args: {
      where: { titleNormalized: null };
      select: { id: true; title: true };
      orderBy: { id: "asc" };
      take: number;
    }): Promise<Array<{ id: string; title: string }>>;
    updateMany(args: {
      where: { id: string; titleNormalized: null };
      data: { titleNormalized: string };
    }): Promise<{ count: number }>;
  };
};

export type BackfillNovelTitleNormalizedReport = {
  scanned: number;
  updated: number;
  skippedConcurrentlyFilled: number;
  batches: number;
  hitMaxRows: boolean;
};

export type BackfillNovelTitleNormalizedOptions = {
  batchSize?: number;
  maxRows?: number;
  dryRun?: boolean;
};

/**
 * Core loop, injectable-db so it can be exercised against a fake in unit
 * tests and against a real `PrismaClient` in the integration test / CLI.
 */
export async function backfillNovelTitleNormalized(
  db: BackfillNovelTitleNormalizedDb,
  options: BackfillNovelTitleNormalizedOptions = {},
): Promise<BackfillNovelTitleNormalizedReport> {
  const batchSize = options.batchSize ?? BACKFILL_DEFAULT_BATCH_SIZE;
  const maxRows = options.maxRows ?? BACKFILL_DEFAULT_MAX_ROWS;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("batchSize must be a positive integer");
  if (!Number.isInteger(maxRows) || maxRows <= 0) throw new Error("maxRows must be a positive integer");
  const dryRun = options.dryRun ?? false;

  const report: BackfillNovelTitleNormalizedReport = {
    scanned: 0,
    updated: 0,
    skippedConcurrentlyFilled: 0,
    batches: 0,
    hitMaxRows: false,
  };

  for (;;) {
    if (report.scanned >= maxRows) {
      report.hitMaxRows = true;
      break;
    }
    const take = Math.min(batchSize, maxRows - report.scanned);
    const rows = await db.novel.findMany({
      where: { titleNormalized: null },
      select: { id: true, title: true },
      orderBy: { id: "asc" },
      take,
    });
    if (rows.length === 0) break;
    report.batches += 1;
    report.scanned += rows.length;

    for (const row of rows) {
      const titleNormalized = normalizeNovelTitle(row.title);
      if (dryRun) {
        report.updated += 1;
        continue;
      }
      // Conditional write: re-asserts `titleNormalized: null` so a row
      // normalized between the read above and this write (by a concurrent
      // run of this same script, or in principle a future second write
      // point — see `normalizeNovelTitle`'s own doc comment) is counted as
      // skipped rather than clobbered.
      const result = await db.novel.updateMany({
        where: { id: row.id, titleNormalized: null },
        data: { titleNormalized },
      });
      if (result.count === 1) report.updated += 1;
      else report.skippedConcurrentlyFilled += 1;
    }

    if (rows.length < take) break; // last (short) page
  }

  return report;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const batchSizeArg = arg("--batch-size");
  const maxRowsArg = arg("--max-rows");
  const dryRun = process.argv.includes("--dry-run");
  const prisma = new PrismaClient();
  try {
    const report = await backfillNovelTitleNormalized(prisma, {
      batchSize: batchSizeArg ? Number(batchSizeArg) : undefined,
      maxRows: maxRowsArg ? Number(maxRowsArg) : undefined,
      dryRun,
    });
    console.log(JSON.stringify({ dryRun, ...report }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
