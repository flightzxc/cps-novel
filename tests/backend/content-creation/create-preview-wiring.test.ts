import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/server/content-creation/preview-enqueue", () => ({
  enqueueContentCreationPreview: enqueue,
}));

const { materializeNovelFromSourceItem } = await import("@/server/content-creation/service");
const { FakeContentCreationDb } = await import("./fake-db");

beforeEach(() => {
  enqueue.mockReset();
  enqueue.mockResolvedValue({ queued: true, status: "duplicate", taskId: "stable-task" });
});

describe("materializeNovelFromSourceItem preview wiring", () => {
  it("materialization and an idempotent repeat never enqueue previews", async () => {
    const fake = new FakeContentCreationDb();
    const source = fake.seedSourceItem({ title: "Preview after create" });
    const input = {
      novelSourceItemId: source.id,
      mode: "apply" as const,
      actor: { type: "admin" as const, adminId: "admin-1" },
      requestId: "request-1",
    };

    const created = await materializeNovelFromSourceItem(fake.asPrismaClient(), input);
    expect(created).toMatchObject({ outcome: "created" });
    expect(created).not.toHaveProperty("previewEnqueue");
    expect(enqueue).not.toHaveBeenCalled();

    const repeated = await materializeNovelFromSourceItem(fake.asPrismaClient(), { ...input, requestId: "request-2" });
    expect(repeated.outcome).toBe("already_exists");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
