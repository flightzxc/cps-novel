import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MoboreaderAdapterError, type ListBooksResponse, type MoboreaderBook } from "@/lib/adapters";
import { ID_IN_LIST_CHUNK_SIZE } from "@/lib/db/chunked-id-lookup";
import {
  buildCatalogPosition,
  CATALOG_POSITION_TRUSTED_SIGNATURE,
  enqueueMoboreaderPreviewRefreshTask,
  catalogPreviewRequestToken,
  failMoboreaderCatalogFinalize,
  isTrustedCatalogPosition,
  MOBOREADER_CATALOG_MAX_ATTEMPTS,
  MOBOREADER_CATALOG_LIMITS,
  MOBOREADER_PREVIEW_STAGE_BATCH_SIZE,
  MOBOREADER_PREVIEW_ENV,
  MOBOREADER_PREVIEW_RUNTIME_DEFAULTS,
  resolveMoboreaderPreviewRuntimeConfig,
  stageMoboreaderPreviewRefreshTask,
  validateMoboreaderCatalogScanInput,
} from "@/lib/tasks";
import { resolveChannelLanguage } from "@/lib/locale/channel-language";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import {
  catalogRecoveryFingerprint,
  createMoboreaderCatalogHandler,
  createMoboreaderPreviewHandler,
  createMoboreaderWorkerHandlers,
  determineMoboreaderCatalogStopReason,
  parseMoboreaderCatalogPayload,
  parseMoboreaderCatalogRecoveryPayload,
  pickBookSourceLocale,
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
    // C-13 (`施工工单_C13_每页100本与节流余量_2026-09-07.md`): ceiling raised
    // 20 -> 100 after probing the upstream host directly (request-count rate
    // limit, not row-count -- see the doc comment on
    // `MOBOREADER_CATALOG_LIMITS.maxPageSize`). 100 itself must still be
    // accepted; 101 -- one past the probed ceiling -- must still be rejected.
    expect(() => validateMoboreaderCatalogScanInput({ ...validInput, pageSize: 101 }, { NODE_ENV: "test" })).toThrow("page_size_exceeded");
    expect(validateMoboreaderCatalogScanInput({ ...validInput, pageSize: 100 }, { NODE_ENV: "test" }).pageSize).toBe(100);
  });

  it("Phase B: `languages` defaults to [], trims/dedupes when provided, and rejects non-empty-string entries", () => {
    // 施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md §三: the operator
    // no longer picks page mechanics, only languages -- recorded for
    // `/tasks` detail and result filtering, never sent upstream as a
    // filter (see the doc comment on `CreateMoboreaderCatalogScanTaskInput`).
    expect(validateMoboreaderCatalogScanInput(validInput, { NODE_ENV: "test" }).languages).toEqual([]);

    expect(
      validateMoboreaderCatalogScanInput({ ...validInput, languages: [" en ", "ja", "en"] }, { NODE_ENV: "test" })
        .languages,
    ).toEqual(["en", "ja"]);

    expect(() =>
      validateMoboreaderCatalogScanInput({ ...validInput, languages: [""] }, { NODE_ENV: "test" }),
    ).toThrow("languages_invalid");
    expect(() =>
      validateMoboreaderCatalogScanInput({ ...validInput, languages: ["   "] }, { NODE_ENV: "test" }),
    ).toThrow("languages_invalid");
    expect(() =>
      validateMoboreaderCatalogScanInput(
        { ...validInput, languages: [123 as unknown as string] },
        { NODE_ENV: "test" },
      ),
    ).toThrow("languages_invalid");
    expect(() =>
      validateMoboreaderCatalogScanInput(
        { ...validInput, languages: "en" as unknown as string[] },
        { NODE_ENV: "test" },
      ),
    ).toThrow("languages_invalid");
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

  it("C-13: the worker item-level pageSize check (`item.pageSize > MOBOREADER_CATALOG_LIMITS.maxPageSize` in worker/handlers/moboreader.ts) accepts the new 100 ceiling and still rejects one past it", () => {
    expect(parseMoboreaderCatalogPayload({ ...payload, pageSize: 100 })).toMatchObject({ pageSize: 100 });
    expect(() => parseMoboreaderCatalogPayload({ ...payload, pageSize: 101 })).toThrow("catalog_payload_invalid");
  });

  it("pins recovery identity sets with an order-independent SHA-256 fingerprint", () => {
    const identities = [
      { externalBookId: "book:2", sourceLanguageCode: "en" },
      { externalBookId: "book-1", sourceLanguageCode: "ja" },
    ];
    const fingerprint = catalogRecoveryFingerprint(identities);
    expect(catalogRecoveryFingerprint([...identities].reverse())).toBe(fingerprint);
    expect(parseMoboreaderCatalogRecoveryPayload({
      ...payload,
      kind: "catalog_recovery_page",
      missingIdentities: identities,
      gapFingerprint: fingerprint,
    })).toMatchObject({ missingIdentities: [identities[1], identities[0]], gapFingerprint: fingerprint });
    expect(() => parseMoboreaderCatalogRecoveryPayload({
      ...payload,
      kind: "catalog_recovery_page",
      missingIdentities: identities,
      gapFingerprint: "0".repeat(64),
    })).toThrow("catalog_recovery_fingerprint_mismatch");
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
    expect(handlers.catalog_scan).toMatchObject({ family: "generic", maxAttempts: MOBOREADER_CATALOG_MAX_ATTEMPTS });
    expect(handlers["moboreader.preview_refresh.v1"]).toMatchObject({ family: "channel_sync", maxAttempts: 1 });
  });

  it.each([
    [{ NODE_ENV: "test" }, "feature_disabled"],
    [{ NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false" }, "write_disabled"],
  ] satisfies Array<[NodeJS.ProcessEnv, string]>) (
    "keeps catalog finalize behind both production write gates (%s)",
    async (env, code) => {
      const db = { genericTask: { findUniqueOrThrow: vi.fn() } } as unknown as PrismaClient;
      const outcome = await createMoboreaderCatalogHandler(db, {
        adapter: { listBooks: vi.fn(), fetchBookMaterial: vi.fn(), fetchPreviewChapters: vi.fn() },
        env,
      })({
        lease: {
          family: "generic", taskType: "catalog_scan", targetType: "catalog_finalize", mode: "apply",
          itemId: "item", taskId: "task", workerId: "worker", executionToken: "token",
          leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(),
          payload: { kind: "catalog_finalize", actorId: "actor", requestId: "request", generation: 1 },
        },
        mode: "apply",
        signal: new AbortController().signal,
        heartbeat: async () => true,
      });
      expect(outcome).toMatchObject({ status: "failed", error: { code } });
      expect(db.genericTask.findUniqueOrThrow).not.toHaveBeenCalled();
    },
  );

  it("uses a stable Preview token within a generation and a new token for a new generation", () => {
    const taskId = "10000000-0000-4000-8000-000000000001";
    expect(catalogPreviewRequestToken(taskId, 1)).toBe(`moboreader.preview_refresh.v1:${taskId}`);
    expect(catalogPreviewRequestToken(taskId, 2)).toBe(`moboreader.preview_refresh.v1:${taskId}:g2`);
    expect(catalogPreviewRequestToken(taskId, 2)).toBe(catalogPreviewRequestToken(taskId, 2));
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
      lease: { family: "generic", taskType: "catalog_scan", mode: "dry_run", itemId: "item", taskId: "task", workerId: "worker", executionToken: "token", leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(), payload },
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
      lease: { family: "generic", taskType: "catalog_scan", mode: "apply", itemId: "item", taskId: "task", workerId: "worker", executionToken: "token", leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(), payload },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "write_disabled" } });
    expect(adapter.listBooks).not.toHaveBeenCalled();
  });

  it("does not request a page beyond the persisted terminalPage", async () => {
    const terminalPayload = {
      ...payload,
      pageIndex: 5,
      requestedPageEnd: 10,
      scheduledPageEnd: 10,
    };
    const db = {
      genericTask: {
        findUnique: vi.fn(async () => ({
          channelAccountId: "account",
          channelAppId: "app",
          params: { projectType: 1, pageStart: 1, pageEnd: 10, pageSize: 20 },
          result: { terminalPage: 4 },
        })),
      },
    } as unknown as PrismaClient;
    const adapter = { listBooks: vi.fn(), fetchBookMaterial: vi.fn(), fetchPreviewChapters: vi.fn() };
    const outcome = await createMoboreaderCatalogHandler(db, {
      adapter,
      env: { NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true" },
    })({
      lease: {
        family: "generic", taskType: "catalog_scan", targetType: "catalog_page", mode: "apply",
        itemId: "item", taskId: "task", workerId: "worker", executionToken: "token",
        leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(), payload: terminalPayload,
      },
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({
      status: "success",
      result: { stoppedBeforeFetch: true, terminalPage: 4, returnedCount: 0 },
    });
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

describe("catalog finalizer preview staging", () => {
  it("terminalizes only the pending Preview residue with an exact failed count", async () => {
    const previewUpdate = vi.fn(async () => ({}));
    const parentUpdate = vi.fn(async () => ({}));
    const tx = {
      genericTask: {
        findUniqueOrThrow: vi.fn(async () => ({ result: { terminalPage: 974 } })),
        update: parentUpdate,
      },
      channelSyncTask: {
        findUnique: vi.fn(async () => ({ id: "preview", status: "disabled", result: { buildStatus: "building" } })),
        update: previewUpdate,
      },
      channelSyncTaskItem: {
        updateMany: vi.fn(async () => ({ count: 2 })),
        count: vi.fn(async () => 2),
      },
      operationAudit: { create: vi.fn(async () => ({})) },
    } as unknown as Prisma.TransactionClient;

    await failMoboreaderCatalogFinalize(tx, {
      catalogTaskId: "10000000-0000-4000-8000-000000000001",
      generation: 2,
      actorId: "worker",
      requestId: "request",
      reason: "lease_expired",
      now: new Date("2026-09-17T00:00:00Z"),
    });

    expect(parentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { result: expect.objectContaining({ finalization: expect.objectContaining({ status: "failed", generation: 2 }) }) },
    }));
    expect(previewUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", failedCount: 2, result: expect.objectContaining({ buildStatus: "failed" }) }),
    }));
  });

  it("stages 100,000 sources in bounded short phases and a fixed-token rerun is a no-op", async () => {
    const sourceIds = Array.from({ length: 100_000 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const lookupSizes: number[] = [];
    const writeBatchSizes: number[] = [];
    let stagedCount = 0;
    const taskCreate = vi.fn(async () => ({}));
    const taskUpdate = vi.fn(async () => ({}));
    const tx = {
      channelSyncTask: { create: taskCreate, update: taskUpdate },
      channelSyncTaskItem: {
        createMany: vi.fn(async (args: { data: unknown[] }) => {
          writeBatchSizes.push(args.data.length);
          stagedCount += args.data.length;
          return { count: args.data.length };
        }),
        count: vi.fn(async () => stagedCount),
      },
      operationAudit: { create: vi.fn(async () => ({})) },
    };
    const db = {
      channelSyncTask: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => null),
      },
      channelApp: { findFirst: vi.fn(async () => ({ id: "app", sourceApp: { code: "changdu" } })) },
      channelAccount: { findFirst: vi.fn(async () => ({ id: "account", credentials: [{ id: "credential" }] })) },
      novelSourceItem: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
          const ids = args.where.id.in;
          lookupSizes.push(ids.length);
          return ids.map((id) => ({
            id,
            novelId: id,
            deletedAt: null,
            novel: { previewPolicy: null },
          }));
        }),
      },
    } as unknown as PrismaClient;
    const writePhase = async <T>(write: (client: Prisma.TransactionClient) => Promise<T>) =>
      write(tx as unknown as Prisma.TransactionClient);
    const input = {
      trigger: "auto" as const,
      catalogScanTaskId: "10000000-0000-4000-8000-000000000001",
      channelAccountId: "10000000-0000-4000-8000-000000000002",
      channelAppId: "10000000-0000-4000-8000-000000000003",
      novelSourceItemIds: sourceIds,
      requestToken: "moboreader.preview_refresh.v1:10000000-0000-4000-8000-000000000001",
      actorId: "actor",
      requestId: "request",
      mode: "apply" as const,
    };

    const result = await stageMoboreaderPreviewRefreshTask(db, input, writePhase, {
      NODE_ENV: "test",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
      MOBOREADER_PREVIEW_SOURCE_APP_CODES: "changdu",
    });

    expect(result).toMatchObject({ status: "enqueued", eligibleCount: 100_000, taskStatus: "pending" });
    expect(Math.max(...lookupSizes)).toBeLessThanOrEqual(ID_IN_LIST_CHUNK_SIZE);
    expect(Math.max(...writeBatchSizes)).toBeLessThanOrEqual(MOBOREADER_PREVIEW_STAGE_BATCH_SIZE);
    expect(writeBatchSizes).toHaveLength(100);
    expect(stagedCount).toBe(100_000);
    expect(taskCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "disabled",
        totalCount: 0,
        params: expect.objectContaining({
          evidence: expect.objectContaining({ dataId: "confirmed_getlistpc_series_id" }),
        }),
      }),
    }));
    expect(taskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "pending", totalCount: 100_000 }),
    }));

    const duplicateDb = {
      channelSyncTask: {
        findUnique: vi.fn(async () => ({ id: "ready-task", status: "pending", result: { buildStatus: "ready" } })),
      },
    } as unknown as PrismaClient;
    await expect(stageMoboreaderPreviewRefreshTask(
      duplicateDb,
      input,
      async () => { throw new Error("duplicate rerun must not write"); },
      { NODE_ENV: "test" },
    )).resolves.toEqual({ status: "duplicate", taskId: "ready-task" });
  });

  it("turns an activation unique-race loser into a replayable superseded shell", async () => {
    const taskUpdate = vi.fn()
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("active scope race", {
        code: "P2002", clientVersion: "6.19.2",
      }))
      .mockResolvedValueOnce({});
    const itemUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      channelSyncTask: { create: vi.fn(async () => ({})), update: taskUpdate },
      channelSyncTaskItem: {
        createMany: vi.fn(async () => ({ count: 1 })),
        count: vi.fn(async () => 1),
        updateMany: itemUpdateMany,
      },
      operationAudit: { create: vi.fn(async () => ({})) },
    };
    const findFirst = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "20000000-0000-4000-8000-000000000001" });
    const db = {
      channelSyncTask: { findUnique: vi.fn(async () => null), findFirst },
      channelApp: { findFirst: vi.fn(async () => ({ id: "app", sourceApp: { code: "changdu" } })) },
      channelAccount: { findFirst: vi.fn(async () => ({ id: "account", credentials: [{ id: "credential" }] })) },
      novelSourceItem: { findMany: vi.fn(async () => [{
        id: "10000000-0000-4000-8000-000000000004", novelId: "novel", deletedAt: null,
        novel: { previewPolicy: null },
      }]) },
    } as unknown as PrismaClient;

    const result = await stageMoboreaderPreviewRefreshTask(db, {
      trigger: "auto",
      catalogScanTaskId: "10000000-0000-4000-8000-000000000001",
      channelAccountId: "10000000-0000-4000-8000-000000000002",
      channelAppId: "10000000-0000-4000-8000-000000000003",
      novelSourceItemIds: ["10000000-0000-4000-8000-000000000004"],
      requestToken: "race-request",
      actorId: "actor",
      requestId: "request",
      mode: "apply",
    }, async (write) => write(tx as unknown as Prisma.TransactionClient), {
      NODE_ENV: "test",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
      MOBOREADER_PREVIEW_SOURCE_APP_CODES: "changdu",
    });

    expect(result).toEqual({ status: "active_conflict", taskId: "20000000-0000-4000-8000-000000000001" });
    expect(itemUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "skipped" }),
    }));
    expect(taskUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "cancelled", result: expect.objectContaining({ buildStatus: "superseded" }) }),
    }));

    const replayDb = {
      channelSyncTask: { findUnique: vi.fn(async () => ({
        id: "loser", status: "cancelled",
        result: { buildStatus: "superseded", activeTaskId: "20000000-0000-4000-8000-000000000001" },
      })) },
    } as unknown as PrismaClient;
    await expect(stageMoboreaderPreviewRefreshTask(
      replayDb,
      {
        trigger: "auto", catalogScanTaskId: "10000000-0000-4000-8000-000000000001",
        channelAccountId: "10000000-0000-4000-8000-000000000002",
        channelAppId: "10000000-0000-4000-8000-000000000003",
        novelSourceItemIds: ["10000000-0000-4000-8000-000000000004"],
        requestToken: "race-request", actorId: "actor", requestId: "request", mode: "apply",
      },
      async () => { throw new Error("superseded replay must not write"); },
    )).resolves.toEqual({ status: "active_conflict", taskId: "20000000-0000-4000-8000-000000000001" });
  });
});

/**
 * C-10 (Phase E rework, 2026-09-07): before this, a `MoboreaderAdapterError`
 * thrown by `adapter.listBooks` fell into the same generic
 * `{ code: "upstream_error", message: "MoboReader catalog read failed" }`
 * branch as any other error — discarding the adapter's own code/HTTP
 * status/retryable flag. This is a real diagnosis-time regression: the
 * 09-05 incident this work order documents took a container-level
 * reproduction to surface "HTTP 401" that should have been readable
 * straight from the failed item.
 *
 * Reaches `adapter.listBooks` through the handler's real
 * `loadAndValidateTaskScope` → `loadBinding` → `decryptCredentialSecretForWorker`
 * chain, using a minimal hand-rolled Prisma double (only the two calls this
 * path issues: `genericTask.findUnique` and one `$queryRaw` binding lookup)
 * and a real encrypt/decrypt round trip through temp keyring files — same
 * conventions as `tests/backend/credentials/db-retry-wiring.test.ts` and
 * `tests/backend/credentials/jwt-normalization-service.test.ts`
 * respectively. `mode: "dry_run"` so no `protectedWrite` runs and no
 * further DB call shapes need faking.
 */
describe("MoboReader catalog handler: adapter error visibility (C-10)", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const APP_ID = "22222222-2222-4222-8222-222222222222";
  const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";

  function credentialKeyring(): { env: NodeJS.ProcessEnv; cleanup(): void } {
    const directory = mkdtempSync(path.join(tmpdir(), "cps-novel-moboreader-keys-"));
    const v1 = path.join(directory, "v1");
    const fingerprint = path.join(directory, "fingerprint");
    writeFileSync(v1, randomBytes(32).toString("base64"), { mode: 0o600 });
    writeFileSync(fingerprint, randomBytes(32).toString("base64"), { mode: 0o600 });
    return {
      env: {
        NODE_ENV: "test",
        CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
        CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: v1,
        CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: fingerprint,
      },
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  }

  /**
   * `decryptCredentialSecretForWorker` is called by the handler with no
   * `env` argument, so it always reads `process.env` — there is no
   * dependency-injection seam for it. This helper temporarily overlays the
   * keyring vars onto the real `process.env` for the duration of one test
   * and restores exactly what was there before, including deleting keys
   * that did not previously exist.
   */
  async function withProcessEnvOverlay<T>(overlay: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
    const previous = new Map<string, string | undefined>();
    for (const key of Object.keys(overlay)) previous.set(key, process.env[key]);
    Object.assign(process.env, overlay);
    try {
      return await run();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  /** Minimal Prisma double for exactly the two calls this handler issues before `adapter.listBooks`. */
  function fakeDb(encryptedSecret: Uint8Array): PrismaClient {
    return {
      genericTask: {
        findUnique: async () => ({
          channelAccountId: ACCOUNT_ID,
          channelAppId: APP_ID,
          params: { projectType: payload.projectType, pageStart: 1, pageEnd: payload.requestedPageEnd, pageSize: payload.pageSize },
        }),
      },
      $queryRaw: async () => [{
        project_type: payload.projectType,
        credential_id: CREDENTIAL_ID,
        encrypted_secret: encryptedSecret,
        key_version: 1,
      }],
    } as unknown as PrismaClient;
  }

  function baseLease(mode: "dry_run" | "apply" = "dry_run") {
    return {
      family: "generic" as const,
      taskType: "catalog_scan",
      mode,
      itemId: "item",
      taskId: "task",
      workerId: "worker",
      executionToken: "token",
      leaseEpoch: 1n,
      attemptCount: 1,
      lockedUntil: new Date(),
      payload,
    };
  }

  it("MoboreaderAdapterError: message carries adapter code + HTTP status + page, detail carries the enumerated fields", async () => {
    const keys = credentialKeyring();
    try {
      await withProcessEnvOverlay(keys.env, async () => {
        const encryptedSecret = new Uint8Array(
          encryptCredentialSecretForWorker("bare-token", ACCOUNT_ID, CREDENTIAL_ID, 1),
        );
        const db = fakeDb(encryptedSecret);

        const adapter = {
          listBooks: vi.fn(async () => {
            throw new MoboreaderAdapterError("upstream_http_error", false, 401);
          }),
          fetchBookMaterial: vi.fn(),
          fetchPreviewChapters: vi.fn(),
        };
        const handler = createMoboreaderCatalogHandler(db, {
          adapter,
          env: { NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true" },
        });

        const outcome = await handler({
          lease: baseLease("dry_run"),
          mode: "dry_run",
          signal: new AbortController().signal,
          heartbeat: async () => true,
        });

        expect(adapter.listBooks).toHaveBeenCalledTimes(1);
        expect(outcome).toMatchObject({
          status: "failed",
          result: { stopReason: "upstream_error", terminalState: "partial_failed" },
          error: {
            code: "upstream_error",
            message: "MoboReader catalog read failed: upstream_http_error (HTTP 401) at page 1",
            detail: {
              adapterCode: "upstream_http_error",
              httpStatus: 401,
              retryable: false,
              pageIndex: 1,
            },
          },
        });
        // No `protectedWrite` in dry_run mode — nothing left to persist for
        // this test to accidentally assert against a mocked transaction.
        expect(outcome.protectedWrite).toBeUndefined();
      });
    } finally {
      keys.cleanup();
    }
  });

  it("MoboreaderAdapterError without an HTTP status omits the '(HTTP …)' segment but still carries httpStatus: null", async () => {
    const keys = credentialKeyring();
    try {
      await withProcessEnvOverlay(keys.env, async () => {
        const encryptedSecret = new Uint8Array(
          encryptCredentialSecretForWorker("bare-token", ACCOUNT_ID, CREDENTIAL_ID, 1),
        );
        const db = fakeDb(encryptedSecret);

        const adapter = {
          listBooks: vi.fn(async () => {
            throw new MoboreaderAdapterError("transport_error", true);
          }),
          fetchBookMaterial: vi.fn(),
          fetchPreviewChapters: vi.fn(),
        };
        const handler = createMoboreaderCatalogHandler(db, {
          adapter,
          env: { NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true" },
        });

        const outcome = await handler({
          lease: baseLease("dry_run"),
          mode: "dry_run",
          signal: new AbortController().signal,
          heartbeat: async () => true,
        });

        expect(outcome).toMatchObject({
          status: "failed",
          error: {
            code: "upstream_error",
            message: "MoboReader catalog read failed: transport_error at page 1",
            detail: { adapterCode: "transport_error", httpStatus: null, retryable: true, pageIndex: 1 },
          },
        });
      });
    } finally {
      keys.cleanup();
    }
  });

  it("a plain (non-adapter) error still gets the pre-existing generic message — byte-identical to before C-10", async () => {
    const keys = credentialKeyring();
    try {
      await withProcessEnvOverlay(keys.env, async () => {
        const encryptedSecret = new Uint8Array(
          encryptCredentialSecretForWorker("bare-token", ACCOUNT_ID, CREDENTIAL_ID, 1),
        );
        const db = fakeDb(encryptedSecret);

        const adapter = {
          listBooks: vi.fn(async () => {
            throw new Error("some non-adapter failure, e.g. a bug elsewhere in the call chain");
          }),
          fetchBookMaterial: vi.fn(),
          fetchPreviewChapters: vi.fn(),
        };
        const handler = createMoboreaderCatalogHandler(db, {
          adapter,
          env: { NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true" },
        });

        const outcome = await handler({
          lease: baseLease("dry_run"),
          mode: "dry_run",
          signal: new AbortController().signal,
          heartbeat: async () => true,
        });

        expect(outcome).toMatchObject({
          status: "failed",
          error: { code: "upstream_error", message: "MoboReader catalog read failed" },
        });
        expect((outcome.error as { detail?: unknown }).detail).toBeUndefined();
      });
    } finally {
      keys.cleanup();
    }
  });
});

/**
 * C-15 (施工工单_C15_终态扫描绑定变量溢出_2026-09-07.md): before this,
 * `enqueueMoboreaderPreviewRefreshTask`'s `novelSourceItem.findMany({ where:
 * { id: { in: input.novelSourceItemIds } } })` bound one Postgres prepared-
 * statement parameter per id -- a single "whole task scan" trigger touching
 * more than 32,767 ids (the incident this work order documents hit 96,660)
 * blew that cap and rolled back the entire enqueue transaction. This test
 * proves the fixed path -- `findNovelSourceItemsByIds` inside
 * `enqueueMoboreaderPreviewRefreshTask` -- no longer builds one unbounded
 * `findMany` call: 40,000 ids (comfortably past 32,767, and past
 * `ID_IN_LIST_CHUNK_SIZE` eight times over) must be served by multiple
 * `findMany` calls, each at most `ID_IN_LIST_CHUNK_SIZE` ids, and the
 * function must complete without throwing.
 */
describe("MoboReader preview enqueue: chunked id lookup (C-15)", () => {
  function uuidFromIndex(i: number): string {
    // Deterministic RFC-4122-shaped v4/variant-8 UUID satisfying
    // `validatedPreviewInput`'s strict format regex, unique per index.
    const h = i.toString(16).padStart(30, "0").slice(-30);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-8${h.slice(15, 18)}-${h.slice(18, 30)}`;
  }

  function fakeEnqueueDb() {
    const findManyCallSizes: number[] = [];
    const findMany = vi.fn(async (args: { where: { id: { in: string[] }; channelAppId?: string } }) => {
      const batch = args.where.id.in;
      findManyCallSizes.push(batch.length);
      return batch.map((id) => ({
        id,
        novelId: id,
        deletedAt: null,
        novel: { previewPolicy: null },
      }));
    });
    const db = {
      $executeRaw: vi.fn(async () => 0),
      channelSyncTaskItem: { findMany: vi.fn(async () => []) },
      channelSyncTask: {
        findUnique: async () => null,
        findFirst: async () => null,
        create: async () => undefined,
      },
      channelApp: {
        findFirst: async () => ({ id: "app-1", sourceApp: { code: "moboreader" } }),
      },
      channelAccount: {
        findFirst: async () => ({ id: "account-1", credentials: [{ id: "cred-1" }] }),
      },
      novelSourceItem: { findMany },
      operationAudit: { create: async () => undefined },
      // Owner 2026-09-18 决策 2: the enqueue path now consults the account
      // brake before deciding `pending` vs `disabled`. No hold here — this
      // test is about chunking, and an un-held account is the shape that
      // exercises the normal `pending` branch.
      channelAccountHold: { findFirst: async () => null },
    };
    return { db, findManyCallSizes };
  }

  const ENV = Object.freeze({
    NODE_ENV: "test",
    FEATURE_NOVEL_CATALOG_SYNC: "true",
    NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    [MOBOREADER_PREVIEW_ENV.sourceAppCodes]: "moboreader",
  });

  it("40,000 ids: multiple findMany calls, each <= ID_IN_LIST_CHUNK_SIZE, and no throw", async () => {
    const ids = Array.from({ length: 40_000 }, (_, i) => uuidFromIndex(i));
    const { db, findManyCallSizes } = fakeEnqueueDb();

    const result = await enqueueMoboreaderPreviewRefreshTask(
      db as never,
      {
        trigger: "manual",
        channelAccountId: "account-1",
        channelAppId: "app-1",
        novelSourceItemIds: ids,
        requestToken: "c15-40k-request-token",
        actorId: "actor-1",
        requestId: "request-1",
        mode: "apply",
      },
      ENV,
      new Date("2026-09-07T00:00:00.000Z"),
    );

    expect(result).toMatchObject({ status: "enqueued", eligibleCount: 40_000 });
    expect(findManyCallSizes.length).toBeGreaterThan(1);
    for (const size of findManyCallSizes) expect(size).toBeLessThanOrEqual(ID_IN_LIST_CHUNK_SIZE);
    expect(findManyCallSizes.reduce((a, b) => a + b, 0)).toBe(40_000);
  });
});

describe("pickBookSourceLocale · L10N P1 write-site invariant", () => {
  it("resolved code → the resolved locale string, never a literal \"unknown\"", () => {
    const resolution = resolveChannelLanguage({ sourceLanguageCode: "3" });
    expect(pickBookSourceLocale(resolution, new Set())).toBe("en");
  });

  it("unresolved code (e.g. 19/20, MAPPING_EVIDENCE_MISSING) → null, not the string \"unknown\"", () => {
    for (const code of ["19", "20", "1"]) {
      const resolution = resolveChannelLanguage({ sourceLanguageCode: code });
      const sourceLocale = pickBookSourceLocale(resolution, new Set());
      expect(sourceLocale).toBeNull();
      expect(sourceLocale).not.toBe("unknown");
    }
  });

  it("a suspended code is force-nulled even though resolveChannelLanguage itself found a mapping", () => {
    const resolution = resolveChannelLanguage({ sourceLanguageCode: "3" }); // resolves to "en"
    expect(pickBookSourceLocale(resolution, new Set(["3"]))).toBeNull();
  });

  it("suspension only affects the matching sourceLanguageCode, not others in the same set", () => {
    const resolution = resolveChannelLanguage({ sourceLanguageCode: "3" });
    expect(pickBookSourceLocale(resolution, new Set(["7", "9"]))).toBe("en");
  });
});

/**
 * `persistCatalogPage` wiring (Opus 复核 NON_BLOCKING b①): the two unit-level
 * describes above prove `pickBookSourceLocale` and
 * `evaluateLanguageMappingSuspensions` are each individually correct, but
 * neither proves `persistCatalogPage` (the private function that actually
 * calls both, once per `catalog_page` task item) wires them together
 * correctly — a mutation that skips the per-page suspension evaluation
 * entirely, or applies it to only *some* of a suspended code's rows, would
 * pass every test above unnoticed. This drives the real, exported
 * `createMoboreaderCatalogHandler` end to end (mode `apply`) with a page of
 * 10 books, all `sourceLanguageCode: "3"`, 3 of which carry a conflicting
 * `languageName` ("俄语" against code 3's own "en" mapping) — `total=10,
 * conflicts=3, rate=0.3` trips `evaluateLanguageMappingSuspensions`'s
 * `total>=10 && conflicts>=3 && rate>=0.2` threshold — then calls the
 * handler's own returned `protectedWrite` against a hand-rolled fake
 * transaction to assert on what `persistCatalogPage` actually wrote.
 *
 * The scenario is deliberately non-terminal (`payload.requestedPageEnd: 2`,
 * one sibling `catalog_page` item still `pending`) so the fake transaction
 * only needs to answer the calls `persistCatalogPage` makes on its
 * non-terminal path (`novelSourceItem.upsert` per book,
 * `genericTask.findUniqueOrThrow`/`.update`, `genericTaskItem.update`,
 * `operationAudit.create`) — the terminal path additionally calls
 * `enqueueMoboreaderPreviewRefreshTask` (its own multi-table binding/
 * capability/credential lookup chain), which is exercised elsewhere
 * (C-15 above) and is not this test's concern.
 */
describe("persistCatalogPage wiring: per-page suspension evaluation (Opus NON_BLOCKING b①)", () => {
  const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
  const APP_ID = "55555555-5555-4555-8555-555555555555";
  const CREDENTIAL_ID = "66666666-6666-4666-8666-666666666666";

  function credentialKeyring(): { env: NodeJS.ProcessEnv; cleanup(): void } {
    const directory = mkdtempSync(path.join(tmpdir(), "cps-novel-moboreader-suspension-keys-"));
    const v1 = path.join(directory, "v1");
    const fingerprint = path.join(directory, "fingerprint");
    writeFileSync(v1, randomBytes(32).toString("base64"), { mode: 0o600 });
    writeFileSync(fingerprint, randomBytes(32).toString("base64"), { mode: 0o600 });
    return {
      env: {
        NODE_ENV: "test",
        CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
        CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: v1,
        CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: fingerprint,
      },
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  }

  async function withProcessEnvOverlay<T>(overlay: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
    const previous = new Map<string, string | undefined>();
    for (const key of Object.keys(overlay)) previous.set(key, process.env[key]);
    Object.assign(process.env, overlay);
    try {
      return await run();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const suspensionPayload = {
    pageIndex: 1,
    pageSize: 10,
    name: "",
    orderType: 0,
    projectType: 1,
    safetyMaxPages: 2,
    requestedPageEnd: 2,
    scheduledPageEnd: 2,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    source: "manual" as const,
    actorId: "actor",
    requestId: "request-id",
  };

  /** Minimal Prisma double for the handler's own pre-transaction scope/binding load. */
  function fakeOuterDb(encryptedSecret: Uint8Array): PrismaClient {
    return {
      genericTask: {
        findUnique: async () => ({
          channelAccountId: ACCOUNT_ID,
          channelAppId: APP_ID,
          params: { projectType: suspensionPayload.projectType, pageStart: 1, pageEnd: 2, pageSize: suspensionPayload.pageSize },
        }),
      },
      $queryRaw: async () => [{
        project_type: suspensionPayload.projectType,
        credential_id: CREDENTIAL_ID,
        encrypted_secret: encryptedSecret,
        key_version: 1,
      }],
    } as unknown as PrismaClient;
  }

  /**
   * 10 books, all `language: "3"` (code mapping → `en`); `conflictCount` of
   * them carry `languageName: "俄语"` (nameLocale `ru`, conflicting with the
   * code mapping) to drive `evaluateLanguageMappingSuspensions`'s conflict
   * count. `rawEvidence` deliberately mirrors `language`/`languageName` so
   * `rawLanguageScopeFromPayload` (called by `persistCatalogPage`, throws on
   * a null scope) can derive a scope.
   */
  function suspensionBooks(total: number, conflictCount: number): MoboreaderBook[] {
    return Array.from({ length: total }, (_, index) => {
      const languageName = index < conflictCount ? "俄语" : "英语";
      return {
        externalBookId: `book-${index + 1}`,
        agencyId: null,
        agencyName: null,
        seriesId: `series-${index + 1}`,
        materialType: null,
        title: `Title ${index + 1}`,
        description: null,
        coverUrl: null,
        projectType: 1,
        language: "3",
        languageName,
        allEpis: null,
        payEpisFrom: null,
        splitRatio: null,
        ttoSplitRatio: null,
        createTime: null,
        seriesTypeList: [],
        recommendList: [],
        labelSnapshotComplete: false, // skips persistLabels' sourceLabel/novelSourceItemLabel tx calls entirely
        existingPromo: { upstreamCode: null, webUrl: null }, // skips persistExistingCatalogPromo's promoLink tx calls entirely
        rawEvidence: { language: "3", languageName, __boundary: "approved_raw_evidence" } as const,
      };
    });
  }

  /**
   * Fake transaction covering exactly the calls `persistCatalogPage` makes
   * on a non-terminal page (see this describe block's doc comment). `
   * $queryRaw` is a queue answered in the fixed call order the source issues
   * them: task-row `FOR UPDATE` lock, then the `beforeStop` `SUM(...)`, then
   * the `afterStop` pending/processing/failed counts.
   */
  function fakeCatalogPageTx() {
    const queryRawResponses: unknown[] = [
      [{ id: "task-1" }], // FOR UPDATE lock
      [{ total: 0n }], // beforeStop: no prior successful pages
      [{ actual: 0n, pending: 1n, processing_others: 0n, failed: 0n }], // afterStop: sibling page 2 still pending -> non-terminal
    ];
    let queryRawCall = 0;
    const upsertCreateCalls: Array<Record<string, unknown>> = [];
    let genericTaskItemUpdateArgs: { data: { result: Record<string, unknown> } } | null = null;
    let genericTaskUpdateArgs: { data: { result: Record<string, unknown> } } | null = null;

    const tx = {
      $queryRaw: async () => queryRawResponses[queryRawCall++],
      novelSourceItem: {
        upsert: async (args: { create: Record<string, unknown> }) => {
          upsertCreateCalls.push(args.create);
          return { id: `source-${upsertCreateCalls.length}` };
        },
      },
      genericTask: {
        findUniqueOrThrow: async () => ({
          params: {
            projectType: suspensionPayload.projectType,
            pageStart: 1,
            pageEnd: 2,
            pageSize: suspensionPayload.pageSize,
          },
        }),
        update: async (args: { data: { result: Record<string, unknown> } }) => {
          genericTaskUpdateArgs = args;
        },
      },
      genericTaskItem: {
        update: async (args: { data: { result: Record<string, unknown> } }) => {
          genericTaskItemUpdateArgs = args;
        },
      },
      operationAudit: {
        create: async () => ({ id: 1n }),
      },
    };

    return {
      tx: tx as unknown as Prisma.TransactionClient,
      upsertCreateCalls,
      getGenericTaskItemUpdateArgs: () => genericTaskItemUpdateArgs,
      getGenericTaskUpdateArgs: () => genericTaskUpdateArgs,
    };
  }

  it("a suspended code (total=10, conflicts=3, rate=0.3) forces sourceLocale=null for EVERY row of that code, including the 7 that never individually conflicted", async () => {
    const keys = credentialKeyring();
    try {
      await withProcessEnvOverlay(keys.env, async () => {
        const encryptedSecret = new Uint8Array(
          encryptCredentialSecretForWorker("bare-token", ACCOUNT_ID, CREDENTIAL_ID, 1),
        );
        const outerDb = fakeOuterDb(encryptedSecret);
        const books = suspensionBooks(10, 3);
        const response: ListBooksResponse = {
          items: books,
          totalCount: 100,
          rawEvidence: { totalCount: 100, __boundary: "approved_raw_evidence" } as const,
        };
        const adapter = {
          listBooks: vi.fn(async () => response),
          fetchBookMaterial: vi.fn(),
          fetchPreviewChapters: vi.fn(),
        };
        const handler = createMoboreaderCatalogHandler(outerDb, {
          adapter,
          env: { NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true" },
        });

        const outcome = await handler({
          lease: {
            family: "generic",
            taskType: "catalog_scan",
            mode: "apply",
            itemId: "item-1",
            taskId: "task-1",
            workerId: "worker",
            executionToken: "token",
            leaseEpoch: 1n,
            attemptCount: 1,
            lockedUntil: new Date(),
            payload: suspensionPayload,
          },
          mode: "apply",
          signal: new AbortController().signal,
          heartbeat: async () => true,
        });

        expect(outcome.status).toBe("success");
        expect(outcome.protectedWrite).toBeTypeOf("function");

        const { tx, upsertCreateCalls, getGenericTaskItemUpdateArgs, getGenericTaskUpdateArgs } = fakeCatalogPageTx();
        const writeOutcome = await outcome.protectedWrite!(tx);
        expect(writeOutcome).toMatchObject({ status: "success" });

        // Every one of the 10 upserted rows — the 3 that individually
        // conflicted AND the 7 that did not — must have been force-nulled by
        // the page-level suspension, not just the conflicting ones.
        expect(upsertCreateCalls).toHaveLength(10);
        for (const create of upsertCreateCalls) {
          expect(create.sourceLocale, JSON.stringify(create)).toBeNull();
        }

        const pageResult = getGenericTaskItemUpdateArgs()?.data.result;
        expect(pageResult?.unknownLocaleCount).toBe(10);
        expect(pageResult?.suspendedLanguageCodes).toEqual(["3"]);

        const taskResult = getGenericTaskUpdateArgs()?.data.result;
        expect(taskResult?.unknownLocaleCount).toBe(10);
        expect(taskResult?.suspendedLanguageCodes).toEqual(["3"]);
        expect(taskResult?.terminalState).toBe("processing"); // non-terminal: sibling page 2 still pending
      });
    } finally {
      keys.cleanup();
    }
  });

  it("below-threshold conflicts (total=10, conflicts=2, rate=0.2 but conflicts<3) do NOT suspend — rows keep their individually resolved locale", async () => {
    const keys = credentialKeyring();
    try {
      await withProcessEnvOverlay(keys.env, async () => {
        const encryptedSecret = new Uint8Array(
          encryptCredentialSecretForWorker("bare-token", ACCOUNT_ID, CREDENTIAL_ID, 1),
        );
        const outerDb = fakeOuterDb(encryptedSecret);
        const books = suspensionBooks(10, 2); // conflicts=2 < 3 -> below threshold
        const response: ListBooksResponse = {
          items: books,
          totalCount: 100,
          rawEvidence: { totalCount: 100, __boundary: "approved_raw_evidence" } as const,
        };
        const adapter = {
          listBooks: vi.fn(async () => response),
          fetchBookMaterial: vi.fn(),
          fetchPreviewChapters: vi.fn(),
        };
        const handler = createMoboreaderCatalogHandler(outerDb, {
          adapter,
          env: { NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true" },
        });

        const outcome = await handler({
          lease: {
            family: "generic",
            taskType: "catalog_scan",
            mode: "apply",
            itemId: "item-1",
            taskId: "task-1",
            workerId: "worker",
            executionToken: "token",
            leaseEpoch: 1n,
            attemptCount: 1,
            lockedUntil: new Date(),
            payload: suspensionPayload,
          },
          mode: "apply",
          signal: new AbortController().signal,
          heartbeat: async () => true,
        });

        const { tx, upsertCreateCalls, getGenericTaskItemUpdateArgs } = fakeCatalogPageTx();
        await outcome.protectedWrite!(tx);

        expect(upsertCreateCalls).toHaveLength(10);
        // code 3 resolves to "en" unconditionally (code mapping wins over
        // name), so with no suspension every row keeps "en" — not null.
        for (const create of upsertCreateCalls) {
          expect(create.sourceLocale).toBe("en");
        }
        expect(getGenericTaskItemUpdateArgs()?.data.result.unknownLocaleCount).toBe(0);
        expect(getGenericTaskItemUpdateArgs()?.data.result.suspendedLanguageCodes).toEqual([]);
      });
    } finally {
      keys.cleanup();
    }
  });

  // 领推广链接正式修复第 5 阶段·5-A（设计 §6.2/§7.2, E5）：`persistCatalogPage`
  // 每一行都要把 `catalogPosition` 写进 `novelSourceItem.upsert` 的 `create`
  // 载荷里，且绝不能把页码混进 `rawPayload`（`rawPayload` 是已批准的"原始
  // 上游证据"边界，见设计 §6.2）。用假事务做单测——不需要真实 Postgres 就能
  // 覆盖"登记写错页码字段"/"不写 observedAt"/"把页码混进 rawPayload"三类
  // 变异（真实 Postgres 上的等价验收见 `tests/integration/tasks/
  // p2-05-postgres.test.ts` 新增用例）。
  it("persistCatalogPage writes catalogPosition on every row's create payload, matching the page's own coordinate, without leaking the page index into rawPayload", async () => {
    const keys = credentialKeyring();
    try {
      await withProcessEnvOverlay(keys.env, async () => {
        const encryptedSecret = new Uint8Array(
          encryptCredentialSecretForWorker("bare-token", ACCOUNT_ID, CREDENTIAL_ID, 1),
        );
        const outerDb = fakeOuterDb(encryptedSecret);
        // 10 本、pageSize 10——returnedCount === pageSize，与既有
        // `fakeCatalogPageTx()` 用例同样的形状（stopReason 为 null，不触发
        // 该假事务未桩的 `$executeRaw` 分支），全部 conflictCount=0（无冲突，
        // 语种正常解析）。
        const books = suspensionBooks(10, 0);
        const response: ListBooksResponse = {
          items: books,
          totalCount: 100,
          rawEvidence: { totalCount: 100, __boundary: "approved_raw_evidence" } as const,
        };
        const adapter = {
          listBooks: vi.fn(async () => response),
          fetchBookMaterial: vi.fn(),
          fetchPreviewChapters: vi.fn(),
        };
        const handler = createMoboreaderCatalogHandler(outerDb, {
          adapter,
          env: { NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true" },
        });
        const before = Date.now();
        const outcome = await handler({
          lease: {
            family: "generic", taskType: "catalog_scan", mode: "apply", itemId: "item-1", taskId: "task-1",
            workerId: "worker", executionToken: "token", leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(),
            payload: suspensionPayload,
          },
          mode: "apply", signal: new AbortController().signal, heartbeat: async () => true,
        });

        const { tx, upsertCreateCalls } = fakeCatalogPageTx();
        await outcome.protectedWrite!(tx);

        expect(upsertCreateCalls).toHaveLength(10);
        for (const created of upsertCreateCalls) {
          expect(created.catalogPosition).toMatchObject({
            pageIndex: suspensionPayload.pageIndex,
            pageSize: suspensionPayload.pageSize,
            orderType: suspensionPayload.orderType,
            nameEmpty: true,
            scanTaskId: "task-1",
          });
          const observedAt = Date.parse((created.catalogPosition as { observedAt: string }).observedAt);
          expect(observedAt).toBeGreaterThanOrEqual(before);
        }
        // 页码/坐标绝不能混进 rawPayload——这里必须与书目自己的 rawEvidence
        // 逐字相等，多一个 pageIndex 键都会让这条断言变红。
        expect(upsertCreateCalls[0]!.rawPayload).toEqual({ language: "3", languageName: "英语", __boundary: "approved_raw_evidence" });
      });
    } finally {
      keys.cleanup();
    }
  });
});

/**
 * 领推广链接正式修复第 5 阶段·5-A（`设计_领推广按接口限速与预读集合化_
 * 阶段4-5_2026-09-24.md` §6.1/§6.2/E5）：目录页位置登记的两个纯函数——
 * `buildCatalogPosition`（写侧，如实记录扫描坐标）与
 * `isTrustedCatalogPosition`（读侧，坐标签名匹配判定）。真正在 `persistCatalogPage`
 * 里写入并在真实 Postgres 上核对，见 `tests/integration/tasks/
 * p2-05-postgres.test.ts` 新增的用例。
 */
describe("buildCatalogPosition / isTrustedCatalogPosition (5-A 页位置登记)", () => {
  const observedAt = new Date("2026-09-24T12:00:00.000Z");

  it("buildCatalogPosition records the scan's own coordinate verbatim, deriving nameEmpty from name===''", () => {
    const position = buildCatalogPosition({
      pageIndex: 5, pageSize: 100, orderType: 0, name: "", observedAt, scanTaskId: "task-1",
    });
    expect(position).toEqual({
      pageIndex: 5, pageSize: 100, orderType: 0, nameEmpty: true,
      observedAt: "2026-09-24T12:00:00.000Z", scanTaskId: "task-1",
    });
  });

  it("buildCatalogPosition records nameEmpty=false for a named (title-search) scan — still recorded, trust judged separately", () => {
    const position = buildCatalogPosition({
      pageIndex: 1, pageSize: 100, orderType: 0, name: "some title", observedAt, scanTaskId: "task-2",
    });
    expect(position.nameEmpty).toBe(false);
    expect(isTrustedCatalogPosition(position)).toBe(false);
  });

  it("buildCatalogPosition records a non-canonical pageSize verbatim (e.g. the pre-C-13 20/page value) — still recorded, trust judged separately", () => {
    const position = buildCatalogPosition({
      pageIndex: 1, pageSize: 20, orderType: 0, name: "", observedAt, scanTaskId: "task-3",
    });
    expect(position.pageSize).toBe(20);
    expect(isTrustedCatalogPosition(position)).toBe(false);
  });

  it("isTrustedCatalogPosition accepts exactly the canonical signature (empty name, orderType 0, pageSize = MOBOREADER_CATALOG_LIMITS.maxPageSize)", () => {
    const position = buildCatalogPosition({
      pageIndex: 42, pageSize: MOBOREADER_CATALOG_LIMITS.maxPageSize, orderType: 0, name: "", observedAt, scanTaskId: "task-4",
    });
    expect(isTrustedCatalogPosition(position)).toBe(true);
    expect(CATALOG_POSITION_TRUSTED_SIGNATURE).toEqual({ nameEmpty: true, orderType: 0, pageSize: MOBOREADER_CATALOG_LIMITS.maxPageSize });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a plain string", "not-an-object"],
    ["an array", []],
    ["missing scanTaskId", { pageIndex: 1, pageSize: 100, orderType: 0, nameEmpty: true, observedAt: observedAt.toISOString() }],
    ["missing observedAt", { pageIndex: 1, pageSize: 100, orderType: 0, nameEmpty: true, scanTaskId: "t" }],
    ["pageIndex = 0 (not a valid 1-based page)", { pageIndex: 0, pageSize: 100, orderType: 0, nameEmpty: true, observedAt: observedAt.toISOString(), scanTaskId: "t" }],
    ["pageIndex negative", { pageIndex: -1, pageSize: 100, orderType: 0, nameEmpty: true, observedAt: observedAt.toISOString(), scanTaskId: "t" }],
    ["pageIndex not an integer", { pageIndex: 1.5, pageSize: 100, orderType: 0, nameEmpty: true, observedAt: observedAt.toISOString(), scanTaskId: "t" }],
    ["orderType mismatched (1 instead of 0)", { pageIndex: 1, pageSize: 100, orderType: 1, nameEmpty: true, observedAt: observedAt.toISOString(), scanTaskId: "t" }],
    ["nameEmpty mismatched (false)", { pageIndex: 1, pageSize: 100, orderType: 0, nameEmpty: false, observedAt: observedAt.toISOString(), scanTaskId: "t" }],
    ["pageSize mismatched (legacy 20)", { pageIndex: 1, pageSize: 20, orderType: 0, nameEmpty: true, observedAt: observedAt.toISOString(), scanTaskId: "t" }],
  ])("isTrustedCatalogPosition rejects: %s", (_label, value) => {
    expect(isTrustedCatalogPosition(value)).toBe(false);
  });
});
