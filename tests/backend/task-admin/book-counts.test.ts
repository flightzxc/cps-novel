import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import { getAdminTaskDetail, listAdminTasks } from "@/server/task-admin";

import { newStores, NOW, seedTaskAdmin, TASK_ID } from "./test-support";

/**
 * C-12 (`施工工单_C12_目录任务计量口径改为本_2026-09-07.md`): projection
 * tests for `bookCounts` — the operator-facing "本" (book) count derived
 * from `result.catalogObservedTotal` / `params.pageSize` plus one aggregate
 * SQL query over `generic_task_item`. `$queryRaw` is mocked throughout (no
 * real Postgres in this worktree, per the work order's discipline), so
 * these tests pin the JS-side gating/derivation contract
 * (`deriveBookCounts`/`catalogBookCountsPrerequisites` in
 * `src/server/task-admin/service.ts`) — a source-text assertion below
 * separately pins the aggregate SQL's own exclusion clauses, since that SQL
 * itself cannot be executed here.
 */

async function readContext(pathname: string) {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  const { context } = await requireAdminRouteAccess(
    { pathname, method: "GET", sessionToken: admin.token },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW },
  );
  return context;
}

describe("C-12 aggregate SQL text (no live Postgres in this worktree)", () => {
  it("excludes stoppedBeforeFetch cascade pages from both pages_scanned and failed_pages, and scopes to catalog_page/target task ids", async () => {
    const service = await readFile(
      path.resolve(process.cwd(), "src/server/task-admin/service.ts"),
      "utf8",
    );
    const sqlStart = service.indexOf("async function loadCatalogBookAggregates");
    const sql = service.slice(sqlStart, sqlStart + 1500);
    // Both COUNT(*) FILTER clauses must exclude cascaded (never actually
    // fetched) items — appears twice, once for pages_scanned, once for
    // failed_pages.
    expect(sql.match(/COALESCE\(result->>'stoppedBeforeFetch', 'false'\) <> 'true'/g)?.length).toBe(2);
    expect(sql).toMatch(/SUM\(\(result->>'returnedCount'\)::int\) FILTER \(WHERE status = 'success'\)/);
    expect(sql).toMatch(/target_type = 'catalog_page'/);
    expect(sql).toMatch(/GROUP BY task_id/);
    expect(sql).toMatch(/task_id = ANY\(\$\{taskIds\}::uuid\[\]\)/);
  });
});

describe("C-12 listAdminTasks: bookCounts projection", () => {
  it("in-progress task: derives upstreamTotal/fetched/pagesScanned/percent from the aggregate row, failedBooks 0 with no failed pages", async () => {
    const context = await readContext("/api/admin/tasks");
    const row = {
      family: "generic", task_id: TASK_ID, task_type: "catalog_scan", status: "processing",
      total_count: 2000, success_count: 10, failed_count: 0, skipped_count: 0,
      has_error: false, created_at: NOW,
      result: { catalogObservedTotal: 1000 },
      params: { pageSize: 20 },
    };
    const aggregateRow = { task_id: TASK_ID, fetched: 190n, pages_scanned: 10n, failed_pages: 0n };
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        return call === 1 ? [row] : [aggregateRow];
      },
    } as unknown as PrismaClient;

    const result = await listAdminTasks(db, context, {}, {} as NodeJS.ProcessEnv);

    expect(result.items[0].bookCounts).toEqual({
      upstreamTotal: 1000,
      fetched: 190,
      failedBooks: 0,
      pagesScanned: 10,
      pagesTotalExpected: 50,
      percent: 19,
    });
    // Page-denominated fields untouched — Phase C's frozen task shape.
    expect(result.items[0].totalCount).toBe(2000);
    expect(result.items[0].successCount).toBe(10);
    expect(call).toBe(2);
  });

  it("terminal task: failedBooks = non-cascaded failed pages × pageSize, using the aggregate's already-excluded failed_pages count", async () => {
    const context = await readContext("/api/admin/tasks");
    const row = {
      family: "generic", task_id: TASK_ID, task_type: "catalog_scan", status: "completed_with_errors",
      total_count: 2000, success_count: 4, failed_count: 1997, skipped_count: 0,
      has_error: false, created_at: NOW,
      result: { catalogObservedTotal: 89, stopReason: "upstream_error" },
      params: { pageSize: 20 },
    };
    // 4 successful pages (80 books) + 1 real (non-cascaded) failed page +
    // 1995 cascaded stoppedBeforeFetch pages the aggregate SQL already
    // excludes from both pages_scanned and failed_pages.
    const aggregateRow = { task_id: TASK_ID, fetched: 80n, pages_scanned: 5n, failed_pages: 1n };
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        return call === 1 ? [row] : [aggregateRow];
      },
    } as unknown as PrismaClient;

    const result = await listAdminTasks(db, context, {}, {} as NodeJS.ProcessEnv);

    expect(result.items[0].bookCounts).toEqual({
      upstreamTotal: 89,
      fetched: 80,
      failedBooks: 20, // 1 non-cascaded failed page × pageSize 20 — not 1995 cascaded pages.
      pagesScanned: 5, // 4 success + 1 failed, not 1995 cascaded pages ever counted "scanned".
      pagesTotalExpected: 5, // ceil(89 / 20), not the 2000-page safety fuse.
      percent: 90, // round(80 / 89 * 100)
    });
  });

  it("percent is capped at 100 even if the aggregate ever over-reports fetched relative to upstreamTotal", async () => {
    const context = await readContext("/api/admin/tasks");
    const row = {
      family: "generic", task_id: TASK_ID, task_type: "catalog_scan", status: "processing",
      total_count: 10, success_count: 10, failed_count: 0, skipped_count: 0,
      has_error: false, created_at: NOW,
      result: { catalogObservedTotal: 100 },
      params: { pageSize: 20 },
    };
    const aggregateRow = { task_id: TASK_ID, fetched: 140n, pages_scanned: 7n, failed_pages: 0n };
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        return call === 1 ? [row] : [aggregateRow];
      },
    } as unknown as PrismaClient;

    const result = await listAdminTasks(db, context, {}, {} as NodeJS.ProcessEnv);
    expect(result.items[0].bookCounts?.percent).toBe(100);
  });

  it("missing result.catalogObservedTotal: bookCounts is entirely absent (not a partially-filled object), and no aggregate query is issued", async () => {
    const context = await readContext("/api/admin/tasks");
    const row = {
      family: "generic", task_id: TASK_ID, task_type: "catalog_scan", status: "processing",
      total_count: 2000, success_count: 1, failed_count: 0, skipped_count: 0,
      has_error: false, created_at: NOW,
      result: { stopReason: null },
      params: { pageSize: 20 },
    };
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        return [row];
      },
    } as unknown as PrismaClient;

    const result = await listAdminTasks(db, context, {}, {} as NodeJS.ProcessEnv);

    expect(result.items[0]).not.toHaveProperty("bookCounts");
    expect(call).toBe(1); // only the main SELECT — the aggregate query is never worth issuing.
  });

  it("missing params.pageSize: bookCounts is absent even though catalogObservedTotal is known", async () => {
    const context = await readContext("/api/admin/tasks");
    const row = {
      family: "generic", task_id: TASK_ID, task_type: "catalog_scan", status: "processing",
      total_count: 2000, success_count: 1, failed_count: 0, skipped_count: 0,
      has_error: false, created_at: NOW,
      result: { catalogObservedTotal: 1000 },
      params: {},
    };
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        return [row];
      },
    } as unknown as PrismaClient;

    const result = await listAdminTasks(db, context, {}, {} as NodeJS.ProcessEnv);

    expect(result.items[0]).not.toHaveProperty("bookCounts");
    expect(call).toBe(1);
  });

  it("non-catalog_scan taskType: bookCounts is absent even when result/params happen to carry the same shape", async () => {
    const context = await readContext("/api/admin/tasks");
    const row = {
      family: "generic", task_id: TASK_ID, task_type: "moboreader.preview_refresh.v1", status: "completed",
      total_count: 5, success_count: 5, failed_count: 0, skipped_count: 0,
      has_error: false, created_at: NOW,
      result: { catalogObservedTotal: 1000 },
      params: { pageSize: 20 },
    };
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        return [row];
      },
    } as unknown as PrismaClient;

    const result = await listAdminTasks(db, context, {}, {} as NodeJS.ProcessEnv);

    expect(result.items[0]).not.toHaveProperty("bookCounts");
    expect(call).toBe(1);
  });

  it("batches multiple catalog_scan rows into exactly one extra aggregate query, not one per row", async () => {
    const context = await readContext("/api/admin/tasks");
    const TASK_ID_2 = "10000000-0000-4000-8000-000000000002";
    const rowA = {
      family: "generic", task_id: TASK_ID, task_type: "catalog_scan", status: "processing",
      total_count: 2000, success_count: 5, failed_count: 0, skipped_count: 0,
      has_error: false, created_at: NOW,
      result: { catalogObservedTotal: 500 }, params: { pageSize: 20 },
    };
    const rowB = {
      family: "generic", task_id: TASK_ID_2, task_type: "catalog_scan", status: "completed",
      total_count: 2000, success_count: 25, failed_count: 0, skipped_count: 0,
      has_error: false, created_at: NOW,
      result: { catalogObservedTotal: 500 }, params: { pageSize: 20 },
    };
    const aggregateRows = [
      { task_id: TASK_ID, fetched: 90n, pages_scanned: 5n, failed_pages: 0n },
      { task_id: TASK_ID_2, fetched: 500n, pages_scanned: 25n, failed_pages: 0n },
    ];
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        return call === 1 ? [rowA, rowB] : aggregateRows;
      },
    } as unknown as PrismaClient;

    const result = await listAdminTasks(db, context, {}, {} as NodeJS.ProcessEnv);

    expect(call).toBe(2); // one main SELECT + exactly one batched aggregate query for both rows.
    expect(result.items.find((item) => item.taskId === TASK_ID)?.bookCounts?.fetched).toBe(90);
    expect(result.items.find((item) => item.taskId === TASK_ID_2)?.bookCounts?.fetched).toBe(500);
  });
});

describe("C-12 getAdminTaskDetail: bookCounts projection", () => {
  it("derives bookCounts for a catalog_scan task once result/params are already known, in one extra query", async () => {
    const context = await readContext("/api/admin/tasks/detail");
    const row = {
      family: "generic", task_id: TASK_ID, task_type: "catalog_scan", status: "completed_with_errors",
      total_count: 2000, success_count: 4, failed_count: 1997, skipped_count: 0,
      has_error: false, created_at: NOW, updated_at: NOW,
      mode: "apply", channel_account_id: null,
      params: { pageSize: 20 },
      result: { catalogObservedTotal: 89, stopReason: "upstream_error" },
    };
    const originItemRows: unknown[] = []; // no origin item in this fixture
    const aggregateRow = { task_id: TASK_ID, fetched: 80n, pages_scanned: 5n, failed_pages: 1n };
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        if (call === 1) return [row];
        if (call === 2) return originItemRows; // deriveOriginStopReason
        return [aggregateRow]; // loadCatalogBookAggregates
      },
    } as unknown as PrismaClient;

    const detail = await getAdminTaskDetail(db, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);

    expect(detail.bookCounts).toEqual({
      upstreamTotal: 89,
      fetched: 80,
      failedBooks: 20,
      pagesScanned: 5,
      pagesTotalExpected: 5,
      percent: 90,
    });
    expect(call).toBe(3);
  });

  it("missing catalogObservedTotal: bookCounts absent and the aggregate query is never issued (query count stays at the pre-C-12 count)", async () => {
    const context = await readContext("/api/admin/tasks/detail");
    const row = {
      family: "generic", task_id: TASK_ID, task_type: "catalog_scan", status: "completed_with_errors",
      total_count: 2000, success_count: 3, failed_count: 2, skipped_count: 0,
      has_error: false, created_at: NOW, updated_at: NOW,
      mode: "apply", channel_account_id: null,
      params: {},
      result: { stopReason: "upstream_error" },
    };
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        return call === 1 ? [row] : [];
      },
    } as unknown as PrismaClient;

    const detail = await getAdminTaskDetail(db, context, { family: "generic", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);

    expect(detail).not.toHaveProperty("bookCounts");
    expect(call).toBe(2); // row fetch + origin-item lookup only, same as before C-12.
  });

  it("non-catalog_scan taskType: bookCounts absent, no extra query at all", async () => {
    const context = await readContext("/api/admin/tasks/detail");
    const row = {
      family: "channel_sync", task_id: TASK_ID, task_type: "moboreader.preview_refresh.v1", status: "completed",
      total_count: 2, success_count: 2, failed_count: 0, skipped_count: 0,
      has_error: false, created_at: NOW, updated_at: NOW,
      mode: "apply", channel_account_id: null,
      params: { pageSize: 20 },
      result: { catalogObservedTotal: 99 },
    };
    let call = 0;
    const db = {
      $queryRaw: async () => {
        call += 1;
        return [row];
      },
    } as unknown as PrismaClient;

    const detail = await getAdminTaskDetail(db, context, { family: "channel_sync", taskId: TASK_ID }, {} as NodeJS.ProcessEnv);

    expect(detail).not.toHaveProperty("bookCounts");
    expect(call).toBe(1);
  });
});
