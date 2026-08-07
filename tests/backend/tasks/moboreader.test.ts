import { describe, expect, it, vi } from "vitest";
import {
  MOBOREADER_CATALOG_LIMITS,
  MoboreaderPreviewContractDisabledError,
  createMoboreaderPreviewRefreshTask,
  validateMoboreaderCatalogScanInput,
} from "@/lib/tasks";
import { createMoboreaderCatalogHandler, createMoboreaderWorkerHandlers, parseMoboreaderCatalogPayload } from "../../../worker/handlers/moboreader";

const validInput = {
  channelAccountId: "account",
  channelAppId: "app",
  pageStart: 1,
  pageEnd: 10,
  pageSize: 100,
  requestToken: "request-token",
  actorId: "actor",
  requestId: "request-id",
};

const payload = {
  pageIndex: 1,
  pageSize: 100,
  name: "",
  orderType: 0,
  projectType: 1,
  maxPages: 2_000,
  maxItems: 1_000,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  source: "manual" as const,
  actorId: "actor",
  requestId: "request-id",
};

describe("MoboReader manual task safety", () => {
  it("defaults to dry-run and freezes all limits into validated input", () => {
    expect(validateMoboreaderCatalogScanInput(validInput)).toMatchObject({
      mode: "dry_run",
      maxPages: MOBOREADER_CATALOG_LIMITS.maxPages,
      maxItems: MOBOREADER_CATALOG_LIMITS.maxItems,
      pageSize: 100,
    });
  });

  it("enforces maxPages, maxItems and pageSize", () => {
    expect(() => validateMoboreaderCatalogScanInput({ ...validInput, pageEnd: 2_001 })).toThrow("max_pages_exceeded");
    expect(() => validateMoboreaderCatalogScanInput({ ...validInput, maxItems: 1_001 })).toThrow("max_items_exceeded");
    expect(() => validateMoboreaderCatalogScanInput({ ...validInput, pageSize: 101 })).toThrow("page_size_exceeded");
    expect(() => validateMoboreaderCatalogScanInput({ ...validInput, pageEnd: 11 })).toThrow("max_items_exceeded");
  });

  it("requires a durable manual source and checkpoint payload", () => {
    expect(parseMoboreaderCatalogPayload(payload)).toMatchObject({ source: "manual", pageIndex: 1, requestId: "request-id" });
    expect(() => parseMoboreaderCatalogPayload({ ...payload, source: "scheduler" })).toThrow("manual_source_required");
  });

  it("registers catalog recovery at the reused P1 three-attempt boundary", () => {
    expect(createMoboreaderWorkerHandlers({} as never).catalog_scan).toMatchObject({
      family: "catalog_scan",
      maxAttempts: 3,
    });
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

  it("fails closed without creating a preview task while materialType is unproven", async () => {
    await expect(createMoboreaderPreviewRefreshTask({} as never, {
      channelAccountId: "account",
      channelAppId: "app",
      novelSourceItemIds: ["source"],
      requestToken: "token",
      actorId: "actor",
      requestId: "request",
    })).rejects.toBeInstanceOf(MoboreaderPreviewContractDisabledError);
  });
});
