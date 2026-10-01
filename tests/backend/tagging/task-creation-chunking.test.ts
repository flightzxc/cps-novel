import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { createFrozenTagClassifierConfig } from "@/lib/tagging/classifier-config";
import { CANONICAL_TAG_V1_SHA256, validateKeywordRuleArtifact } from "@/lib/tagging/keyword-artifact";
import { fingerprint } from "@/lib/tagging/stable-json";
import { TAGGING_NOVEL_IDS_MAX } from "@/lib/tagging/novel-id-scope";
import {
  iterateNovelClassificationSnapshotPages,
  readNovelClassificationSnapshots,
} from "@/server/tagging/auto-classification";
import {
  createTaggingAutoClassifyTask,
  TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE,
  TAGGING_TASK_READ_PAGE_SIZE,
} from "@/server/tagging/tasks";

// B-21: creating a locale task must never hold the whole locale in memory.
// These are the call-shape guarantees that keep the measured peak low
// (scripts/measure-tagging-task-creation-memory.ts proves the number itself):
//   - the read is keyset-paged in TAGGING_TASK_READ_PAGE_SIZE pages;
//   - the task row is inserted WITHOUT a nested all-items createMany;
//   - items go in through genericTaskItem.createMany, never more than
//     TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE rows per statement;
//   - everything is still one transaction, task row first, audit row last.

const env = { NODE_ENV: "test" as const, FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES" };
const artifact = validateKeywordRuleArtifact({
  schemaVersion: 1, taxonomyVersion: "v1", taxonomySha256: CANONICAL_TAG_V1_SHA256, keywordLexiconVersion: "fixture-v1",
  tags: [{
    canonicalTagId: "00000000-0000-4000-8000-0000000000aa", stableId: "ct-v1-a", textSelectionPriority: 0,
    keywords: [{ keywordId: "kw", value: "x", scriptBuckets: ["latin"], matchMode: "unicode_word", riskFlags: [] }],
  }],
});
const config = createFrozenTagClassifierConfig({ version: "fixture-v1", titleWeight: 30, descriptionWeight: 20, threshold: 20, maxTextTags: 3 });
const dependencies = { config, artifact, enforceCanonicalV1: false };

type NovelRow = {
  id: string; title: string; description: string; locale: string;
  tagState: { mode: string; currentAutoRunId: string | null } | null; sourceItems: never[];
};

function rowsOf(count: number, tagState: (index: number) => NovelRow["tagState"] = () => null): NovelRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    title: `novel-${index}`, description: `description-${index}`, locale: "en", tagState: tagState(index), sourceItems: [],
  }));
}

function fakeNovelPage(rows: readonly NovelRow[]) {
  return vi.fn(({ where, take }: { where: { id?: { gt?: string } }; take: number }) => {
    const cursor = where.id?.gt;
    const start = cursor === undefined ? 0 : rows.findIndex((row) => row.id === cursor) + 1;
    return Promise.resolve(rows.slice(start, start + take));
  });
}

function harness(rows: readonly NovelRow[], overrides: { itemCreateMany?: ReturnType<typeof vi.fn>; taskCreate?: ReturnType<typeof vi.fn>; findUnique?: ReturnType<typeof vi.fn> } = {}) {
  const calls: string[] = [];
  const findMany = fakeNovelPage(rows);
  const taskCreate = overrides.taskCreate ?? vi.fn(async () => { calls.push("task"); return {}; });
  const itemCreateMany = overrides.itemCreateMany ?? vi.fn(async ({ data }: { data: unknown[] }) => { calls.push(`items:${data.length}`); return { count: data.length }; });
  const auditCreate = vi.fn(async () => { calls.push("audit"); return {}; });
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    calls.push("begin");
    await fn({ genericTask: { create: taskCreate }, genericTaskItem: { createMany: itemCreateMany }, operationAudit: { create: auditCreate } });
    calls.push("commit");
  });
  const db = {
    novel: { findMany },
    genericTask: { findUnique: overrides.findUnique ?? vi.fn().mockResolvedValue(null) },
    $transaction,
  } as unknown as PrismaClient;
  return { db, findMany, taskCreate, itemCreateMany, auditCreate, $transaction, calls };
}

const create = (db: PrismaClient, lifecycle: "initialize_missing" | "reclassify_existing", requestId = "req") => createTaggingAutoClassifyTask({
  db, env, lifecycle, mode: "apply", scope: { kind: "locale", locale: "en" }, requestId, dependencies,
});

describe("B-21 bounded task creation", () => {
  it("pages the read, inserts the task row without nested items, and writes items in bounded chunks in one transaction", async () => {
    const total = 2 * TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE + 350;
    const rows = rowsOf(total);
    const h = harness(rows);
    const result = await create(h.db, "reclassify_existing");

    expect(result).toMatchObject({ status: "enqueued", eligibleCount: total });
    // keyset pages of the task-creation size, never the 5,000 hard cap
    expect(h.findMany.mock.calls.map(([args]) => args.take)).toEqual(Array(Math.ceil(total / TAGGING_TASK_READ_PAGE_SIZE)).fill(TAGGING_TASK_READ_PAGE_SIZE));
    // task row: one insert, no nested items
    expect(h.taskCreate).toHaveBeenCalledTimes(1);
    const taskData = (h.taskCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(taskData).not.toHaveProperty("items");
    expect(taskData).toMatchObject({ totalCount: total, status: "pending", mode: "apply" });
    // items: every statement bounded, no statement carries the whole set
    const sizes = h.itemCreateMany.mock.calls.map(([args]) => (args as { data: unknown[] }).data.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE);
    expect(Math.max(...sizes)).toBeLessThan(total);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(total);
    expect(sizes).toEqual([TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE, TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE, 350]);
    // one transaction, task first, audit last, all before commit
    expect(h.$transaction).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual(["begin", "task", `items:${TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE}`, `items:${TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE}`, "items:350", "audit", "commit"]);
  });

  it("item rows carry the payload fields and keep the novel-id order the idempotency fingerprints depend on", async () => {
    const rows = rowsOf(1500);
    const h = harness(rows);
    await create(h.db, "initialize_missing");
    const items = h.itemCreateMany.mock.calls.flatMap(([args]) => (args as { data: Array<{ id: string; taskId: string; targetType: string; targetId: string; payload: Record<string, unknown> }> }).data);
    const taskId = (h.taskCreate.mock.calls[0]![0] as { data: { id: string } }).data.id;
    expect(items.map((item) => item.targetId)).toEqual(rows.map((row) => row.id));
    for (const item of items) {
      expect(item.taskId).toBe(taskId);
      expect(item.targetType).toBe("Novel");
      expect(item.payload).toMatchObject({
        schemaVersion: 1, lifecycle: "initialize_missing", novelId: item.targetId,
        classifierConfigVersion: config.version, classifierConfigFingerprint: config.fingerprint,
        keywordFingerprint: artifact.keywordFingerprint, taxonomySha256: artifact.taxonomySha256,
      });
      expect(item.payload.classificationRequestId).toBe(fingerprint({ taskItemId: item.id, novelId: item.targetId }));
    }
    const taskParams = (h.taskCreate.mock.calls[0]![0] as { data: { operationScopeHash: string; params: { payloadFingerprint: string } } }).data;
    expect(taskParams.operationScopeHash).toBe(fingerprint({ lifecycle: "initialize_missing", novelIds: rows.map((row) => row.id) }));
    expect(taskParams.params.payloadFingerprint).toBe(fingerprint({
      schemaVersion: 1, lifecycle: "initialize_missing", mode: "apply", scope: { kind: "locale", locale: "en" },
      authority: {
        taxonomyVersion: artifact.taxonomyVersion, taxonomySha256: artifact.taxonomySha256,
        keywordLexiconVersion: artifact.keywordLexiconVersion, keywordFingerprint: artifact.keywordFingerprint,
        classifierConfigVersion: config.version, classifierConfigFingerprint: config.fingerprint,
      },
      novelIds: rows.map((row) => row.id),
    }));
  });

  it("covers both lifecycles: manual novels never qualify; initialized novels only qualify for reclassify_existing", async () => {
    const rows = rowsOf(10, (index) => (
      index % 5 === 0 ? { mode: "manual", currentAutoRunId: null }
        : index % 5 === 1 ? { mode: "automatic", currentAutoRunId: "00000000-0000-4000-8000-00000000ffff" }
          : index % 5 === 2 ? { mode: "automatic", currentAutoRunId: null }
            : null
    ));
    const initialize = harness(rows);
    const reclassify = harness(rows);
    expect(await create(initialize.db, "initialize_missing")).toMatchObject({ status: "enqueued", eligibleCount: 6 });
    expect(await create(reclassify.db, "reclassify_existing")).toMatchObject({ status: "enqueued", eligibleCount: 8 });
    const ids = (h: ReturnType<typeof harness>) => h.itemCreateMany.mock.calls.flatMap(([args]) => (args as { data: Array<{ targetId: string }> }).data.map((item) => item.targetId));
    expect(ids(initialize)).toEqual(rows.filter((_, i) => i % 5 === 2 || i % 5 === 3 || i % 5 === 4).map((row) => row.id));
    expect(ids(reclassify)).toEqual(rows.filter((_, i) => i % 5 !== 0).map((row) => row.id));
  });

  it("returns no_eligible_novels without opening a transaction", async () => {
    const h = harness(rowsOf(3, () => ({ mode: "manual", currentAutoRunId: null })));
    expect(await create(h.db, "reclassify_existing")).toEqual({ status: "no_eligible_novels", eligibleCount: 0 });
    expect(h.$transaction).not.toHaveBeenCalled();
  });

  it("an item-chunk failure propagates (the real transaction rolls back); only a unique violation on the task row is a duplicate", async () => {
    const failing = vi.fn()
      .mockResolvedValueOnce({ count: TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE })
      .mockRejectedValueOnce(new Error("second chunk failed"));
    const h = harness(rowsOf(2500), { itemCreateMany: failing });
    await expect(create(h.db, "reclassify_existing")).rejects.toThrow("second chunk failed");
    expect(h.auditCreate).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("commit");

    // task-row unique violation (replay / concurrent same requestToken) is checked
    // BEFORE any item is written, exactly as the old nested create behaved.
    const unique = new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
    const prior = { id: "prior-task", totalCount: 2500, params: {} };
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockImplementationOnce(async () => ({ ...prior, params: { requestFingerprint: capturedFingerprint } }));
    let capturedFingerprint = "";
    const taskCreate = vi.fn(async ({ data }: { data: { params: { requestFingerprint: string } } }) => { capturedFingerprint = data.params.requestFingerprint; throw unique; });
    const raced = harness(rowsOf(2500), { taskCreate, findUnique });
    expect(await create(raced.db, "reclassify_existing")).toEqual({ status: "duplicate", taskId: "prior-task", eligibleCount: 2500 });
    expect(raced.itemCreateMany).not.toHaveBeenCalled();
    expect(raced.auditCreate).not.toHaveBeenCalled();
  });
});

describe("B-21 paged snapshot reader", () => {
  it("yields bounded pages whose concatenation is exactly readNovelClassificationSnapshots", async () => {
    const rows = rowsOf(2600);
    const db = { novel: { findMany: fakeNovelPage(rows) } } as unknown as PrismaClient;
    const pages: string[][] = [];
    for await (const page of iterateNovelClassificationSnapshotPages(db, { locale: "en" }, { pageSize: 1000 })) pages.push(page.map((s) => s.novelId));
    expect(pages.map((page) => page.length)).toEqual([1000, 1000, 600]);
    const all = await readNovelClassificationSnapshots({ novel: { findMany: fakeNovelPage(rows) } } as unknown as PrismaClient, { locale: "en" });
    expect(pages.flat()).toEqual(all.map((s) => s.novelId));
  });

  it("rejects page sizes outside 1..5000 and keeps a bound selection to a single page", async () => {
    const db = { novel: { findMany: vi.fn().mockResolvedValue(rowsOf(3)) } } as unknown as PrismaClient;
    for (const pageSize of [0, -1, 1.5, TAGGING_NOVEL_IDS_MAX + 1]) {
      await expect(async () => {
        let drained = 0;
        for await (const page of iterateNovelClassificationSnapshotPages(db, { locale: "en" }, { pageSize })) drained += page.length;
        return drained;
      }).rejects.toThrow(/pageSize/);
    }
    const pages: number[] = [];
    for await (const page of iterateNovelClassificationSnapshotPages(db, { novelIds: rowsOf(3).map((row) => row.id) }, { pageSize: 1 })) pages.push(page.length);
    expect(pages).toEqual([3]);
  });
});
