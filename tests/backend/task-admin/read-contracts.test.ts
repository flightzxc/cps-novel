import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { isAllowedSideEffectTransition } from "@/lib/tasks/side-effect-intent";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import {
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
  it("listAdminTasks: surfaces the task's own result.stopReason only when it is both has_error and an enumerated value", async () => {
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

    // has_error: false — even a well-formed result.stopReason is withheld.
    const rowWithoutError = { ...rowWithReason, has_error: false };
    const db3 = { $queryRaw: async () => [rowWithoutError] } as unknown as PrismaClient;
    const result3 = await listAdminTasks(db3, context, {}, {} as NodeJS.ProcessEnv);
    expect(result3.items[0]).not.toHaveProperty("stopReason");
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
