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
  const findManyCallSizes: number[] = [];
  return {
    novelSourceItem: {
      // Id-aware (not a fixed single-row stub) so both the existing
      // single-id tests and the C-15 40,000-id chunking test below see
      // correctly shaped results for whatever ids `findNovelSourceItemsByIds`
      // actually queries.
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        findManyCallSizes.push(args.where.id.in.length);
        return args.where.id.in.map((id) => ({ id, channelAppId: APP_ID }));
      }),
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
    __findManyCallSizes: findManyCallSizes,
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

  /**
   * C-15 (施工工单_C15_终态扫描绑定变量溢出_2026-09-07.md §二.2): this module's
   * own `id: { in: Array.from(new Set(input.novelSourceItemIds)) } }`
   * findMany had the exact same unbounded-bind-variable shape as
   * `enqueueMoboreaderPreviewRefreshTask`'s. Proves the fix -- routed through
   * `findNovelSourceItemsByIds` -- chunks a 40,000-id request into multiple
   * findMany calls instead of one, and does not throw.
   */
  it("C-15: 40,000 ids are looked up in chunks, not one unbounded findMany, and the call does not throw", async () => {
    const ids = Array.from({ length: 40_000 }, (_, i) => {
      const h = i.toString(16).padStart(30, "0").slice(-30);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`;
    });
    const db = fakeDb({ scanAccount: "recent-account" });

    await expect(enqueueContentCreationPreview(db as never, {
      novelSourceItemIds: ids,
      requestToken: "c15-40k-token",
      requestId: "req-40k",
      actorId: "admin",
    })).resolves.toMatchObject({ queued: true, status: "enqueued" });

    expect(db.__findManyCallSizes.length).toBeGreaterThan(1);
    for (const size of db.__findManyCallSizes) expect(size).toBeLessThanOrEqual(5_000);
    expect(db.__findManyCallSizes.reduce((a, b) => a + b, 0)).toBe(40_000);
    expect(taskFactory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ novelSourceItemIds: expect.arrayContaining([ids[0]]) }),
      expect.anything(),
      expect.anything(),
    );
  });
});
