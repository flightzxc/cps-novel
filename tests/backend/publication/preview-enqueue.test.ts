import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { enqueuePublicationPreviews } from "@/server/publication/preview-enqueue";
import { dispatchPublicationPreviews } from "@/server/publication/dispatcher";
const enqueue = vi.hoisted(() => vi.fn(async () => ({ status: "enqueued", taskId: "task" })));
vi.mock("@/lib/tasks/moboreader", () => ({ enqueueMoboreaderPreviewRefreshTask: enqueue }));
const row = (novelId: string, account: string, app: string) => ({ id: randomUUID(), novelId, promoLink: { status: "fetched", webUrl: "https://example.test", appUrl: null, deletedAt: null, channelAccountId: account, channelAppId: app, novelSourceItemId: novelId, novelSourceItem: { novelId, channelAppId: app, deletedAt: null } } });

describe("publication preview group planner", () => {
  it("groups actual PromoLinks by both account and application, deduping books", async () => {
    enqueue.mockClear();
    const rows = [row("a", "account1", "app1"), row("b", "account1", "app1"), row("b", "account1", "app1"), row("c", "account2", "app1"), row("d", "account1", "app2")];
    const db = { article: { findMany: vi.fn(async () => rows) }, $transaction: vi.fn(async (fn: (tx: object) => unknown) => fn({})) };
    const result = await enqueuePublicationPreviews(db as never, { articleIds: rows.map(r => r.id), requestId: "request", actorId: "actor" });
    expect(result.skipReasonCounts.duplicate_novel).toBe(1);
    expect(enqueue.mock.calls).toHaveLength(3);
    expect(enqueue).toHaveBeenNthCalledWith(1, {}, expect.objectContaining({ channelAccountId: "account1", channelAppId: "app1", novelSourceItemIds: ["a", "b"] }), expect.anything());
    expect(enqueue).toHaveBeenNthCalledWith(2, {}, expect.objectContaining({ channelAccountId: "account2", channelAppId: "app1", novelSourceItemIds: ["c"] }), expect.anything());
    expect(enqueue).toHaveBeenNthCalledWith(3, {}, expect.objectContaining({ channelAccountId: "account1", channelAppId: "app2", novelSourceItemIds: ["d"] }), expect.anything());
  });
  it("a failed group rolls back alone while later groups enqueue", async () => {
    enqueue.mockClear();
    const rows = [row("a", "one", "app"), row("b", "two", "app")];
    const db = { article: { findMany: async () => rows }, $transaction: vi.fn().mockRejectedValueOnce(Object.assign(new Error("do not log secret"), { code: "P2000" })).mockImplementationOnce(async (fn: (tx: object) => unknown) => fn({})) };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await enqueuePublicationPreviews(db as never, { articleIds: rows.map(r => r.id), requestId: "request", actorId: "actor" })).toMatchObject({ skipReasonCounts: { enqueue_failed: 1 }, groups: [{ channelAccountId: "two" }] });
      expect(JSON.stringify(log.mock.calls)).not.toContain("do not log secret");
    } finally { log.mockRestore(); }
  });
  it("planner SQL errors never escape the post-commit dispatcher", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatchPublicationPreviews({ articleIds: ["a"], requestId: "request", actorId: "actor" }, { article: { findMany: async () => { throw new Error("read down"); } } } as never)).toBeUndefined();
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
