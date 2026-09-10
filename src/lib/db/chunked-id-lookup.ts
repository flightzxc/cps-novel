/**
 * Chunked `id: { in: [...] }` lookup helpers (C-15,
 * `施工工单_C15_终态扫描绑定变量溢出_2026-09-07.md`).
 *
 * Postgres prepared statements cap bound parameters at **32,767**
 * ("Assertion violation on the database: too many bind variables in
 * prepared statement, expected maximum of 32767, received 32768" — the
 * real error text captured against this repo's own database). A single
 * `findMany({ where: { id: { in: ids } } })` binds one parameter per id
 * (plus one per additional `where` field), so any caller whose id list is
 * built by *aggregating* across many rows/pages/tasks — as opposed to a
 * UI-bounded selection or a schema-enforced uniqueness constraint — must
 * never hand the whole list to Prisma in one query.
 *
 * This is not theoretical: `enqueueMoboreaderPreviewRefreshTask`'s
 * terminal-page "whole task scan" trigger aggregated 96,660 source-item ids
 * from one first full-catalog sync and passed them all to a single
 * `novelSourceItem.findMany({ where: { id: { in: ... } } })`. That blew the
 * 32,767 cap, which rolled back the *entire* finalize transaction (Prisma
 * asserts client-side before ever reaching Postgres, so there is no partial
 * success) — on every subsequent page, forever, since the aggregate only
 * grows. See the work order for the full incident narrative.
 *
 * `ID_IN_LIST_CHUNK_SIZE` (5,000) is a conservative fraction of 32,767:
 * comfortably under the cap even after Prisma adds a handful of extra bind
 * variables for sibling `where` fields (e.g. `channelAppId`, `status`)
 * alongside the `id: { in: chunk } }` clause.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export const ID_IN_LIST_CHUNK_SIZE = 5_000;

/** Splits `ids` into chunks of at most `size` (default {@link ID_IN_LIST_CHUNK_SIZE}). */
export function chunkIds<T>(ids: readonly T[], size: number = ID_IN_LIST_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < ids.length; offset += size) {
    chunks.push(ids.slice(offset, offset + size));
  }
  return chunks;
}

type NovelSourceItemDb = { novelSourceItem: Pick<PrismaClient["novelSourceItem"], "findMany"> };

/**
 * Chunked, deduped replacement for
 * `db.novelSourceItem.findMany({ where: { id: { in: ids }, ...where }, select })`.
 *
 * Splits `ids` into batches of at most {@link ID_IN_LIST_CHUNK_SIZE}, issues
 * one `findMany` per batch (merging the caller's extra `where` fields into
 * each), and merges the results back into a single deduped array — keyed by
 * `id`, so a duplicate id present in more than one input position (already
 * deduped here anyway) or returned by more than one batch cannot appear
 * twice. Preserves the caller's typed `select`, so the return type is exactly
 * what a single un-chunked `findMany` with that `select` would have produced.
 */
export async function findNovelSourceItemsByIds<Select extends Prisma.NovelSourceItemSelect>(
  db: NovelSourceItemDb | PrismaClient | Prisma.TransactionClient,
  ids: readonly string[],
  options: {
    readonly select: Select;
    readonly where?: Omit<Prisma.NovelSourceItemWhereInput, "id">;
  },
): Promise<Array<Prisma.NovelSourceItemGetPayload<{ select: Select }>>> {
  type Row = Prisma.NovelSourceItemGetPayload<{ select: Select }>;

  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return [];

  const byId = new Map<string, Row>();
  for (const chunk of chunkIds(uniqueIds)) {
    const rows = (await db.novelSourceItem.findMany({
      where: { ...options.where, id: { in: chunk } },
      select: options.select,
    })) as Row[];
    for (const row of rows) {
      byId.set((row as unknown as { id: string }).id, row);
    }
  }
  return Array.from(byId.values());
}
