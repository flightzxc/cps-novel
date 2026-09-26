import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeCreatedNovelTags, initializeCreatedNovelBatchTags, initializeMaterializedTaskTags } from "@/server/tagging/materialization";
import { createTaggingAutoClassifyTask, initializeNovelTagSnapshot } from "@/server/tagging/tasks";

vi.mock("@/server/tagging/tasks", () => ({ createTaggingAutoClassifyTask: vi.fn(), initializeNovelTagSnapshot: vi.fn() }));
const env: NodeJS.ProcessEnv = { NODE_ENV: "test", FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES" };
const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const noDb = new Proxy({}, { get() { throw new Error("database touched before gate"); } }) as PrismaClient;
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe("post-commit materialization tagging", () => {
  it.each(["FEATURE_P2_06_5_TAGGING", "FEATURE_NOVEL_TAG_AUTO", "AUTO_WRITE_AUTHORIZED"])("%s closed: no queries or enqueue, with skip evidence", async (key) => {
    const closed = { ...env, [key]: key === "AUTO_WRITE_AUTHORIZED" ? "NO" : "false" };
    await initializeCreatedNovelTags(ids[0], { db: noDb, env: closed });
    await initializeCreatedNovelBatchTags(ids, "batch", { db: noDb, env: closed });
    await initializeMaterializedTaskTags(noDb, "task", { env: closed });
    expect(vi.mocked(createTaggingAutoClassifyTask).mock.calls.length).toBe(0);
    expect(vi.mocked(initializeNovelTagSnapshot).mock.calls.length).toBe(0);
    expect(console.info).toHaveBeenCalledTimes(2);
    expect(console.info).toHaveBeenNthCalledWith(1, "[tagging-initialize]", expect.objectContaining({ context: ids[0], reason: "tagging_gates_closed" }));
    expect(console.info).toHaveBeenNthCalledWith(2, "[tagging-initialize]", expect.objectContaining({ context: "batch", reason: "tagging_gates_closed" }));
    expect(console.error).not.toHaveBeenCalled();
  });
  it.each(["FEATURE_P2_06_5_TAGGING", "FEATURE_NOVEL_TAG_AUTO", "AUTO_WRITE_AUTHORIZED"])("%s closed: 1000 worker observations remain silent", async key => {
    const closed = { ...env, [key]: key === "AUTO_WRITE_AUTHORIZED" ? "NO" : "false" };
    for (let i = 0; i < 1000; i++) await initializeMaterializedTaskTags(noDb, `task-${i}`, { env: closed });
    expect(console.info).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(createTaggingAutoClassifyTask).not.toHaveBeenCalled();
    expect(initializeNovelTagSnapshot).not.toHaveBeenCalled();
  });
  it("segments sorted unique IDs; stable per-segment replay IDs; never a locale scope", async () => {
    await initializeCreatedNovelBatchTags([...ids].reverse(), "task-a", { db: noDb, env, segmentSize: 2 });
    const first = vi.mocked(createTaggingAutoClassifyTask).mock.calls.map(([input]) => input);
    expect(first).toHaveLength(3);
    expect(first.map((input) => input.scope)).toEqual([
      { kind: "novels", novelIds: ids.slice(0, 2) }, { kind: "novels", novelIds: ids.slice(2, 4) }, { kind: "novels", novelIds: ids.slice(4) },
    ]);
    expect(new Set(first.map((input) => input.requestId)).size).toBe(3);
    await initializeCreatedNovelBatchTags([...ids, ids[0]], "task-a", { db: noDb, env, segmentSize: 2 });
    expect(vi.mocked(createTaggingAutoClassifyTask).mock.calls.slice(3).map(([input]) => input.requestId)).toEqual(first.map((input) => input.requestId));
    expect(first.every((input) => input.lifecycle === "initialize_missing" && input.mode === "apply")).toBe(true);
  });
  it("isolates enqueue errors, continues later segments, and replays the same scope", async () => {
    vi.mocked(createTaggingAutoClassifyTask).mockRejectedValueOnce(new Error("enqueue failed"));
    await expect(initializeCreatedNovelBatchTags(ids, "task-a", { db: noDb, env, segmentSize: 2 })).resolves.toBeUndefined();
    expect(createTaggingAutoClassifyTask).toHaveBeenCalledTimes(3);
    vi.mocked(initializeNovelTagSnapshot).mockRejectedValueOnce(new Error("enqueue failed"));
    await expect(initializeCreatedNovelTags(ids[0], { db: noDb, env })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(2);
  });
  it("waits until every item is terminal, then uses only persisted created novel IDs", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce({ id: "pending-item" }).mockResolvedValue(null);
    const findMany = vi.fn().mockResolvedValue([
      { id: "item-a", result: { outcome: "created", novelId: ids[0] } },
      { id: "item-b", result: { outcome: "already_exists", novelId: ids[1] } },
      { id: "item-c", result: null },
    ]);
    const db = { genericTask: { findUnique: vi.fn().mockResolvedValue({ taskType: "novel.materialize.v1", mode: "apply" }) }, genericTaskItem: { findFirst, findMany } } as unknown as PrismaClient;
    await initializeMaterializedTaskTags(db, "task", { env });
    expect(findMany).not.toHaveBeenCalled();
    await initializeMaterializedTaskTags(db, "task", { env });
    expect(vi.mocked(createTaggingAutoClassifyTask).mock.calls[0][0].scope).toEqual({ kind: "novels", novelIds: [ids[0]] });
  });
  it("does not create empty tasks and cannot raise the hard limit", async () => {
    await initializeCreatedNovelBatchTags([], "empty", { db: noDb, env });
    await initializeCreatedNovelBatchTags(ids, "oversize", { db: noDb, env, segmentSize: 5001 });
    expect(vi.mocked(createTaggingAutoClassifyTask).mock.calls.length).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
