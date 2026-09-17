import { describe, expect, it, vi } from "vitest";

import { chunkIds, findNovelSourceItemsByIds, ID_IN_LIST_CHUNK_SIZE } from "@/lib/db/chunked-id-lookup";

describe("chunkIds", () => {
  it("splits into batches of the given size, with the last batch possibly smaller", () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns [] for an empty array", () => {
    expect(chunkIds([], 5)).toEqual([]);
  });

  it("returns a single batch when the array is not larger than the size", () => {
    expect(chunkIds(["a", "b"], 5)).toEqual([["a", "b"]]);
  });

  it("defaults to ID_IN_LIST_CHUNK_SIZE", () => {
    const ids = Array.from({ length: ID_IN_LIST_CHUNK_SIZE + 1 }, (_, i) => i);
    const batches = chunkIds(ids);
    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBe(ID_IN_LIST_CHUNK_SIZE);
    expect(batches[1]!.length).toBe(1);
  });
});

/**
 * C-15 (施工工单_C15_终态扫描绑定变量溢出_2026-09-07.md): the real incident
 * this helper exists to fix -- a single unbounded `id: { in: ids } }`
 * `findMany` blowing Postgres's 32,767-bind-variable cap once the id list
 * crossed it (96,660 in the real incident). These tests exercise the
 * helper directly against a fake `novelSourceItem` delegate: 40,000 ids
 * (well past both 32,767 and `ID_IN_LIST_CHUNK_SIZE`) must be served by
 * multiple `findMany` calls, each at most `ID_IN_LIST_CHUNK_SIZE` ids, with
 * the per-chunk results merged back into one deduped array.
 */
describe("findNovelSourceItemsByIds", () => {
  it("chunks 40,000 ids into batches of at most ID_IN_LIST_CHUNK_SIZE and merges the results", async () => {
    const ids = Array.from({ length: 40_000 }, (_, i) => `id-${i}`);
    const callSizes: number[] = [];
    const findMany = vi.fn(async (args: { where: { id: { in: string[] } } }) => {
      const batch = args.where.id.in;
      callSizes.push(batch.length);
      return batch.map((id) => ({ id }));
    });
    const db = { novelSourceItem: { findMany } };

    const rows = await findNovelSourceItemsByIds(db as never, ids, { select: { id: true } });

    expect(callSizes.length).toBe(8); // ceil(40_000 / 5_000)
    for (const size of callSizes) expect(size).toBeLessThanOrEqual(ID_IN_LIST_CHUNK_SIZE);
    expect(callSizes.reduce((a, b) => a + b, 0)).toBe(40_000);
    expect(rows.length).toBe(40_000);
    expect(new Set(rows.map((r) => r.id)).size).toBe(40_000);
  });

  it("dedupes input ids before querying, issuing exactly one call for repeated ids within one chunk", async () => {
    const findMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id })));
    const db = { novelSourceItem: { findMany } };

    const rows = await findNovelSourceItemsByIds(db as never, ["a", "a", "b", "a"], { select: { id: true } });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] } }, select: { id: true } });
    expect(rows).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("merges and dedupes rows even if a row were returned by more than one chunk", async () => {
    // Pathological fake (a real Postgres `id IN (...)` per chunk cannot
    // return a foreign id) -- exists only to prove the merge keys strictly
    // by `id`, discarding an exact duplicate rather than appending it twice.
    const findMany = vi.fn(async () => [{ id: "dup", title: "first" }, { id: "dup", title: "second" }]);
    const db = { novelSourceItem: { findMany } };

    const rows = await findNovelSourceItemsByIds(db as never, ["dup"], { select: { id: true, title: true } as never });

    expect(rows).toEqual([{ id: "dup", title: "second" }]);
  });

  it("merges the caller's extra `where` fields alongside the chunked id filter", async () => {
    const findMany = vi.fn(async () => []);
    const db = { novelSourceItem: { findMany } };

    await findNovelSourceItemsByIds(db as never, ["a"], {
      select: { id: true },
      where: { channelAppId: "app-1" },
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { channelAppId: "app-1", id: { in: ["a"] } },
      select: { id: true },
    });
  });

  it("returns [] for an empty id list without querying the db", async () => {
    const findMany = vi.fn();
    const db = { novelSourceItem: { findMany } };

    const rows = await findNovelSourceItemsByIds(db as never, [], { select: { id: true } });

    expect(rows).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
