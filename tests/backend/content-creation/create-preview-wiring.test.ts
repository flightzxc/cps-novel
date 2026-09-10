import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/server/content-creation/preview-enqueue", () => ({
  enqueueContentCreationPreview: enqueue,
}));

const { createContentFromSourceItem } = await import("@/server/content-creation/service");
const { FakeContentCreationDb } = await import("./fake-db");

beforeEach(() => {
  enqueue.mockReset();
  enqueue.mockResolvedValue({ queued: true, status: "duplicate", taskId: "stable-task" });
});

describe("createContentFromSourceItem preview wiring", () => {
  it("a committed creation immediately invokes preview enqueue; an idempotent repeat does not", async () => {
    const fake = new FakeContentCreationDb();
    const source = fake.seedSourceItem({ title: "Preview after create" });
    const input = {
      novelSourceItemId: source.id,
      locale: "en" as const,
      mode: "apply" as const,
      actor: { type: "admin" as const, adminId: "admin-1" },
      requestId: "request-1",
    };

    const created = await createContentFromSourceItem(fake.asPrismaClient(), input);
    expect(created).toMatchObject({
      outcome: "created",
      previewEnqueue: { queued: true, status: "duplicate", taskId: "stable-task" },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      fake.asPrismaClient(),
      expect.objectContaining({
        novelSourceItemIds: [source.id],
        requestToken: `moboreader.preview_refresh.v1:content_create:${source.id}`,
      }),
    );

    const repeated = await createContentFromSourceItem(fake.asPrismaClient(), { ...input, requestId: "request-2" });
    expect(repeated.outcome).toBe("already_exists");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
