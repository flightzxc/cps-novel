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

/** B-38：这些既有用例关心的是站点地图本身；兜底检查 / 对账用无操作替身，免得对 `{}` 假库真去跑一遍再刷出错误日志。 */
const noReconcile = vi.fn().mockResolvedValue({ inserted: 0, updated: 0, deleted: 0 });
const cleanCheck = vi.fn().mockResolvedValue({ missing: 0, extra: 0, changed: 0, samples: [] });
const noEffectiveTagWork = { checkEffectiveTags: cleanCheck, reconcileEffectiveTags: noReconcile };

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
      ...noEffectiveTagWork,
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
      ...noEffectiveTagWork,
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
      ...noEffectiveTagWork,
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
      ...noEffectiveTagWork,
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
      ...noEffectiveTagWork,
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
      ...noEffectiveTagWork,
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
    const registry = createSitemapRefreshWorkerHandlers({} as never, { buildFamily: vi.fn(), ...noEffectiveTagWork });
    expect(registry[SITEMAP_REFRESH_TASK_TYPE]).toMatchObject({ family: "generic", maxAttempts: 3 });
    expect(createWorkerHandlers({} as never)[SITEMAP_REFRESH_TASK_TYPE])
      .toMatchObject({ family: "generic", maxAttempts: 3 });
  });
});

describe("Sitemap refresh worker handler · B-38 构建前兜底：先只读检查，有差异才对账分类归属表", () => {
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
  const clean = () => vi.fn().mockResolvedValue({ missing: 0, extra: 0, changed: 0, samples: [] });
  const drifted = (missing = 1, extra = 0, changed = 0) => vi.fn().mockResolvedValue({ missing, extra, changed, samples: [] });
  const reconciled = (inserted = 0, updated = 0, deleted = 0) => vi.fn().mockResolvedValue({ inserted, updated, deleted });

  it("先检查、后构建：检查在 refresh（站点地图生成）之前，且用的是 worker 自己的 db", async () => {
    const order: string[] = [];
    const db = { marker: "worker-db" };
    const check = vi.fn(async (received: unknown) => {
      order.push("check");
      expect(received).toBe(db);
      return { missing: 0, extra: 0, changed: 0, samples: [] };
    });
    const reconcile = reconciled();
    const refresh = vi.fn(async () => { order.push("refresh"); return success; });
    const outcome = await createSitemapRefreshHandler(db as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh, checkEffectiveTags: check, reconcileEffectiveTags: reconcile, reconcileLog: quietLog(),
    })(context());
    expect(order).toEqual(["check", "refresh"]);
    expect(outcome.status).toBe("success");
  });

  it("🔴 差异为 0（稳定状态）：不对账——也就不拿独占咨询锁，后台人工改标签不会被站点地图刷新卡住；落一行 info 检查日志", async () => {
    const log = quietLog();
    const reconcile = reconciled();
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh: vi.fn().mockResolvedValue(success),
      checkEffectiveTags: clean(), reconcileEffectiveTags: reconcile, reconcileLog: log,
    })(context());
    expect(reconcile).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    const event = JSON.parse(log.info.mock.calls[0]![0] as string);
    expect(event).toMatchObject({ schemaVersion: 1, event: "effective_tag_check", level: "info", missing: 0, extra: 0, changed: 0, reconcile: false });
    expect(Number.isInteger(event.ms) && event.ms >= 0).toBe(true);
  });

  it("有差异才对账：检查升级成 warn（说明有漏掉的写入点或发生过并发），再对账，对账结果再落一行日志", async () => {
    const log = quietLog();
    const reconcile = reconciled(2, 0, 1);
    const check = drifted(2, 1, 0);
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh: vi.fn().mockResolvedValue(success),
      checkEffectiveTags: check, reconcileEffectiveTags: reconcile, reconcileLog: log,
    })(context());
    expect(check).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.warn.mock.calls[0]![0] as string)).toMatchObject({
      event: "effective_tag_check", level: "warn", missing: 2, extra: 1, changed: 0, reconcile: true,
    });
    expect(JSON.parse(log.warn.mock.calls[1]![0] as string)).toMatchObject({
      event: "effective_tag_reconcile", level: "warn", inserted: 2, updated: 0, deleted: 1,
    });
  });

  it("三个差异计数里任何一个不为 0 都触发对账（缺失 / 多余 / 内容不同各自独立）", async () => {
    for (const [missing, extra, changed] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      const reconcile = reconciled();
      await createSitemapRefreshHandler({} as never, {
        buildFamily: vi.fn(), env: workerEnabledEnv, refresh: vi.fn().mockResolvedValue(success),
        checkEffectiveTags: drifted(missing, extra, changed), reconcileEffectiveTags: reconcile, reconcileLog: quietLog(),
      })(context());
      expect(reconcile, `${missing}/${extra}/${changed}`).toHaveBeenCalledTimes(1);
    }
  });

  it("检查发现差异而对账什么也没写（并发已经被别处修好）→ 对账那行是 info", async () => {
    const log = quietLog();
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh: vi.fn().mockResolvedValue(success),
      checkEffectiveTags: drifted(), reconcileEffectiveTags: reconciled(0, 0, 0), reconcileLog: log,
    })(context());
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.info.mock.calls[0]![0] as string)).toMatchObject({ event: "effective_tag_reconcile", level: "info", inserted: 0 });
  });

  it("检查抛错 → 只记错误日志，不去拿独占锁对账，站点地图照常构建并成功，不中断", async () => {
    const log = quietLog();
    const reconcile = reconciled();
    const refresh = vi.fn().mockResolvedValue(success);
    const outcome = await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh,
      checkEffectiveTags: vi.fn().mockRejectedValue(new Error("canceling statement due to statement timeout")),
      reconcileEffectiveTags: reconcile, reconcileLog: log,
    })(context());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "success", result: { urlCount: 42 } });
    expect(reconcile).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    const event = JSON.parse(log.error.mock.calls[0]![0] as string);
    expect(event).toMatchObject({ schemaVersion: 1, event: "effective_tag_check_failed", level: "error" });
    expect(event.error.message).toContain("statement timeout");
  });

  it("对账抛错 → 只记错误日志，站点地图照常构建并成功，不中断", async () => {
    const log = quietLog();
    const refresh = vi.fn().mockResolvedValue(success);
    const outcome = await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh,
      checkEffectiveTags: drifted(), reconcileEffectiveTags: vi.fn().mockRejectedValue(new Error("deadlock detected")), reconcileLog: log,
    })(context());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "success", result: { urlCount: 42 } });
    expect(log.error).toHaveBeenCalledTimes(1);
    const event = JSON.parse(log.error.mock.calls[0]![0] as string);
    expect(event).toMatchObject({ schemaVersion: 1, event: "effective_tag_reconcile_failed", level: "error" });
    expect(event.error.message).toContain("deadlock detected");
  });

  it("功能开关 / 写闸关闭时一律不检查也不对账（没有任何数据库访问）", async () => {
    const check = clean();
    const reconcile = reconciled();
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: enabledEnv, refresh: vi.fn(), checkEffectiveTags: check, reconcileEffectiveTags: reconcile,
    })(context());
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: {} as NodeJS.ProcessEnv, refresh: vi.fn(), checkEffectiveTags: check, reconcileEffectiveTags: reconcile,
    })(context());
    expect(check).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("每次任务执行只检查一次、至多对账一次（即使遇到过期文件锁、重试一次生成）", async () => {
    const now = new Date("2026-08-18T01:00:00.000Z");
    const refresh = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: "running", message: "running",
        state: state({ status: "running", runId: "stale-run", startedAt: new Date(now.valueOf() - SITEMAP_FILE_LOCK_STALE_MS - 1).toISOString() }),
      })
      .mockResolvedValueOnce(success);
    const check = drifted();
    const reconcile = reconciled();
    await createSitemapRefreshHandler({} as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh, releaseLock: vi.fn().mockResolvedValue(undefined),
      now: () => now, rootDir: "/tmp/sitemaps", checkEffectiveTags: check, reconcileEffectiveTags: reconcile, reconcileLog: quietLog(),
    })(context());
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("生产默认走真实检查 / 对账：差异为 0 时处理器只开一个只读事务（READ ONLY），一条写入、一把咨询锁都没有", async () => {
    const seen: string[] = [];
    const tx = {
      $executeRawUnsafe: vi.fn(async (statement: string) => { seen.push(statement); return 0; }),
      $queryRaw: vi.fn(async (statement: { sql: string }) => {
        if (statement.sql.includes("'summary'::text")) {
          seen.push("check");
          return [{ kind: "summary", novel_id: null, canonical_tag_id: null, missing: 0, extra: 0, changed: 0 }];
        }
        seen.push(statement.sql.includes("pg_advisory_xact_lock") ? "lock" : statement.sql.includes("INSERT INTO novel_effective_tag") ? "apply" : "other");
        return [];
      }),
    };
    const db = { $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)) };
    const log = quietLog();
    const refresh = vi.fn(async () => { seen.push("refresh"); return success; });
    await createSitemapRefreshHandler(db as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh, reconcileLog: log,
    })(context());
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["SET TRANSACTION READ ONLY", "check", "refresh"]);
    expect(JSON.parse(log.info.mock.calls[0]![0] as string)).toMatchObject({ event: "effective_tag_check", missing: 0, reconcile: false });
  });

  it("生产默认走真实检查 / 对账：有差异时先检查（只读）、再在新事务里先拿独占咨询锁、再比对写入", async () => {
    const seen: string[] = [];
    const makeTx = () => ({
      $executeRawUnsafe: vi.fn(async (statement: string) => { seen.push(statement); return 0; }),
      $queryRaw: vi.fn(async (statement: { sql: string }) => {
        if (statement.sql.includes("'summary'::text")) {
          seen.push("check");
          return [{ kind: "summary", novel_id: null, canonical_tag_id: null, missing: 1, extra: 0, changed: 0 }];
        }
        if (statement.sql.includes("INSERT INTO novel_effective_tag")) {
          seen.push("apply");
          return [{ inserted: 1, updated: 0, deleted: 0 }];
        }
        seen.push(statement.sql.includes("pg_advisory_xact_lock(") ? "lock_exclusive" : "other");
        return [];
      }),
    });
    const db = { $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(makeTx())) };
    const log = quietLog();
    const refresh = vi.fn(async () => { seen.push("refresh"); return success; });
    await createSitemapRefreshHandler(db as never, {
      buildFamily: vi.fn(), env: workerEnabledEnv, refresh, reconcileLog: log,
    })(context());
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["SET TRANSACTION READ ONLY", "check", "lock_exclusive", "apply", "refresh"]);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
