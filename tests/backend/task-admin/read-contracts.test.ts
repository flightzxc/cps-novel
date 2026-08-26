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

  it.each(["catalog_scan", "channel_sync", "generic"] as const)(
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
        catalogScanTaskItem: delegate,
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
