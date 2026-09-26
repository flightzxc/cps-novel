import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { normalizeTaggingNovelIds } from "@/lib/tagging/novel-id-scope";
import { readNovelClassificationSnapshots } from "@/server/tagging/auto-classification";
import { createTaggingAutoClassifyTask, initializeNovelTagSnapshot } from "@/server/tagging/tasks";
const ids = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
describe("bounded novel ID scope", () => {
  it("accepts 5000, rejects 5001 before DB access, validates and canonicalizes IDs", async () => {
    expect(normalizeTaggingNovelIds(ids.slice(0, 5000))).toHaveLength(5000);
    expect(() => normalizeTaggingNovelIds(ids)).toThrow(/5000/);
    expect(() => normalizeTaggingNovelIds(["bad"])).toThrow(/UUID/);
    expect(normalizeTaggingNovelIds([ids[1], ids[0], ids[1]])).toEqual(ids.slice(0, 2));
    await expect(createTaggingAutoClassifyTask({ db: {} as PrismaClient, scope: { kind: "novels", novelIds: ids }, lifecycle: "initialize_missing", requestId: "limit" })).rejects.toThrow(/5000/);
  });
  it("empty selection does not read; explicit selection never becomes locale/all", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { novel: { findMany } } as unknown as PrismaClient;
    expect(await readNovelClassificationSnapshots(db, { novelIds: [] })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    await readNovelClassificationSnapshots(db, { novelIds: ids.slice(0, 5000) });
    expect(findMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: { deletedAt: null, id: { in: ids.slice(0, 5000) } } }));
  });
  it("direct first initialization checks gates before reading a snapshot", async () => {
    const findFirst = vi.fn(() => { throw new Error("must not query"); });
    const db = { novel: { findFirst } } as unknown as PrismaClient;
    await expect(initializeNovelTagSnapshot(ids[0], { db, env: { NODE_ENV: "test" } })).resolves.toMatchObject({ status: "skipped" });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
