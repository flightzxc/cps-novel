import { beforeEach, describe, expect, it, vi } from "vitest";

const taskFactory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tasks/moboreader", () => ({
  enqueueMoboreaderPreviewRefreshTask: taskFactory,
  MOBOREADER_TASK_TYPES: Object.freeze({ catalogScan: "catalog_scan", previewRefresh: "moboreader.preview_refresh.v1" }),
}));

const { enqueueContentCreationPreview } = await import(
  "@/server/content-creation/preview-enqueue"
);

const SOURCE_ID = "10000000-0000-4000-8000-000000000001";
const APP_ID = "20000000-0000-4000-8000-000000000001";

function fakeDb(options: { scanAccount?: string | null; fallbackAccounts?: string[] } = {}) {
  const transaction = vi.fn(async (callback: (tx: object) => unknown) => callback({ tx: true }));
  return {
    novelSourceItem: {
      findMany: vi.fn(async () => [{ id: SOURCE_ID, channelAppId: APP_ID }]),
    },
    genericTask: {
      findFirst: vi.fn(async () => options.scanAccount === undefined
        ? { channelAccountId: "scan-account" }
        : options.scanAccount === null
          ? null
          : { channelAccountId: options.scanAccount }),
    },
    channelAccount: {
      findMany: vi.fn(async () => (options.fallbackAccounts ?? []).map((id) => ({ id }))),
    },
    $transaction: transaction,
  };
}

beforeEach(() => {
  taskFactory.mockReset();
  taskFactory.mockResolvedValue({
    status: "enqueued",
    taskId: "task-1",
    taskStatus: "pending",
    eligibleCount: 1,
    skipReasonCounts: {},
  });
});

describe("content creation -> Moboreader preview enqueue", () => {
  it("CPS post-commit semantics: prefers the most recent completed scan account and uses the frozen single-item token", async () => {
    const db = fakeDb({ scanAccount: "recent-account" });
    const result = await enqueueContentCreationPreview(db as never, {
      novelSourceItemIds: [SOURCE_ID],
      requestToken: `moboreader.preview_refresh.v1:content_create:${SOURCE_ID}`,
      requestId: "request-1",
      actorId: "admin-1",
    });

    expect(result).toMatchObject({ queued: true, status: "enqueued", taskId: "task-1" });
    expect(taskFactory).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        trigger: "auto",
        mode: "apply",
        channelAccountId: "recent-account",
        channelAppId: APP_ID,
        novelSourceItemIds: [SOURCE_ID],
        requestToken: `moboreader.preview_refresh.v1:content_create:${SOURCE_ID}`,
      }),
      expect.anything(),
      expect.any(Date),
    );
  });

  it("falls back only when exactly one active credentialed account is available", async () => {
    const unique = fakeDb({ scanAccount: null, fallbackAccounts: ["only-account"] });
    await enqueueContentCreationPreview(unique as never, {
      novelSourceItemIds: [SOURCE_ID], requestToken: "batch-token", requestId: "req", actorId: "admin",
    });
    expect(taskFactory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelAccountId: "only-account" }),
      expect.anything(),
      expect.anything(),
    );

    taskFactory.mockClear();
    const ambiguous = fakeDb({ scanAccount: null, fallbackAccounts: ["a", "b"] });
    await expect(enqueueContentCreationPreview(ambiguous as never, {
      novelSourceItemIds: [SOURCE_ID], requestToken: "batch-token", requestId: "req", actorId: "admin",
    })).resolves.toEqual({ queued: false, reason: "no_channel_account" });
    expect(taskFactory).not.toHaveBeenCalled();
  });

  it("preserves disabled and duplicate task-factory outcomes for the UI", async () => {
    const db = fakeDb();
    taskFactory.mockResolvedValueOnce({ status: "enqueued", taskId: "disabled", taskStatus: "disabled", eligibleCount: 1, skipReasonCounts: {} });
    await expect(enqueueContentCreationPreview(db as never, {
      novelSourceItemIds: [SOURCE_ID], requestToken: "token-1", requestId: "req-1", actorId: "admin",
    })).resolves.toMatchObject({ queued: true, status: "enqueued", taskStatus: "disabled" });

    taskFactory.mockResolvedValueOnce({ status: "duplicate", taskId: "existing" });
    await expect(enqueueContentCreationPreview(db as never, {
      novelSourceItemIds: [SOURCE_ID], requestToken: "token-1", requestId: "req-2", actorId: "admin",
    })).resolves.toEqual({ queued: true, status: "duplicate", taskId: "existing" });
  });
});
