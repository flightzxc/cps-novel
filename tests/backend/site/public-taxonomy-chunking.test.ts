import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  loadPublicTaxonomyByNovelIds,
  PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE,
} from "@/lib/site/public-taxonomy";

/**
 * 站点地图规模缺陷（2026-10-06）的同类排查：`loadPublicTaxonomyByNovelIds` 的原生 SQL 里同一组小说 id 会重复出现
 * 2～3 次（自动标签关 / 开），每次都各占 N 个绑定变量；Prisma 单条语句最多 32,767 个，所以一次传 1.1 万以上
 * （开自动标签）或 1.6 万以上（关）的小说 id 必然失败。站点地图的分类页对「一个语种全部公开小说」取归属，正好撞上。
 * 真实库 3 万本规模见 `tests/integration/tasks/sitemap-scale-postgres.test.ts`（mainpage 用例，自动标签关/开各一遍）。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRISMA_BIND_LIMIT = 32_767;

function fakeDb() {
  const chunks: Array<{ ids: Set<string>; boundValues: number }> = [];
  const $queryRaw = vi.fn(async (sql: Prisma.Sql) => {
    const ids = new Set(sql.values.filter((value): value is string => typeof value === "string" && UUID.test(value)));
    chunks.push({ ids, boundValues: sql.values.length });
    return [...ids].map((novelId) => ({
      novel_id: novelId, id: "tag-1", slug: "fantasy", requested_display_name: "Fantasy",
      en_display_name: "Fantasy", zh_display_name: null, sort_order: 1, updated_at: new Date("2026-08-01T00:00:00.000Z"),
    }));
  });
  return { db: { $queryRaw } as never, chunks, $queryRaw };
}

const novelIds = (count: number) => Array.from({ length: count }, () => randomUUID());

describe("loadPublicTaxonomyByNovelIds · novel id chunking", () => {
  it("one query for a list that fits one chunk (same single-query shape as before chunking)", async () => {
    const { db, chunks } = fakeDb();
    const ids = novelIds(PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE);
    const result = await loadPublicTaxonomyByNovelIds(db, ids, "en", {} as NodeJS.ProcessEnv);
    expect(chunks).toHaveLength(1);
    expect(result.size).toBe(ids.length);
  });

  it.each([
    ["FEATURE_NOVEL_TAG_AUTO off (ids bound twice)", {} as NodeJS.ProcessEnv],
    ["FEATURE_NOVEL_TAG_AUTO on (ids bound three times)", { FEATURE_NOVEL_TAG_AUTO: "true" } as unknown as NodeJS.ProcessEnv],
  ])("30,000 novel ids are split across several queries, each far below Prisma's 32,767 bind cap — %s", async (_label, env) => {
    const { db, chunks } = fakeDb();
    const ids = novelIds(30_000);
    const result = await loadPublicTaxonomyByNovelIds(db, ids, "en", env);

    expect(chunks.length).toBe(Math.ceil(30_000 / PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE));
    for (const chunk of chunks) {
      expect(chunk.ids.size).toBeLessThanOrEqual(PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE);
      // 3 次重复 + locale 等少量额外变量，仍然留出 5 倍以上余量。
      expect(chunk.boundValues * 5).toBeLessThan(PRISMA_BIND_LIMIT * 1.1);
    }
    // 每个 id 恰好出现在一个块里，合起来不多不少。
    const seen = chunks.flatMap((chunk) => [...chunk.ids]);
    expect(seen).toHaveLength(30_000);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(result.size).toBe(30_000);
    expect(result.get(ids[29_999]!)).toEqual([expect.objectContaining({ slug: "fantasy", label: "Fantasy" })]);
  });

  it("de-duplicates ids before chunking and returns an empty map without querying for an empty list", async () => {
    const { db, chunks, $queryRaw } = fakeDb();
    const ids = novelIds(10);
    expect((await loadPublicTaxonomyByNovelIds(db, [...ids, ...ids], "en", {} as NodeJS.ProcessEnv)).size).toBe(10);
    expect(chunks).toHaveLength(1);
    $queryRaw.mockClear();
    expect((await loadPublicTaxonomyByNovelIds(db, [], "en", {} as NodeJS.ProcessEnv)).size).toBe(0);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("keeps the per-novel tag order from the SQL, whichever chunk a novel lands in", async () => {
    const ids = novelIds(PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE + 1);
    const $queryRaw = vi.fn(async (sql: Prisma.Sql) => {
      const chunk = new Set(sql.values.filter((value): value is string => typeof value === "string" && UUID.test(value)));
      // 每本书两个标签，SQL 的 ORDER BY 保证 sort_order 小的在前；替身按同样顺序给出。
      return [...chunk].flatMap((novelId) => [
        { novel_id: novelId, id: "t-a", slug: "alpha", requested_display_name: "Alpha", en_display_name: null, zh_display_name: null, sort_order: 1, updated_at: new Date(0) },
        { novel_id: novelId, id: "t-b", slug: "beta", requested_display_name: "Beta", en_display_name: null, zh_display_name: null, sort_order: 2, updated_at: new Date(0) },
      ]);
    });
    const result = await loadPublicTaxonomyByNovelIds({ $queryRaw } as never, ids, "en", {} as NodeJS.ProcessEnv);
    expect($queryRaw).toHaveBeenCalledTimes(2);
    for (const id of [ids[0]!, ids[PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE]!]) {
      expect(result.get(id)!.map((tag) => tag.slug)).toEqual(["alpha", "beta"]);
    }
  });
});
