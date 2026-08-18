import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enqueueSitemapRefresh,
  enqueueSitemapRefreshForPublication,
  SITEMAP_REFRESH_OPERATION_SCOPE_HASH,
  SITEMAP_REFRESH_TASK_TYPE,
} from "@/lib/tasks/sitemap-refresh";
import type { SitemapRefreshState } from "@/lib/seo/sitemap-refresh-state";
import {
  createSitemapRefreshHandler,
  createSitemapRefreshWorkerHandlers,
  SITEMAP_FILE_LOCK_STALE_MS,
} from "../../../worker/handlers/sitemap-refresh";
import { createWorkerHandlers } from "../../../worker/index";

const enabledEnv: NodeJS.ProcessEnv = {
  ...process.env,
  FEATURE_SITEMAP_AUTO_REFRESH: "true",
};
const input = { reason: "article_first_publish", triggeredBy: "publish-gate" };

function transactionDb(activeId?: string) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    genericTask: {
      findFirst: vi.fn().mockResolvedValue(activeId ? { id: activeId } : null),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  return tx;
}

function state(task: SitemapRefreshState["task"], active: SitemapRefreshState["active"] = null): SitemapRefreshState {
  return {
    rootDir: "/tmp/sitemaps",
    lockPath: "/tmp/sitemaps/sitemap-generation.lock",
    statusPath: "/tmp/sitemaps/status.json",
    current: active ? { kind: "symlink", target: `releases/${active.runId}` } : { kind: "missing" },
    active,
    task,
  };
}

function context(payload: unknown = input) {
  return {
    lease: {
      family: "generic" as const,
      taskType: SITEMAP_REFRESH_TASK_TYPE,
      mode: "apply" as const,
      itemId: "10000000-0000-4000-8000-000000000001",
      taskId: "20000000-0000-4000-8000-000000000002",
      workerId: "fixture-worker",
      executionToken: "30000000-0000-4000-8000-000000000003",
      leaseEpoch: 1n,
      attemptCount: 1,
      lockedUntil: new Date("2026-08-18T01:00:00.000Z"),
      payload,
    },
    mode: "apply" as const,
    signal: new AbortController().signal,
    heartbeat: vi.fn().mockResolvedValue(true),
  };
}

afterEach(() => {
  delete process.env.FEATURE_SITEMAP_AUTO_REFRESH;
});

describe("Sitemap refresh enqueue", () => {
  it("returns disabled without writing a GenericTask", async () => {
    const tx = transactionDb();
    await expect(enqueueSitemapRefresh(input, tx as never, { env: {} as NodeJS.ProcessEnv }))
      .resolves.toEqual({ status: "disabled" });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.genericTask.create).not.toHaveBeenCalled();
  });

  it("queues one global GenericTask item under the fixed scope", async () => {
    const tx = transactionDb();
    const result = await enqueueSitemapRefresh(input, tx as never, {
      env: enabledEnv,
      requestToken: () => "sitemap-refresh:fixture",
    });

    expect(result).toMatchObject({ status: "queued" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.genericTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskType: "sitemap_refresh",
        operationScopeHash: SITEMAP_REFRESH_OPERATION_SCOPE_HASH,
        requestToken: "sitemap-refresh:fixture",
        totalCount: 1,
        items: { create: { targetType: "sitemap", targetId: "global", payload: input } },
      }),
    });
  });

  it("coalesces a pending or processing global task", async () => {
    const tx = transactionDb("active-task");
    process.env.FEATURE_SITEMAP_AUTO_REFRESH = "true";
    await expect(enqueueSitemapRefreshForPublication(input, tx as never))
      .resolves.toEqual({ status: "coalesced", taskId: "active-task" });
    expect(tx.genericTask.create).not.toHaveBeenCalled();
  });

  it("serializes concurrent PrismaClient enqueue calls into queued plus coalesced", async () => {
    let activeId: string | undefined;
    let queue = Promise.resolve();
    const tx = transactionDb();
    tx.genericTask.findFirst.mockImplementation(async () => activeId ? { id: activeId } : null);
    tx.genericTask.create.mockImplementation(async ({ data }) => { activeId = data.id; return {}; });
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => Promise<unknown>) => {
        const result = queue.then(() => callback(tx));
        queue = result.then(() => undefined, () => undefined);
        return result;
      }),
    };

    const results = await Promise.all([
      enqueueSitemapRefresh(input, prisma as never, { env: enabledEnv, requestToken: () => "token-one" }),
      enqueueSitemapRefresh(input, prisma as never, { env: enabledEnv, requestToken: () => "token-two" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["coalesced", "queued"]);
    expect(tx.genericTask.create).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("Sitemap refresh worker handler", () => {
  const manifest = {
    runId: "run-success",
    releaseName: "run-success",
    rootDir: "/tmp/sitemaps",
    releaseDir: "/tmp/sitemaps/releases/run-success",
    generatedAt: "2026-08-18T00:00:00.000Z",
    promotedAt: "2026-08-18T00:00:01.000Z",
    durationMs: 1_000,
    fileCount: 3,
    urlCount: 42,
    sitemapFiles: ["sitemap/site_mainpage_en.xml", "sitemap/site_novelpage_en.xml"],
  };

  it("returns manifest, runId, and urlCount on success", async () => {
    const refresh = vi.fn().mockResolvedValue({
      ok: true,
      status: "success",
      message: "ok",
      state: state({ status: "success", runId: manifest.runId, manifest }, manifest),
    });
    const outcome = await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(),
      refresh,
    })(context());

    expect(outcome).toMatchObject({
      status: "success",
      result: { coalesced: false, runId: "run-success", urlCount: 42, manifest },
    });
  });

  it("treats an existing valid file lock as coalesced success", async () => {
    const now = new Date("2026-08-18T00:30:00.000Z");
    const refresh = vi.fn().mockResolvedValue({
      ok: false,
      status: "running",
      message: "running",
      state: state({ status: "running", runId: "active-run", startedAt: "2026-08-18T00:20:00.000Z" }, manifest),
    });
    const releaseLock = vi.fn();
    const outcome = await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(),
      refresh,
      releaseLock,
      now: () => now,
    })(context());

    expect(outcome).toMatchObject({ status: "success", result: { coalesced: true, runId: "active-run" } });
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it("fails an unverifiable file lock instead of reporting false coalescing", async () => {
    const refresh = vi.fn().mockResolvedValue({
      ok: false,
      status: "running",
      message: "running",
      state: state({ status: "running" }, manifest),
    });
    const outcome = await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(),
      refresh,
    })(context());

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "sitemap_lock_unverifiable",
        message: "Sitemap lock exists without a verifiable active generation",
      },
    });
  });

  it("releases only the stale runId and retries once", async () => {
    const now = new Date("2026-08-18T01:00:00.000Z");
    const refresh = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: "running",
        message: "running",
        state: state({
          status: "running",
          runId: "stale-run",
          startedAt: new Date(now.valueOf() - SITEMAP_FILE_LOCK_STALE_MS - 1).toISOString(),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: "success",
        message: "ok",
        state: state({ status: "success", runId: manifest.runId, manifest }, manifest),
      });
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const outcome = await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(),
      refresh,
      releaseLock,
      now: () => now,
      rootDir: "/tmp/sitemaps",
    })(context());

    expect(releaseLock).toHaveBeenCalledWith("/tmp/sitemaps", "stale-run");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("success");
  });

  it("returns failed without replacing the old Sitemap when generation fails", async () => {
    const refresh = vi.fn().mockResolvedValue({
      ok: false,
      status: "failed",
      message: "failed",
      state: state({ status: "failed", runId: "failed-run", errorSummary: "render failed" }, manifest),
    });
    const outcome = await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(),
      refresh,
    })(context());
    expect(outcome).toEqual({
      status: "failed",
      result: { runId: "failed-run" },
      error: { code: "sitemap_refresh_failed", message: "render failed" },
    });
  });

  it("registers sitemap_refresh as a GenericTask handler", () => {
    const registry = createSitemapRefreshWorkerHandlers({} as never, { buildFamily: vi.fn() });
    expect(registry[SITEMAP_REFRESH_TASK_TYPE]).toMatchObject({ family: "generic", maxAttempts: 3 });
    expect(createWorkerHandlers({} as never)[SITEMAP_REFRESH_TASK_TYPE])
      .toMatchObject({ family: "generic", maxAttempts: 3 });
  });
});
