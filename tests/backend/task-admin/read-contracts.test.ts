import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { isAllowedSideEffectTransition } from "@/lib/tasks/side-effect-intent";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import {
  getAdminTaskDetail,
  listAdminPromoLinks,
  listAdminTaskItems,
  listAdminTasks,
  listManualReviews,
} from "@/server/task-admin";

import { newStores, NOW, seedTaskAdmin, TASK_ID } from "./test-support";

const FORBIDDEN_KEYS = new Set([
  "executionToken",
  "params",
  "payload",
  "result",
  "error",
  "upstreamCode",
  "webUrl",
  "appUrl",
  "idempotencyKey",
  "effectKey",
  "requestSummary",
  "responseShape",
  "attemptFingerprint",
]);

function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    allKeys(nested, keys);
  }
  return keys;
}

async function readContext(pathname: string) {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  const { context } = await requireAdminRouteAccess(
    { pathname, method: "GET", sessionToken: admin.token },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW },
  );
  return context;
}

async function treeSource(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return treeSource(target);
    return entry.isFile() && /\.(?:ts|tsx|mjs)$/.test(entry.name) ? readFile(target, "utf8") : "";
  }))).join("\n");
}

describe("X9 read DTO allowlists", () => {
  it("returns only task identity/status/counts and a redacted error marker", async () => {
    const context = await readContext("/api/admin/tasks");
    const row = {
      family: "generic",
      task_id: TASK_ID,
      task_type: "promo_link.claim",
      status: "failed",
      total_count: 3,
      success_count: 1,
      failed_count: 2,
      skipped_count: 0,
      has_error: true,
      created_at: NOW,
      params: { secret: true },
      result: { secret: true },
      error: { upstreamCode: "secret" },
      channel_account_id: "secret-channel",
    };
    const db = { $queryRaw: async () => [row] } as unknown as PrismaClient;

    const result = await listAdminTasks(db, context, {}, {} as NodeJS.ProcessEnv);
    expect(result.items[0]).toEqual({
      family: "generic",
      taskId: TASK_ID,
      taskType: "promo_link.claim",
      status: "failed",
      totalCount: 3,
      successCount: 1,
      failedCount: 2,
      skippedCount: 0,
      errorSummary: "redacted",
    });
    for (const key of FORBIDDEN_KEYS) expect(allKeys(result).has(key)).toBe(false);
  });

  it.each(["channel_sync", "generic"] as const)(
    "returns a uniform lease-only item DTO for %s without item targets or raw worker state",
    async (family) => {
      const context = await readContext("/api/admin/tasks/items");
      const raw = {
        id: "60000000-0000-4000-8000-000000000001",
        taskId: TASK_ID,
        status: "failed",
        attemptCount: 4,
        leaseEpoch: 9n,
        lockedUntil: NOW,
        error: { upstreamCode: "secret-upstream", message: "secret message" },
        executionToken: "secret-token",
        payload: { secret: true },
        result: { secret: true },
        pageIndex: 5,
        novelSourceItemId: "secret-source",
        targetId: "secret-target",
      };
      const delegate = { findMany: async () => [raw] };
      const db = {
        channelSyncTaskItem: delegate,
        genericTaskItem: delegate,
      } as unknown as PrismaClient;

      const result = await listAdminTaskItems(
        db,
        context,
        { family, taskId: TASK_ID },
        {} as NodeJS.ProcessEnv,
      );
      expect(result.items[0]).toEqual({
        family,
        itemId: raw.id,
        taskId: TASK_ID,
        status: "failed",
        attemptCount: 4,
        leaseEpoch: "9",
        lockedUntil: NOW.toISOString(),
        errorSummary: "redacted",
      });
      for (const key of FORBIDDEN_KEYS) expect(allKeys(result).has(key)).toBe(false);
      expect(allKeys(result)).not.toContain("pageIndex");
      expect(allKeys(result)).not.toContain("novelSourceItemId");
      expect(allKeys(result)).not.toContain("targetId");
    },
  );

  it("returns PromoLink operational metadata but never real destinations or upstream identity", async () => {
    const context = await readContext("/api/admin/promo-links");
    const db = {
      promoLink: {
        findMany: async () => [{
          id: "70000000-0000-4000-8000-000000000001",
          novelId: "70000000-0000-4000-8000-000000000002",
          novelSourceItemId: "70000000-0000-4000-8000-000000000003",
          channelAppId: "70000000-0000-4000-8000-000000000004",
          channelAccountId: "70000000-0000-4000-8000-000000000005",
          offerType: "cps",
          origin: "upstream_existing",
          publicRedirectCode: "public-site-code",
          status: "fetched",
          errorKind: null,
          fetchedAt: NOW,
          expiresAt: null,
          lastAttemptedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
          upstreamCode: "secret-upstream-code",
          webUrl: "https://real.example/secret",
          appUrl: "secret-app://path",
          idempotencyKey: "secret-idempotency",
          rawLinks: { secret: true },
        }],
      },
    } as unknown as PrismaClient;
    const result = await listAdminPromoLinks(db, context, {}, {} as NodeJS.ProcessEnv);
    expect(result.items[0].publicRedirectCode).toBe("public-site-code");
    for (const key of FORBIDDEN_KEYS) expect(allKeys(result).has(key)).toBe(false);
    expect(allKeys(result)).not.toContain("rawLinks");
  });

  it("keeps manual-review evidence redacted and gives readback/rescan-only guidance", async () => {
    const context = await readContext("/api/admin/tasks/manual-reviews");
    const db = {
      sideEffectIntent: {
        findMany: async () => [{
          id: "20000000-0000-4000-8000-000000000001",
          operationType: "promo_link.claim_promo",
          targetType: "novel_source_item",
          targetId: "source-1",
          taskItemType: "generic",
          taskItemId: "60000000-0000-4000-8000-000000000001",
          channelAccountId: null,
          channelAppId: null,
          promoLinkId: null,
          status: "manual_review_required",
          committedAt: NOW,
          createdAt: NOW,
          effectKey: "secret-effect-key",
          idempotencyKey: "secret-idempotency",
          requestSummary: { secret: true },
          responseShape: { secret: true },
        }],
      },
    } as unknown as PrismaClient;
    const result = await listManualReviews(db, context, {}, {} as NodeJS.ProcessEnv);
    expect(result.items[0].guidance).toEqual({
      automaticReconciliation: false,
      nextActions: ["upstream_readback", "authorized_rescan"],
    });
    for (const key of FORBIDDEN_KEYS) expect(allKeys(result).has(key)).toBe(false);
  });
});

describe("X9 adjudication isolation", () => {
  it("keeps the generic worker transition graph closed out of manual_review_required", () => {
    expect(isAllowedSideEffectTransition("manual_review_required", "confirmed")).toBe(false);
    expect(isAllowedSideEffectTransition("manual_review_required", "failed")).toBe(false);
    expect(isAllowedSideEffectTransition("manual_review_required", "claim_retry_blocked")).toBe(false);
  });

  it("keeps worker, scheduler, and automatic task libraries unable to import the dedicated adjudicator", async () => {
    const sources = await Promise.all([
      treeSource(path.resolve(process.cwd(), "worker")),
      treeSource(path.resolve(process.cwd(), "scheduler")),
      treeSource(path.resolve(process.cwd(), "src/lib/tasks")),
    ]);
    const automaticSources = sources.join("\n");
    expect(automaticSources).not.toMatch(/resolveManualReview|server\/task-admin|manual_review\.resolve/);
  });

  it("contains no upstream adapter, fetch, or PromoLink reconciliation in the adjudication function", async () => {
    const service = await readFile(
      path.resolve(process.cwd(), "src/server/task-admin/service.ts"),
      "utf8",
    );
    const adjudicator = service.slice(service.indexOf("export async function resolveManualReview"));
    expect(adjudicator).toMatch(/sideEffectIntent\.updateMany/);
    expect(adjudicator).toMatch(/status: "manual_review_required"/);
    expect(adjudicator).toMatch(/operationAudit\.create/);
    expect(adjudicator).not.toMatch(/promoLink\.|fetch\(|adapter|upstream/i);
  });
});

/**
 * C-10 (Phase E rework, 2026-09-07): `stopReason` is a narrow, allowlisted
 * exception to the "never leak raw result/error" rule the tests above
 * enforce — it is derived (never a pass-through) from `result`/`error`, and
 * only ever a value from `CATALOG_SCAN_STOP_REASONS`
 * (`src/server/task-admin/service.ts`), never the raw string a handler
 * happened to write. Optional-field-only, per the work order: it must be
 * entirely *absent* (not `null`) whenever there is nothing to derive, so
 * every pre-existing `toEqual` fixture in "X9 read DTO allowlists" above
 * keeps matching without modification (already re-verified unchanged by
 * this same test run).
 */
describe("C-10 derived stop reason", () => {
  it("listAdminTasks: surfaces the task's own result.stopReason when has_error, or when status is failed/completed_with_errors", async () => {
    const context = await readContext("/api/admin/tasks");
    const rowWithReason = {
      family: "generic", task_id: TASK_ID, task_type: "catalog_scan", status: "completed_with_errors",
      total_count: 3, success_count: 1, failed_count: 2, skipped_count: 0,
      has_error: true, created_at: NOW,
      result: { stopReason: "upstream_error", terminalState: "partial_failed" },
    };
    const db1 = { $queryRaw: async () => [rowWithReason] } as unknown as PrismaClient;
    const result1 = await listAdminTasks(db1, context, {}, {} as NodeJS.ProcessEnv);
    expect(result1.items[0].stopReason).toBe("upstream_error");

    // Not an enumerated stop reason — must never pass through verbatim.
    const rowWithBogusReason = { ...rowWithReason, result: { stopReason: "not-a-real-reason<script>" } };
    const db2 = { $queryRaw: async () => [rowWithBogusReason] } as unknown as PrismaClient;
    const result2 = await listAdminTasks(db2, context, {}, {} as NodeJS.ProcessEnv);
    expect(result2.items[0]).not.toHaveProperty("stopReason");

    // C-10b: has_error: false but status: completed_with_errors — a
    // well-formed result.stopReason is now shown. This is the real defect
    // this work order fixes: a catalog_scan task that ended
    // completed_with_errors can have error IS NULL (only result.stopReason
    // records why it stopped short), and the old has_error-only gate
    // withheld it.
    const rowWithoutErrorButPartialStatus = { ...rowWithReason, has_error: false };
    const db3 = { $queryRaw: async () => [rowWithoutErrorButPartialStatus] } as unknown as PrismaClient;
    const result3 = await listAdminTasks(db3, context, {}, {} as NodeJS.ProcessEnv);
    expect(result3.items[0].stopReason).toBe("upstream_error");

    // has_error: false and status: completed — still withheld. A
    // well-formed result.stopReason on a cleanly-completed row must not
    // surface just because the JSON happens to contain one.
    const rowWithoutErrorCompleted = { ...rowWithReason, has_error: false, status: "completed" };
    const db4 = { $queryRaw: async () => [rowWithoutErrorCompleted] } as unknown as PrismaClient;
    const result4 = await listAdminTasks(db4, context, {}, {} as NodeJS.ProcessEnv);
    expect(result4.items[0]).not.toHaveProperty("stopReason");
  });

  it("listAdminTaskItems: derives the full stop-reason line only for the origin item, not a cascaded stoppedBeforeFetch item", async () => {
    const context = await readContext("/api/admin/tasks/items");
    const originRow = {
      id: "60000000-0000-4000-8000-000000000001", taskId: TASK_ID, status: "failed",
      attemptCount: 1, leaseEpoch: 5n, lockedUntil: null,
      result: { stopReason: "upstream_error", terminalState: "partial_failed" },
      error: {
        code: "upstream_error",
        message: "MoboReader catalog read failed: upstream_http_error (HTTP 401) at page 1",
        detail: { adapterCode: "upstream_http_error", httpStatus: 401, retryable: false, pageIndex: 1 },
      },
    };
    const delegateOrigin = { findMany: async () => [originRow] };
    const dbOrigin = { channelSyncTaskItem: delegateOrigin, genericTaskItem: delegateOrigin } as unknown as PrismaClient;
    const originResult = await listAdminTaskItems(dbOrigin, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);
    expect(originResult.items[0].stopReason).toBe("upstream_error (HTTP 401) @ 第 1 页");
    expect(originResult.items[0].errorSummary).toBe("redacted");
    for (const key of FORBIDDEN_KEYS) expect(allKeys(originResult).has(key)).toBe(false);

    const cascadedRow = {
      id: "60000000-0000-4000-8000-000000000002", taskId: TASK_ID, status: "failed",
      attemptCount: 0, leaseEpoch: 0n, lockedUntil: null,
      result: { stoppedBeforeFetch: true, stopReason: "upstream_error", returnedCount: 0 },
      error: { code: "upstream_error", message: "Catalog scan stopped after an upstream error" },
    };
    const delegateCascaded = { findMany: async () => [cascadedRow] };
    const dbCascaded = { channelSyncTaskItem: delegateCascaded, genericTaskItem: delegateCascaded } as unknown as PrismaClient;
    const cascadedResult = await listAdminTaskItems(dbCascaded, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);
    expect(cascadedResult.items[0]).not.toHaveProperty("stopReason");
  });

  /**
   * D-7 (Phase E rework 2, 2026-09-07): `"finalize_failed"` — written by
   * `worker/runtime/worker.ts`'s `handleFinalizeFailure` when
   * `finalizeTaskItem`'s own write transaction fails outside the handler
   * (e.g. a DB CHECK violation) — is now in `CATALOG_SCAN_STOP_REASONS`, so
   * it surfaces through this same `error.code`-driven derivation as
   * `upstream_error` does. Its `detail` shape carries no `httpStatus`/
   * `pageIndex` (only `sqlState`/`prismaCode`/`constraint`, none of which
   * this derivation reads), so the line is the bare code with neither
   * suffix — still never a raw pass-through of `detail` itself.
   */
  it("listAdminTaskItems: derives the bare 'finalize_failed' stop-reason code (D-7), with no HTTP/page suffix since that detail shape carries neither", async () => {
    const context = await readContext("/api/admin/tasks/items");
    const finalizeFailedRow = {
      id: "60000000-0000-4000-8000-000000000005", taskId: TASK_ID, status: "failed",
      attemptCount: 3, leaseEpoch: 2n, lockedUntil: null,
      result: {},
      error: {
        code: "finalize_failed",
        message: "Item finalize failed: 23514",
        detail: { sqlState: "23514", prismaCode: "P2010", constraint: "novel_source_item_metadata_check" },
      },
    };
    const delegateFinalizeFailed = { findMany: async () => [finalizeFailedRow] };
    const dbFinalizeFailed = {
      channelSyncTaskItem: delegateFinalizeFailed,
      genericTaskItem: delegateFinalizeFailed,
    } as unknown as PrismaClient;
    const finalizeFailedResult = await listAdminTaskItems(
      dbFinalizeFailed, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv,
    );
    expect(finalizeFailedResult.items[0].stopReason).toBe("finalize_failed");
    expect(finalizeFailedResult.items[0].errorSummary).toBe("redacted");
    for (const key of FORBIDDEN_KEYS) expect(allKeys(finalizeFailedResult).has(key)).toBe(false);
  });

  it("listAdminTaskItems: withholds stopReason for a non-upstream_error contract code and for a successful item", async () => {
    const context = await readContext("/api/admin/tasks/items");
    const otherCodeRow = {
      id: "60000000-0000-4000-8000-000000000003", taskId: TASK_ID, status: "failed",
      attemptCount: 1, leaseEpoch: 1n, lockedUntil: null,
      result: { stopReason: "upstream_error", terminalState: "partial_failed" },
      error: { code: "account_inactive", message: "The channel account is not active" },
    };
    const delegateOther = { findMany: async () => [otherCodeRow] };
    const dbOther = { channelSyncTaskItem: delegateOther, genericTaskItem: delegateOther } as unknown as PrismaClient;
    const otherResult = await listAdminTaskItems(dbOther, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);
    expect(otherResult.items[0]).not.toHaveProperty("stopReason");

    const successRow = {
      id: "60000000-0000-4000-8000-000000000004", taskId: TASK_ID, status: "success",
      attemptCount: 1, leaseEpoch: 1n, lockedUntil: null,
      result: { returnedCount: 20 }, error: null,
    };
    const delegateSuccess = { findMany: async () => [successRow] };
    const dbSuccess = { channelSyncTaskItem: delegateSuccess, genericTaskItem: delegateSuccess } as unknown as PrismaClient;
    const successResult = await listAdminTaskItems(dbSuccess, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);
    expect(successResult.items[0]).not.toHaveProperty("stopReason");
  });
});

/**
 * C-9 (`施工工单_C9_任务详情独立路由对齐CPS_2026-09-07.md`): `/tasks/[id]`'s
 * additive projection fields — the task-configuration summary and
 * catalog-scan audit block, both derived from `params`/`result` (never a
 * pass-through, same discipline as C-10's `stopReason` above), plus item
 * pagination and the catalog-page `pageNumber` derivation. Every field here
 * is optional-only on top of the existing `TaskSummaryDto`/`TaskItemDto`
 * contracts the "X9 read DTO allowlists" tests above pin, and `params`
 * stays on FORBIDDEN_KEYS — this file's own poisoned-row test above already
 * proves `taskSummary()` never surfaces it, and `getAdminTaskDetail`'s own
 * `params` read is exercised nowhere except through the two curated derive
 * functions below.
 */
describe("C-9 task-detail route derivations", () => {
  it("getAdminTaskDetail: derives catalogScanConfig/catalogScanAudit only for taskType catalog_scan, plus mode/channelAccountId/createdAt/updatedAt", async () => {
    const context = await readContext("/api/admin/tasks/detail");
    const row = {
      family: "generic",
      task_id: TASK_ID,
      task_type: "catalog_scan",
      status: "completed_with_errors",
      total_count: 5,
      success_count: 3,
      failed_count: 2,
      skipped_count: 0,
      has_error: true,
      created_at: NOW,
      updated_at: new Date(NOW.getTime() + 60_000),
      mode: "apply",
      channel_account_id: "40000000-0000-4000-8000-000000000001",
      params: {
        source: "manual",
        actorId: "admin-1",
        requestId: "req-c9-1",
        projectType: 7,
        pageStart: 1,
        pageEnd: 5,
        pageSize: 20,
        safetyMaxPages: 2000,
        languages: ["en", "ja", "en"],
        secret: "must-not-leak",
      },
      result: {
        stopReason: "upstream_error",
        catalogObservedTotal: 4823,
        batchActualCount: 88,
        checkpoint: { lastCompletedPage: 4, returnedCount: 20 },
      },
    };
    // Sequence-aware: family "generic" + taskType "catalog_scan" means
    // getAdminTaskDetail now also issues a second query (the origin
    // catalog_scan item lookup, C-10b) — the first call returns the task
    // row, the second the origin-item rows (none here).
    let queryCall = 0;
    const db = {
      $queryRaw: async () => {
        queryCall += 1;
        return queryCall === 1 ? [row] : [];
      },
    } as unknown as PrismaClient;

    const detail = await getAdminTaskDetail(db, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);

    expect(detail).not.toHaveProperty("originStopReason");
    expect(detail.mode).toBe("apply");
    expect(detail.channelAccountId).toBe("40000000-0000-4000-8000-000000000001");
    expect(detail.createdAt).toBe(NOW.toISOString());
    expect(detail.updatedAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(detail.catalogScanConfig).toEqual({
      pageStart: 1,
      pageEnd: 5,
      pageSize: 20,
      safetyMaxPages: 2000,
      requestId: "req-c9-1",
      source: "manual",
      // De-duplicated, never a raw pass-through of the params array.
      languages: ["en", "ja"],
    });
    expect(detail.catalogScanAudit).toEqual({
      observedTotal: 4823,
      actualFetchedCount: 88,
      lastCompletedPage: 4,
    });
    for (const key of FORBIDDEN_KEYS) expect(allKeys(detail).has(key)).toBe(false);
    expect(allKeys(detail)).not.toContain("secret");
    expect(allKeys(detail)).not.toContain("projectType");
    expect(allKeys(detail)).not.toContain("actorId");
  });

  it("getAdminTaskDetail: withholds catalogScanConfig/catalogScanAudit for a non-catalog_scan taskType even when params/result are present", async () => {
    const context = await readContext("/api/admin/tasks/detail");
    const row = {
      family: "channel_sync",
      task_id: TASK_ID,
      task_type: "moboreader.preview_refresh.v1",
      status: "completed",
      total_count: 2,
      success_count: 2,
      failed_count: 0,
      skipped_count: 0,
      has_error: false,
      created_at: NOW,
      updated_at: NOW,
      mode: "apply",
      channel_account_id: null,
      params: { pageStart: 1, pageEnd: 5, safetyMaxPages: 2000 },
      result: { catalogObservedTotal: 99, batchActualCount: 99, checkpoint: { lastCompletedPage: 5 } },
    };
    // C-10b: a channel_sync task never qualifies for the origin-item query
    // (the `family === "generic"` guard in getAdminTaskDetail excludes it
    // outright, regardless of taskType) — assert only one $queryRaw call.
    let queryCallCount = 0;
    const db = {
      $queryRaw: async () => {
        queryCallCount += 1;
        return [row];
      },
    } as unknown as PrismaClient;

    const detail = await getAdminTaskDetail(db, context, { family: "channel_sync", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);

    expect(detail).not.toHaveProperty("catalogScanConfig");
    expect(detail).not.toHaveProperty("catalogScanAudit");
    expect(detail).not.toHaveProperty("channelAccountId");
    expect(detail).not.toHaveProperty("originStopReason");
    expect(detail.mode).toBe("apply");
    expect(queryCallCount).toBe(1);
  });

  it("getAdminTaskDetail: derives originStopReason from the origin catalog_scan item's richer stop-reason line (C-10b)", async () => {
    const context = await readContext("/api/admin/tasks/detail");
    const row = {
      family: "generic",
      task_id: TASK_ID,
      task_type: "catalog_scan",
      status: "completed_with_errors",
      total_count: 5,
      success_count: 3,
      failed_count: 2,
      skipped_count: 0,
      has_error: false,
      created_at: NOW,
      updated_at: NOW,
      mode: "apply",
      channel_account_id: null,
      params: {},
      result: { stopReason: "upstream_error" },
    };
    const originItemRow = {
      status: "failed",
      result: { stopReason: "upstream_error", terminalState: "partial_failed" },
      error: {
        code: "upstream_error",
        message: "MoboReader catalog read failed: upstream_http_error (HTTP 401) at page 1",
        detail: { adapterCode: "upstream_http_error", httpStatus: 401, retryable: false, pageIndex: 1 },
      },
    };
    let queryCall = 0;
    const db = {
      $queryRaw: async () => {
        queryCall += 1;
        return queryCall === 1 ? [row] : [originItemRow];
      },
    } as unknown as PrismaClient;

    const detail = await getAdminTaskDetail(db, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);

    expect(detail.originStopReason).toBe("upstream_error (HTTP 401) @ 第 1 页");
    expect(queryCall).toBe(2);
    for (const key of FORBIDDEN_KEYS) expect(allKeys(detail).has(key)).toBe(false);
  });

  it("getAdminTaskDetail: withholds originStopReason when the only failed catalog_scan items are cascaded (stoppedBeforeFetch: true)", async () => {
    const context = await readContext("/api/admin/tasks/detail");
    const row = {
      family: "generic",
      task_id: TASK_ID,
      task_type: "catalog_scan",
      status: "completed_with_errors",
      total_count: 5,
      success_count: 3,
      failed_count: 2,
      skipped_count: 0,
      has_error: false,
      created_at: NOW,
      updated_at: NOW,
      mode: "apply",
      channel_account_id: null,
      params: {},
      result: { stopReason: "upstream_error" },
    };
    // Defense-in-depth: even if a cascaded item (result.stoppedBeforeFetch
    // === true, never attempted — persistCatalogUpstreamFailure,
    // worker/handlers/moboreader.ts) were ever returned by the origin-item
    // query (whose own SQL WHERE clause is meant to exclude it),
    // deriveItemStopReason's stoppedBeforeFetch guard still withholds it.
    const cascadedItemRow = {
      status: "failed",
      result: { stoppedBeforeFetch: true, stopReason: "upstream_error", returnedCount: 0 },
      error: { code: "upstream_error", message: "Catalog scan stopped after an upstream error" },
    };
    let queryCall = 0;
    const db = {
      $queryRaw: async () => {
        queryCall += 1;
        return queryCall === 1 ? [row] : [cascadedItemRow];
      },
    } as unknown as PrismaClient;

    const detail = await getAdminTaskDetail(db, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);

    expect(detail).not.toHaveProperty("originStopReason");
    expect(queryCall).toBe(2);
  });

  it("getAdminTaskDetail: throws task_admin_not_found when the row does not exist, so the page's per-family probe can fall through", async () => {
    const context = await readContext("/api/admin/tasks/detail");
    const db = { $queryRaw: async () => [] } as unknown as PrismaClient;
    await expect(
      getAdminTaskDetail(db, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({ code: "task_admin_not_found", status: 404 });
  });

  it("listAdminTaskItems: page/pageSize/total/totalPages are absent when `page` is not passed (byte-identical to the pre-C-9 flat-limit shape)", async () => {
    const context = await readContext("/api/admin/tasks/items");
    const row = {
      id: "60000000-0000-4000-8000-000000000001", taskId: TASK_ID, status: "success",
      attemptCount: 1, leaseEpoch: 1n, lockedUntil: null, result: { returnedCount: 20 }, error: null,
    };
    const delegate = { findMany: async () => [row] };
    const db = { channelSyncTaskItem: delegate, genericTaskItem: delegate } as unknown as PrismaClient;
    const result = await listAdminTaskItems(db, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);
    expect(result).not.toHaveProperty("page");
    expect(result).not.toHaveProperty("total");
    expect(result).not.toHaveProperty("totalPages");
  });

  it("listAdminTaskItems: with `page`, paginates via skip/take and returns page/pageSize/total/totalPages from a real count", async () => {
    const context = await readContext("/api/admin/tasks/items");
    const row = {
      id: "60000000-0000-4000-8000-000000000001", taskId: TASK_ID, status: "success",
      attemptCount: 1, leaseEpoch: 1n, lockedUntil: null, result: { returnedCount: 20 }, error: null,
      targetType: "catalog_page", targetId: "3",
    };
    const findManyArgs: unknown[] = [];
    const delegate = {
      findMany: async (args: unknown) => { findManyArgs.push(args); return [row]; },
      count: async () => 137,
    };
    const db = { channelSyncTaskItem: delegate, genericTaskItem: delegate } as unknown as PrismaClient;

    const result = await listAdminTaskItems(
      db, context, { family: "generic", taskId: TASK_ID, limit: "50", page: "3" }, {} as NodeJS.ProcessEnv,
    );

    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(50);
    expect(result.total).toBe(137);
    expect(result.totalPages).toBe(Math.ceil(137 / 50));
    expect(findManyArgs[0]).toMatchObject({ skip: 100, take: 50 });
    // The catalog-page item's page number is derived and re-validated —
    // never the raw `targetId` string under its own key.
    expect(result.items[0].pageNumber).toBe(3);
    expect(allKeys(result)).not.toContain("targetId");
  });

  it("listAdminTaskItems: derives pageNumber only for a catalog_page targetType with a positive-integer targetId", async () => {
    const context = await readContext("/api/admin/tasks/items");
    const rows = [
      { id: "a", taskId: TASK_ID, status: "success", attemptCount: 1, leaseEpoch: 1n, lockedUntil: null, result: null, error: null, targetType: "catalog_page", targetId: "12" },
      { id: "b", taskId: TASK_ID, status: "success", attemptCount: 1, leaseEpoch: 1n, lockedUntil: null, result: null, error: null, targetType: "catalog_page", targetId: "not-a-number" },
      { id: "c", taskId: TASK_ID, status: "success", attemptCount: 1, leaseEpoch: 1n, lockedUntil: null, result: null, error: null, targetType: "novel_source_item", targetId: "12" },
    ];
    const delegate = { findMany: async () => rows };
    const db = { channelSyncTaskItem: delegate, genericTaskItem: delegate } as unknown as PrismaClient;
    const result = await listAdminTaskItems(db, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);
    expect(result.items[0].pageNumber).toBe(12);
    expect(result.items[1]).not.toHaveProperty("pageNumber");
    expect(result.items[2]).not.toHaveProperty("pageNumber");
  });
});
