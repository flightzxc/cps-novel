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
const workerEnabledEnv: NodeJS.ProcessEnv = {
  ...enabledEnv,
  SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true",
};
const input = { reason: "article_first_publish", triggeredBy: "publish-gate" };

function transactionDb(activeId?: string, activeStatus: "pending" | "processing" = "pending") {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    genericTask: {
      findFirst: vi.fn().mockResolvedValue(activeId ? { id: activeId, status: activeStatus } : null),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  return tx;
}

/** B-38：这些既有用例关心的是站点地图本身；兜底对账用无操作替身，免得对 `{}` 假库真去跑一遍再刷出错误日志。 */
const noReconcile = vi.fn().mockResolvedValue({ inserted: 0, updated: 0, deleted: 0 });

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
  delete process.env.SITEMAP_AUTO_REFRESH_ALLOW_WRITE;
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

  it("coalesces a pending global task without requesting a follow-up", async () => {
    const tx = transactionDb("active-task");
    process.env.FEATURE_SITEMAP_AUTO_REFRESH = "true";
    await expect(enqueueSitemapRefreshForPublication(input, tx as never))
      .resolves.toEqual({ status: "coalesced", taskId: "active-task" });
    expect(tx.genericTask.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("marks a processing task once for a later refresh, even after repeated triggers", async () => {
    const tx = transactionDb("active-task", "processing");
    const results = await Promise.all([1, 2, 3].map(() =>
      enqueueSitemapRefresh(input, tx as never, { env: enabledEnv })));
    expect(results).toEqual(Array(3).fill({ status: "coalesced", taskId: "active-task" }));
    expect(tx.genericTask.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
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

  it("keeps filesystem generation off while the independent Worker write gate is closed", async () => {
    const refresh = vi.fn();
    const outcome = await createSitemapRefreshHandler({} as never, {
      reconcileEffectiveTags: noReconcile,
      buildFamily: vi.fn(),
      env: enabledEnv,
      refresh,
    })(context());

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "write_disabled",
        message: "Sitemap refresh worker write gate is disabled",
      },
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns manifest, runId, and urlCount on success", async () => {
    const refresh = vi.fn().mockResolvedValue({
      ok: true,
      status: "success",
      message: "ok",
      state: state({ status: "success", runId: manifest.runId, manifest }, manifest),
    });
    const outcome = await createSitemapRefreshHandler({} as never, {
      reconcileEffectiveTags: noReconcile,
      buildFamily: vi.fn(),
      env: workerEnabledEnv,
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
      reconcileEffectiveTags: noReconcile,
      buildFamily: vi.fn(),
      env: workerEnabledEnv,
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
      reconcileEffectiveTags: noReconcile,
      buildFamily: vi.fn(),
      env: workerEnabledEnv,
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
      reconcileEffectiveTags: noReconcile,
      buildFamily: vi.fn(),
      env: workerEnabledEnv,
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
      reconcileEffectiveTags: noReconcile,
      buildFamily: vi.fn(),
      env: workerEnabledEnv,
      refresh,
    })(context());
    expect(outcome).toEqual({
      status: "failed",
      result: { runId: "failed-run" },
      error: { code: "sitemap_refresh_failed", message: "render failed" },
    });
  });

  it("registers sitemap_refresh as a GenericTask handler", () => {
    const registry = createSitemapRefreshWorkerHandlers({} as never, { buildFamily: vi.fn(), reconcileEffectiveTags: noReconcile });
    expect(registry[SITEMAP_REFRESH_TASK_TYPE]).toMatchObject({ family: "generic", maxAttempts: 3 });
    expect(createWorkerHandlers({} as never)[SITEMAP_REFRESH_TASK_TYPE])
      .toMatchObject({ family: "generic", maxAttempts: 3 });
  });
});

describe("Sitemap refresh worker handler · B-38 构建前兜底对账分类归属表", () => {
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
    sitemapFiles: ["sitemap/site_mainpage_en.xml"],
  };
  const success = {
    ok: true,
    status: "success" as const,
    message: "ok",
    state: state({ status: "success", runId: manifest.runId, manifest }, manifest),
  };
  const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it("先对账、后构建：对账在 refresh（站点地图生成）之前，且用的是 worker 自己的 db", async () => {
    const order: string[] = [];
    const db = { marker: "worker-db" };
    const reconcile = vi.fn(async (received: unknown) => {
      order.push("reconcile");
      expect(received).toBe(db);
      return { inserted: 0, updated: 0, deleted: 0 };
    });
    const refresh = vi.fn(async () => { order.push("refresh"); return success; });
    const outcome = await createSitemapRefreshHandler(db as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh, reconcileEffectiveTags: reconcile, reconcileLog: quietLog(),
    })(context());
    expect(order).toEqual(["reconcile", "refresh"]);
    expect(outcome.status).toBe("success");
  });

  it("稳定状态 0/0/0 → 一行 info 结构化日志，含 inserted/updated/deleted/ms", async () => {
    const log = quietLog();
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh: vi.fn().mockResolvedValue(success),
      reconcileEffectiveTags: vi.fn().mockResolvedValue({ inserted: 0, updated: 0, deleted: 0 }), reconcileLog: log,
    })(context());
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    const event = JSON.parse(log.info.mock.calls[0]![0] as string);
    expect(event).toMatchObject({ schemaVersion: 1, event: "effective_tag_reconcile", level: "info", inserted: 0, updated: 0, deleted: 0 });
    expect(Number.isInteger(event.ms) && event.ms >= 0).toBe(true);
  });

  it("对账改了行 → 升级成 warn（提示有漏掉的写入点或发生过并发），计数照实记录", async () => {
    const log = quietLog();
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh: vi.fn().mockResolvedValue(success),
      reconcileEffectiveTags: vi.fn().mockResolvedValue({ inserted: 2, updated: 0, deleted: 1 }), reconcileLog: log,
    })(context());
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.warn.mock.calls[0]![0] as string)).toMatchObject({
      event: "effective_tag_reconcile", level: "warn", inserted: 2, updated: 0, deleted: 1,
    });
  });

  it("对账抛错 → 只记错误日志，站点地图照常构建并成功，不中断", async () => {
    const log = quietLog();
    const refresh = vi.fn().mockResolvedValue(success);
    const outcome = await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh,
      reconcileEffectiveTags: vi.fn().mockRejectedValue(new Error("deadlock detected")), reconcileLog: log,
    })(context());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "success", result: { urlCount: 42 } });
    expect(log.error).toHaveBeenCalledTimes(1);
    const event = JSON.parse(log.error.mock.calls[0]![0] as string);
    expect(event).toMatchObject({ schemaVersion: 1, event: "effective_tag_reconcile_failed", level: "error" });
    expect(event.error.message).toContain("deadlock detected");
  });

  it("功能开关 / 写闸关闭时一律不对账（没有任何写入）", async () => {
    const reconcile = vi.fn();
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: enabledEnv, refresh: vi.fn(), reconcileEffectiveTags: reconcile,
    })(context());
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: {} as NodeJS.ProcessEnv, refresh: vi.fn(), reconcileEffectiveTags: reconcile,
    })(context());
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("每次任务执行只对账一次（即使遇到过期文件锁、重试一次生成）", async () => {
    const now = new Date("2026-08-18T01:00:00.000Z");
    const refresh = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: "running", message: "running",
        state: state({ status: "running", runId: "stale-run", startedAt: new Date(now.valueOf() - SITEMAP_FILE_LOCK_STALE_MS - 1).toISOString() }),
      })
      .mockResolvedValueOnce(success);
    const reconcile = vi.fn().mockResolvedValue({ inserted: 0, updated: 0, deleted: 0 });
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh, releaseLock: vi.fn().mockResolvedValue(undefined),
      now: () => now, rootDir: "/tmp/sitemaps", reconcileEffectiveTags: reconcile, reconcileLog: quietLog(),
    })(context());
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("生产默认走真实对账：没有注入替身时，处理器在 worker 的 db 上开事务、先拿独占咨询锁、再比对写入", async () => {
    const seen: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async (statement: { sql: string }) => {
        seen.push(statement.sql.includes("pg_advisory_xact_lock(") ? "lock_exclusive" : statement.sql.includes("INSERT INTO novel_effective_tag") ? "apply" : "other");
        return statement.sql.includes("INSERT INTO novel_effective_tag") ? [{ inserted: 0, updated: 0, deleted: 0 }] : [];
      }),
    };
    const db = { $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)) };
    const log = quietLog();
    const refresh = vi.fn(async () => { seen.push("refresh"); return success; });
    await createSitemapRefreshHandler(db as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh, reconcileLog: log,
    })(context());
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["lock_exclusive", "apply", "refresh"]);
    expect(JSON.parse(log.info.mock.calls[0]![0] as string)).toMatchObject({ event: "effective_tag_reconcile", inserted: 0 });
  });
});
