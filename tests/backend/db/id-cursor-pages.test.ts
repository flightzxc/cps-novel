import { describe, expect, it, vi } from "vitest";

import { loadAllByIdCursor, whereAfterId } from "@/lib/db/id-cursor-pages";

type Row = { id: string };

/** 一个按 `id` 升序、认 `after` 与 `take` 的内存替身，行为与真数据库的游标分页一致。 */
function pagedFetch(ids: readonly string[]) {
  const sorted = [...ids].sort();
  return vi.fn(async ({ take, after }: { take: number; after: string | undefined }): Promise<Row[]> => {
    const rest = after === undefined ? sorted : sorted.filter((id) => id > after);
    return rest.slice(0, take).map((id) => ({ id }));
  });
}

const ids = (count: number) => Array.from({ length: count }, (_, index) => `id-${String(index).padStart(4, "0")}`);

describe("loadAllByIdCursor", () => {
  it("returns every row in id order, passing the previous page's last id as the next cursor", async () => {
    const fetchPage = pagedFetch(ids(7));
    const rows = await loadAllByIdCursor(3, fetchPage);
    expect(rows.map((row) => row.id)).toEqual(ids(7));
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([
      { take: 3, after: undefined },
      { take: 3, after: "id-0002" },
      { take: 3, after: "id-0005" },
    ]);
  });

  it("a total that is an exact multiple of the chunk size costs one extra (empty) page and loses nothing", async () => {
    const fetchPage = pagedFetch(ids(6));
    const rows = await loadAllByIdCursor(3, fetchPage);
    expect(rows).toHaveLength(6);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[2]![0]).toEqual({ take: 3, after: "id-0005" });
  });

  it("a result smaller than one chunk is a single query with no cursor (same query shape as before chunking)", async () => {
    const fetchPage = pagedFetch(ids(2));
    expect(await loadAllByIdCursor(500, fetchPage)).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]![0]).toEqual({ take: 500, after: undefined });
  });

  it("an empty table is one empty page", async () => {
    const fetchPage = pagedFetch([]);
    expect(await loadAllByIdCursor(4, fetchPage)).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("chunk size 1 and a chunk larger than the total both return the same rows", async () => {
    const all = ids(5);
    expect((await loadAllByIdCursor(1, pagedFetch(all))).map((row) => row.id)).toEqual(all);
    expect((await loadAllByIdCursor(1_000_000, pagedFetch(all))).map((row) => row.id)).toEqual(all);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects chunk size %s instead of degrading to one-shot or looping", async (size) => {
    const fetchPage = pagedFetch(ids(3));
    await expect(loadAllByIdCursor(size, fetchPage)).rejects.toBeInstanceOf(RangeError);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("fails loudly (not an infinite loop) when fetchPage ignores the cursor", async () => {
    const stuck = vi.fn(async () => ids(4).map((id) => ({ id })));
    await expect(loadAllByIdCursor(4, stuck)).rejects.toThrow(/did not advance/);
    expect(stuck).toHaveBeenCalledTimes(2);
  });
});

describe("whereAfterId", () => {
  it("returns the very same where object for the first page", () => {
    const where = { locale: "en" };
    expect(whereAfterId(where, undefined)).toBe(where);
  });

  it("ANDs the original where with id > cursor for later pages", () => {
    const where = { locale: "en" };
    expect(whereAfterId(where, "abc")).toEqual({ AND: [where, { id: { gt: "abc" } }] });
  });
});
