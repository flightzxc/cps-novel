import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MoboreaderAdapterError } from "@/lib/adapters";
import { ID_IN_LIST_CHUNK_SIZE } from "@/lib/db/chunked-id-lookup";
import {
  enqueueMoboreaderPreviewRefreshTask,
  MOBOREADER_CATALOG_LIMITS,
  MOBOREADER_PREVIEW_ENV,
  MOBOREADER_PREVIEW_RUNTIME_DEFAULTS,
  resolveMoboreaderPreviewRuntimeConfig,
  validateMoboreaderCatalogScanInput,
} from "@/lib/tasks";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
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
    expect(handlers.catalog_scan).toMatchObject({ family: "generic", maxAttempts: 3 });
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
        novelId: "11111111-1111-4111-8111-111111111111",
        deletedAt: null,
        novel: { previewPolicy: null },
      }));
    });
    const db = {
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
