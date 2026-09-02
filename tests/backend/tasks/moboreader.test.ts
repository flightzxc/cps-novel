import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MOBOREADER_CATALOG_LIMITS,
  MOBOREADER_PREVIEW_RUNTIME_DEFAULTS,
  resolveMoboreaderPreviewRuntimeConfig,
  validateMoboreaderCatalogScanInput,
} from "@/lib/tasks";
import {
  createMoboreaderCatalogHandler,
  createMoboreaderPreviewHandler,
  createMoboreaderWorkerHandlers,
  determineMoboreaderCatalogStopReason,
  parseMoboreaderCatalogPayload,
} from "../../../worker/handlers/moboreader";

const validInput = {
  channelAccountId: "account",
  channelAppId: "app",
  pageStart: 1,
  pageEnd: 10_000,
  pageSize: 20,
  requestToken: "request-token",
  actorId: "actor",
  requestId: "request-id",
};

const payload = {
  pageIndex: 1,
  pageSize: 20,
  name: "",
  orderType: 0,
  projectType: 1,
  safetyMaxPages: 2_000,
  requestedPageEnd: 10_000,
  scheduledPageEnd: 2_000,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  source: "manual" as const,
  actorId: "actor",
  requestId: "request-id",
};

describe("MoboReader catalog safety and parity", () => {
  it("has no item quota and treats the env page budget as technical safety", () => {
    expect(validateMoboreaderCatalogScanInput(validInput, { NODE_ENV: "test" })).toMatchObject({
      mode: "dry_run",
      safetyMaxPages: MOBOREADER_CATALOG_LIMITS.defaultSafetyMaxPages,
      pageEnd: 10_000,
      pageSize: 20,
    });
    expect(validateMoboreaderCatalogScanInput(validInput, {
      NODE_ENV: "test",
      MOBOREADER_CATALOG_SAFETY_MAX_PAGES: "17",
    }).safetyMaxPages).toBe(17);
    expect(() => validateMoboreaderCatalogScanInput(validInput, {
      NODE_ENV: "test",
      MOBOREADER_CATALOG_SAFETY_MAX_PAGES: "0",
    })).toThrow("safety_max_pages_invalid");
    expect(() => validateMoboreaderCatalogScanInput({ ...validInput, pageSize: 21 }, { NODE_ENV: "test" })).toThrow("page_size_exceeded");
  });

  it("removes the retired item quota from production catalog code", () => {
    const source = [
      readFileSync(new URL("../../../src/lib/tasks/moboreader.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../../../worker/handlers/moboreader.ts", import.meta.url), "utf8"),
    ].join("\n");
    expect(source).not.toContain("maxItems");
    expect(source).not.toContain("max_items");
  });

  it("requires a durable manual source and technical checkpoint payload", () => {
    expect(parseMoboreaderCatalogPayload(payload)).toMatchObject({
      source: "manual",
      pageIndex: 1,
      safetyMaxPages: 2_000,
    });
    expect(() => parseMoboreaderCatalogPayload({ ...payload, source: "scheduler" })).toThrow("manual_source_required");
  });

  it.each([
    [{ returnedCount: 0, pageSize: 10, fetchedRaw: 0, batchExpectedCount: 100, pageIndex: 1, requestedPageEnd: 10, scheduledPageEnd: 10 }, "empty_page"],
    [{ returnedCount: 10, pageSize: 10, fetchedRaw: 100, batchExpectedCount: 100, pageIndex: 10, requestedPageEnd: 20, scheduledPageEnd: 20 }, "expected_total_reached"],
    [{ returnedCount: 10, pageSize: 10, fetchedRaw: 10, batchExpectedCount: 100, pageIndex: 2, requestedPageEnd: 9, scheduledPageEnd: 2 }, "safety_limit"],
    [{ returnedCount: 10, pageSize: 10, fetchedRaw: 10, batchExpectedCount: 100, pageIndex: 2, requestedPageEnd: 2, scheduledPageEnd: 2 }, "expected_pages_reached"],
    [{ returnedCount: 3, pageSize: 10, fetchedRaw: 3, batchExpectedCount: 100, pageIndex: 1, requestedPageEnd: 10, scheduledPageEnd: 10 }, "short_page"],
  ])("derives the frozen stop reason", (input, expected) => {
    expect(determineMoboreaderCatalogStopReason(input)).toBe(expected);
  });

  it("registers catalog and preview in the reused worker", () => {
    const handlers = createMoboreaderWorkerHandlers({} as never);
    expect(handlers.catalog_scan).toMatchObject({ family: "catalog_scan", maxAttempts: 3 });
    expect(handlers["moboreader.preview_refresh.v1"]).toMatchObject({ family: "channel_sync", maxAttempts: 1 });
  });

  it("freezes Preview parity defaults and supports env overrides", () => {
    expect(resolveMoboreaderPreviewRuntimeConfig({ NODE_ENV: "test" })).toEqual(MOBOREADER_PREVIEW_RUNTIME_DEFAULTS);
    expect(resolveMoboreaderPreviewRuntimeConfig({
      NODE_ENV: "test",
      MOBOREADER_PREVIEW_CHUNK_SIZE: "5",
      MOBOREADER_PREVIEW_CONCURRENCY: "4",
      MOBOREADER_PREVIEW_TIMEOUT_MS: "9000",
      MOBOREADER_PREVIEW_FRESHNESS_MS: "60000",
    })).toEqual({ chunkSize: 5, concurrency: 4, timeoutMs: 9_000, freshnessMs: 60_000 });
  });

  it("keeps featureFlag=false before database or upstream access", async () => {
    const adapter = { listBooks: vi.fn(), fetchBookMaterial: vi.fn(), fetchPreviewChapters: vi.fn() };
    const handler = createMoboreaderCatalogHandler({} as never, { adapter, env: { NODE_ENV: "test" } });
    const outcome = await handler({
      lease: { family: "catalog_scan", taskType: "catalog_scan", mode: "dry_run", itemId: "item", taskId: "task", workerId: "worker", executionToken: "token", leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(), payload },
      mode: "dry_run",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "feature_disabled" } });
    expect(adapter.listBooks).not.toHaveBeenCalled();
  });

  it("keeps allowWrite=false before database or upstream access for apply", async () => {
    const adapter = { listBooks: vi.fn(), fetchBookMaterial: vi.fn(), fetchPreviewChapters: vi.fn() };
    const handler = createMoboreaderCatalogHandler({} as never, {
      adapter,
      env: { NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false" },
    });
    const outcome = await handler({
      lease: { family: "catalog_scan", taskType: "catalog_scan", mode: "apply", itemId: "item", taskId: "task", workerId: "worker", executionToken: "token", leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(), payload },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "write_disabled" } });
    expect(adapter.listBooks).not.toHaveBeenCalled();
  });

  it("keeps the Preview feature gate ahead of database and upstream access", async () => {
    const adapter = { listBooks: vi.fn(), fetchBookMaterial: vi.fn(), fetchPreviewChapters: vi.fn() };
    const outcome = await createMoboreaderPreviewHandler({} as never, { adapter, env: { NODE_ENV: "test" } })({
      lease: { family: "channel_sync", taskType: "moboreader.preview_refresh.v1", mode: "apply", itemId: "item", taskId: "task", workerId: "worker", executionToken: "token", leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(), payload: {} },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "feature_disabled" } });
    expect(adapter.fetchBookMaterial).not.toHaveBeenCalled();
    expect(adapter.fetchPreviewChapters).not.toHaveBeenCalled();
  });
});
