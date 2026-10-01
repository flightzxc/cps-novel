import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { normalizeTaggingNovelIds, TAGGING_NOVEL_IDS_MAX } from "@/lib/tagging/novel-id-scope";
import { readNovelClassificationSnapshots } from "@/server/tagging/auto-classification";
import {
  createTaggingAutoClassifyTask,
  initializeNovelTagSnapshot,
  TAGGING_TASK_TRANSACTION_MAX_WAIT_MS,
  TAGGING_TASK_TRANSACTION_TIMEOUT_MS,
} from "@/server/tagging/tasks";
import { createFrozenTagClassifierConfig } from "@/lib/tagging/classifier-config";
import { CANONICAL_TAG_V1_SHA256, validateKeywordRuleArtifact } from "@/lib/tagging/keyword-artifact";
const ids = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

/** Builds a fake `db.novel` that answers keyset pagination exactly like Postgres would:
 * `where.id.gt` selects the resume point, `take` bounds the page, and rows are returned
 * in the same ascending-id order a real `orderBy: { id: "asc" }` query would produce. */
function fakeNovelPage(rows: ReadonlyArray<{ id: string }>) {
  return vi.fn(({ where, take }: { where: { id?: { gt?: string } }; take: number }) => {
    const cursor = where.id?.gt;
    const startIndex = cursor === undefined ? 0 : rows.findIndex((row) => row.id === cursor) + 1;
    return Promise.resolve(rows.slice(startIndex, startIndex + take));
  });
}
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
  it("locale scope pages by id in TAGGING_NOVEL_IDS_MAX-sized chunks and preserves order and set across pages", async () => {
    const total = 12_001;
    const rows = Array.from({ length: total }, (_, i) => ({
      id: `id-${String(i).padStart(6, "0")}`, title: `novel-${i}`, description: "",
      locale: "zz", tagState: null, sourceItems: [],
    }));
    const findMany = fakeNovelPage(rows);
    const db = { novel: { findMany } } as unknown as PrismaClient;
    const result = await readNovelClassificationSnapshots(db, { locale: "zz" });

    expect(findMany).toHaveBeenCalledTimes(3);
    for (const [args] of findMany.mock.calls) expect(args.take).toBeLessThanOrEqual(TAGGING_NOVEL_IDS_MAX);
    expect(findMany.mock.calls[0]![0].take).toBe(TAGGING_NOVEL_IDS_MAX);
    expect(findMany.mock.calls[0]![0].where).toEqual({ deletedAt: null, locale: "zz" });
    expect(findMany.mock.calls[1]![0].where).toEqual({ deletedAt: null, locale: "zz", id: { gt: rows[4999]!.id } });
    expect(findMany.mock.calls[2]![0].where).toEqual({ deletedAt: null, locale: "zz", id: { gt: rows[9999]!.id } });
    // Same order and same set the single-query implementation used to produce
    // (id ascending) -- payloadFingerprint idempotency depends on this order.
    expect(result.map((snapshot) => snapshot.novelId)).toEqual(rows.map((row) => row.id));
  });
  it("all scope also pages, and a bound novelId/novelIds scope still runs as one query", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `id-${i}`, title: `novel-${i}`, description: "", locale: "en", tagState: null, sourceItems: [],
    }));
    const allFindMany = fakeNovelPage(rows);
    const dbAll = { novel: { findMany: allFindMany } } as unknown as PrismaClient;
    expect((await readNovelClassificationSnapshots(dbAll, { all: true })).map((s) => s.novelId)).toEqual(rows.map((r) => r.id));
    expect(allFindMany).toHaveBeenCalledTimes(1);
    expect(allFindMany.mock.calls[0]![0].where).toEqual({ deletedAt: null });

    const boundFindMany = vi.fn().mockResolvedValue([rows[0]]);
    const dbBound = { novel: { findMany: boundFindMany } } as unknown as PrismaClient;
    await readNovelClassificationSnapshots(dbBound, { novelId: rows[0]!.id });
    expect(boundFindMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: { deletedAt: null, id: rows[0]!.id } }));
  });
  it("createTaggingAutoClassifyTask's task-creation transaction carries an explicit timeout and maxWait", async () => {
    const novelIds = [ids[0]!, ids[1]!];
    const row = (id: string) => ({ id, title: "novel", description: "", locale: "en", tagState: null, sourceItems: [] });
    const findMany = vi.fn().mockResolvedValue(novelIds.map(row));
    let capturedOptions: unknown;
    const genericTaskCreate = vi.fn().mockResolvedValue({});
    // B-21: items are no longer a nested createMany inside genericTask.create;
    // they go through genericTaskItem.createMany in bounded chunks (see
    // task-creation-chunking.test.ts for the chunk-shape assertions).
    const genericTaskItemCreateMany = vi.fn().mockResolvedValue({ count: 2 });
    const operationAuditCreate = vi.fn().mockResolvedValue({});
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>, options: unknown) => {
      capturedOptions = options;
      await fn({
        genericTask: { create: genericTaskCreate },
        genericTaskItem: { createMany: genericTaskItemCreateMany },
        operationAudit: { create: operationAuditCreate },
      });
    });
    const db = {
      novel: { findMany },
      genericTask: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction,
    } as unknown as PrismaClient;
    const artifact = validateKeywordRuleArtifact({
      schemaVersion: 1, taxonomyVersion: "v1", taxonomySha256: CANONICAL_TAG_V1_SHA256, keywordLexiconVersion: "fixture-v1",
      tags: [{ canonicalTagId: ids[0]!, stableId: "ct-v1-a", textSelectionPriority: 0, keywords: [{ keywordId: "kw", value: "x", scriptBuckets: ["latin"], matchMode: "unicode_word", riskFlags: [] }] }],
    });
    const config = createFrozenTagClassifierConfig({ version: "fixture-v1", titleWeight: 30, descriptionWeight: 20, threshold: 20, maxTextTags: 3 });
    const env = { NODE_ENV: "test" as const, FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES" };
    const result = await createTaggingAutoClassifyTask({
      db, env, lifecycle: "initialize_missing", mode: "apply",
      scope: { kind: "novels", novelIds }, requestId: "transaction-timeout-case",
      dependencies: { config, artifact, enforceCanonicalV1: false },
    });
    expect(result).toMatchObject({ status: "enqueued", eligibleCount: 2 });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(genericTaskCreate).toHaveBeenCalledTimes(1);
    expect(genericTaskItemCreateMany).toHaveBeenCalledTimes(1);
    expect(capturedOptions).toEqual({ timeout: TAGGING_TASK_TRANSACTION_TIMEOUT_MS, maxWait: TAGGING_TASK_TRANSACTION_MAX_WAIT_MS });
  });
});
