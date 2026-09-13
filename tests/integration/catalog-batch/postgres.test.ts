import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeCatalogSelection } from "@/domain/catalog-batch";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import {
  CATALOG_BATCH_TASK_TYPE,
  NOVEL_MATERIALIZE_TASK_TYPE,
  buildWorkerAllowlist,
  claimPendingItem,
  createHandlerRegistry,
  enqueueCatalogBatch,
  finalizeTaskItem,
  recomputeParentTask,
  recoverExpiredItem,
} from "@/lib/tasks";
import { readCatalogBatchSummary } from "@/server/catalog-batch";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import { getAdminTaskDetail, getAdminTaskProgress, listAdminTasks } from "@/server/task-admin";
import { createCatalogBatchHandler } from "../../../worker/handlers/catalog-batch";
import { createNovelMaterializeHandler } from "../../../worker/handlers/novel-materialize";
import { processOneWorkerCycle } from "../../../worker/runtime";
import {
  assertDisposableCatalogDatabase,
  seedCatalogFoundation,
  seedCatalogRows,
  truncateCatalogDatabase,
  type CatalogFoundation,
} from "./support";
import { newStores, NOW, seedTaskAdmin } from "../../backend/task-admin/test-support";

const enabled = process.env.CATALOG_BATCH_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.CATALOG_BATCH_OWNER_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.CATALOG_BATCH_WORKER_DATABASE_URL });
let foundation: CatalogFoundation;
const requestedScaleCount = Number.parseInt(process.env.CATALOG_BATCH_SCALE_COUNT ?? "12051", 10);
const scaleCount = Number.isSafeInteger(requestedScaleCount) && requestedScaleCount > 0 ? requestedScaleCount : 12_051;

function idsHash(ids: readonly string[]): string {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
}

async function claim(taskType = CATALOG_BATCH_TASK_TYPE, leaseMs = 120_000) {
  const lease = await claimPendingItem(worker, {
    family: "generic", taskTypes: [taskType], workerId: `catalog-pg-${randomUUID()}`, leaseMs,
  });
  expect(lease).not.toBeNull();
  return lease!;
}

function handlerContext(lease: Awaited<ReturnType<typeof claim>>) {
  return { lease, mode: lease.mode, signal: new AbortController().signal, heartbeat: async () => true };
}

async function adminContext(pathname: string) {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  return (await requireAdminRouteAccess(
    { pathname, method: "GET", sessionToken: admin.token },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW },
  )).context;
}

async function linkSources(ids: readonly string[]) {
  for (const [index, id] of ids.entries()) {
    const novel = await owner.novel.create({ data: {
      businessId: `catalog-promo-${randomUUID()}`, title: `Promo ${index}`, description: "Promo", locale: "en", slug: `catalog-promo-${randomUUID()}`,
    } });
    await owner.novelSourceItem.update({ where: { id }, data: { novelId: novel.id, status: "linked" } });
  }
}

async function materialize(taskId: string) {
  const lease = await claim();
  expect(lease.taskId).toBe(taskId);
  const outcome = await createCatalogBatchHandler(worker)(handlerContext(lease));
  await finalizeTaskItem(worker, lease, outcome);
  return lease;
}

function enqueueContent(selection: ReturnType<typeof normalizeCatalogSelection>, requestId = randomUUID()) {
  return enqueueCatalogBatch(owner, {
    operation: "novel_materialize", selection, actorId: foundation.actorId, requestId,
  });
}

function workerWithFirstCatalogPageHook(hook: () => Promise<void>): PrismaClient {
  return {
    $transaction: async (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
    ) => worker.$transaction(async (tx) => {
      let firstPage = true;
      const novelSourceItem = new Proxy(tx.novelSourceItem, {
        get(target, property, receiver) {
          if (property !== "findMany") return Reflect.get(target, property, receiver);
          return async (args: unknown) => {
            const rows = await Reflect.apply(target.findMany, target, [args]);
            if (firstPage) {
              firstPage = false;
              await hook();
            }
            return rows;
          };
        },
      });
      const hookedTx = new Proxy(tx, {
        get(target, property, receiver) {
          return property === "novelSourceItem" ? novelSourceItem : Reflect.get(target, property, receiver);
        },
      }) as Prisma.TransactionClient;
      return callback(hookedTx);
    }, options),
  } as unknown as PrismaClient;
}

describe.skipIf(!enabled).sequential("catalog batch on disposable PostgreSQL 16.14", () => {
  beforeAll(async () => assertDisposableCatalogDatabase(owner), 30_000);
  beforeEach(async () => {
    await truncateCatalogDatabase(owner);
    foundation = await seedCatalogFoundation(owner);
  });
  afterAll(async () => Promise.all([owner.$disconnect(), worker.$disconnect()]));

  it("enqueue is O(1), stores only the selector, and requestId replay keeps the same parent", async () => {
    await seedCatalogRows(owner, { channelAppId: foundation.channels[0]!.channelAppId, count: 101, prefix: "enqueue" });
    const selection = normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "pending", search: "enqueue" } });
    const requestId = randomUUID();
    const first = await enqueueContent(selection, requestId);
    const replay = await enqueueContent(selection, requestId);
    expect(replay).toMatchObject({ taskId: first.taskId, duplicate: true });
    const parent = await owner.genericTask.findUniqueOrThrow({ where: { id: first.taskId }, include: { items: true, childTasks: true } });
    expect(parent.items).toHaveLength(1);
    expect(parent.childTasks).toHaveLength(0);
    expect((parent.params as { selection: unknown }).selection).toEqual(selection);
    expect(JSON.stringify((parent.params as { selection: unknown }).selection)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });

  it(`materializes ${scaleCount.toLocaleString("en-US")} fixed members across channels without omissions at 50-row boundaries`, async () => {
    const firstCount = Math.ceil(scaleCount / 2);
    const secondCount = scaleCount - firstCount;
    const expectedIds = [
      ...await seedCatalogRows(owner, { channelAppId: foundation.channels[0]!.channelAppId, count: firstCount, prefix: "scale-a" }),
      ...await seedCatalogRows(owner, { channelAppId: foundation.channels[1]!.channelAppId, count: secondCount, prefix: "scale-b" }),
    ];
    await seedCatalogRows(owner, { channelAppId: foundation.channels[0]!.channelAppId, count: 17, prefix: "excluded", status: "linked" });
    const selection = normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "pending", search: "scale-" } });
    const requestId = randomUUID();
    const queued = await enqueueContent(selection, requestId);
    expect(await enqueueContent(selection, requestId)).toMatchObject({ taskId: queued.taskId, duplicate: true });
    const materializeStartedAt = performance.now();
    await materialize(queued.taskId);
    const materializeElapsedMs = Math.round(performance.now() - materializeStartedAt);
    console.info(`CATALOG_BATCH_SCALE_METRIC count=${scaleCount} materializeMs=${materializeElapsedMs} expectedHash=${idsHash(expectedIds)}`);
    expect(materializeElapsedMs).toBeLessThan(120_000);
    const children = await owner.genericTask.findMany({ where: { parentTaskId: queued.taskId }, include: { items: { orderBy: { targetId: "asc" } } } });
    expect(children).toHaveLength(2);
    expect(children.map((row) => row.items.length).sort((a, b) => a - b)).toEqual([secondCount, firstCount].sort((a, b) => a - b));
    const ids = children.flatMap((row) => row.items.map((item) => item.targetId));
    expect(ids).toHaveLength(scaleCount);
    expect(new Set(ids).size).toBe(scaleCount);
    expect(idsHash(ids)).toBe(idsHash(expectedIds));
    expect(children.every((row) => row.taskType === NOVEL_MATERIALIZE_TASK_TYPE && row.totalCount === row.items.length)).toBe(true);
    const summary = await readCatalogBatchSummary(owner, queued.taskId, foundation.actorId);
    expect(summary).toMatchObject({ phase: "executing", submittedCount: scaleCount, ineligibleCount: 0 });
    await owner.genericTaskItem.updateMany({ where: { task: { parentTaskId: queued.taskId } }, data: { status: "success" } });
    for (const child of children) {
      await recomputeParentTask(owner, "generic", child.id);
    }
    expect((await owner.genericTask.findMany({ where: { parentTaskId: queued.taskId }, select: { status: true, successCount: true, failedCount: true, skippedCount: true } })))
      .toEqual(expect.arrayContaining(children.map((child) => ({ status: "completed", successCount: child.totalCount, failedCount: 0, skippedCount: 0 }))));
    expect(await readCatalogBatchSummary(owner, queued.taskId, foundation.actorId)).toMatchObject({ phase: "completed" });
  }, 150_000);

  it("quiesces runtime heartbeats before a slow fenced protected write", async () => {
    await seedCatalogRows(owner, { channelAppId: foundation.channels[0]!.channelAppId, count: 1, prefix: "runtime-heartbeat" });
    const queued = await enqueueContent(normalizeCatalogSelection({
      scope: "all_filtered", filter: { status: "pending", search: "runtime-heartbeat" },
    }));
    const lockUrl = new URL(process.env.CATALOG_BATCH_WORKER_DATABASE_URL!);
    lockUrl.searchParams.set("options", "-c lock_timeout=40ms");
    const runtimeDb = new PrismaClient({ datasourceUrl: lockUrl.toString() });
    const runtimeErrors: unknown[] = [];
    let protectedWriteStarted!: () => void;
    const started = new Promise<void>((resolve) => { protectedWriteStarted = resolve; });
    const handlers = createHandlerRegistry({
      [CATALOG_BATCH_TASK_TYPE]: {
        family: "generic",
        handler: async () => ({
          status: "success",
          protectedWrite: async (tx: Prisma.TransactionClient) => {
            protectedWriteStarted();
            await tx.$queryRaw<Array<{ slept: number }>>`SELECT 1 AS slept FROM pg_sleep(0.3)`;
            await tx.operationAudit.create({ data: {
              actorType: "worker", actorId: "runtime-heartbeat-test", action: "catalog_batch.runtime_heartbeat_marker",
              entityType: "GenericTask", entityId: queued.taskId, taskType: CATALOG_BATCH_TASK_TYPE, taskId: queued.taskId,
            } });
          },
        }),
      },
    });
    const cycle = processOneWorkerCycle({
      prisma: runtimeDb,
      workerId: "catalog-runtime-heartbeat",
      handlers,
      allowlist: buildWorkerAllowlist(CATALOG_BATCH_TASK_TYPE, handlers),
      signal: new AbortController().signal,
      leaseMs: 150,
      onError: (error) => runtimeErrors.push(error),
    });
    try {
      await started;
      await new Promise((resolve) => setTimeout(resolve, 180));
      const recovery = recoverExpiredItem(owner, {
        family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE],
        maxAttemptsByType: { [CATALOG_BATCH_TASK_TYPE]: 3 }, workerId: "competing-worker",
      });
      await expect(cycle).resolves.toBe(true);
      await expect(recovery).resolves.toBeNull();
      expect(runtimeErrors).toEqual([]);
      const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: queued.taskId } });
      expect(item).toMatchObject({ status: "success", attemptCount: 1 });
      expect(await owner.operationAudit.count({ where: { action: "catalog_batch.runtime_heartbeat_marker", taskId: queued.taskId } })).toBe(1);
      expect(await processOneWorkerCycle({
        prisma: runtimeDb, workerId: "catalog-runtime-heartbeat-replay", handlers,
        allowlist: buildWorkerAllowlist(CATALOG_BATCH_TASK_TYPE, handlers),
        signal: new AbortController().signal, leaseMs: 150, onError: (error) => runtimeErrors.push(error),
      })).toBe(false);
      expect(runtimeErrors).toEqual([]);
    } finally {
      await runtimeDb.$disconnect();
    }
  }, 30_000);

  it("keeps the first Repeatable Read membership snapshot when another connection changes unread rows", async () => {
    const channelAppId = foundation.channels[0]!.channelAppId;
    const originalIds = await seedCatalogRows(owner, { channelAppId, count: 101, prefix: "rr-snapshot" });
    const sortedIds = [...originalIds].sort();
    const unreadId = sortedIds[100]!;
    const insertedId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const queued = await enqueueContent(normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "pending", search: "rr-snapshot" } }));
    const lease = await claim();
    const outcome = await createCatalogBatchHandler(worker)(handlerContext(lease));
    let hookRuns = 0;
    const hookedWorker = workerWithFirstCatalogPageHook(async () => {
      hookRuns += 1;
      await owner.novelSourceItem.update({ where: { id: unreadId }, data: { status: "linked" } });
      await owner.novelSourceItem.create({ data: {
        id: insertedId, channelAppId, externalBookId: "rr-snapshot-inserted", sourceLanguageCode: "en", sourceLocale: "en",
        title: "rr-snapshot inserted after page one", description: "late insert", status: "pending", rawPayload: { fixture: true },
      } });
    });
    await finalizeTaskItem(hookedWorker, lease, outcome);
    expect(hookRuns).toBe(1);
    const child = await owner.genericTask.findFirstOrThrow({ where: { parentTaskId: queued.taskId }, include: { items: true } });
    const materializedIds = child.items.map((item) => item.targetId).sort();
    expect(materializedIds).toEqual(sortedIds);
    expect(materializedIds).toContain(unreadId);
    expect(materializedIds).not.toContain(insertedId);
  });

  it("deduplicates explicit ids and rolls a failed materialization transaction back before a clean retry", async () => {
    const ids = await seedCatalogRows(owner, { channelAppId: foundation.channels[0]!.channelAppId, count: 101, prefix: "rollback" });
    const queued = await enqueueContent(normalizeCatalogSelection({ scope: "explicit_ids", ids: [ids[50]!, ...ids, ids[0]!] }));
    const lease = await claim();
    const outcome = await createCatalogBatchHandler(worker)(handlerContext(lease));
    await owner.$executeRawUnsafe(`
      CREATE FUNCTION catalog_batch_test_abort() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE inserted_count int; materialized_count int; child_id uuid;
      BEGIN
        SELECT count(*) INTO inserted_count FROM catalog_batch_new_items WHERE target_type = 'novel_source_item';
        SELECT task_id INTO child_id FROM catalog_batch_new_items WHERE target_type = 'novel_source_item' LIMIT 1;
        IF inserted_count > 50 THEN
          RAISE EXCEPTION 'catalog_batch_chunk_exceeded_50';
        END IF;
        SELECT count(*) INTO materialized_count FROM generic_task_item WHERE task_id = child_id AND target_type = 'novel_source_item';
        IF materialized_count > 50 THEN
          RAISE EXCEPTION 'catalog_batch_test_abort';
        END IF;
        RETURN NULL;
      END $$
    `);
    await owner.$executeRawUnsafe("CREATE TRIGGER catalog_batch_test_abort_trigger AFTER INSERT ON generic_task_item REFERENCING NEW TABLE AS catalog_batch_new_items FOR EACH STATEMENT EXECUTE FUNCTION catalog_batch_test_abort()")
    await expect(finalizeTaskItem(worker, lease, outcome)).rejects.toThrow("catalog_batch_test_abort");
    expect(await owner.genericTask.count({ where: { parentTaskId: queued.taskId } })).toBe(0);
    expect((await owner.genericTask.findUniqueOrThrow({ where: { id: queued.taskId }, include: { items: true } })).result).toBeNull();
    await owner.$executeRawUnsafe("DROP TRIGGER catalog_batch_test_abort_trigger ON generic_task_item")
    await owner.$executeRawUnsafe("DROP FUNCTION catalog_batch_test_abort()")
    await finalizeTaskItem(worker, lease, await createCatalogBatchHandler(worker)(handlerContext(lease)));
    const child = await owner.genericTask.findFirstOrThrow({ where: { parentTaskId: queued.taskId }, include: { items: true } });
    expect(child.items).toHaveLength(101);
    expect(new Set(child.items.map((item) => item.targetId)).size).toBe(101);
  }, 60_000);

  it("rejects a stale lease token and keeps the re-claimed snapshot writable only by its new owner", async () => {
    const ids = await seedCatalogRows(owner, { channelAppId: foundation.channels[0]!.channelAppId, count: 1, prefix: "lease" });
    const queued = await enqueueContent(normalizeCatalogSelection({ scope: "explicit_ids", ids }));
    const oldLease = await claim(CATALOG_BATCH_TASK_TYPE, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await recoverExpiredItem(worker, { family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], maxAttemptsByType: { [CATALOG_BATCH_TASK_TYPE]: 3 } }))?.action).toBe("requeued");
    const newLease = await claim();
    const oldOutcome = await createCatalogBatchHandler(worker)(handlerContext(oldLease));
    await expect(finalizeTaskItem(worker, oldLease, oldOutcome)).rejects.toThrow();
    await finalizeTaskItem(worker, newLease, await createCatalogBatchHandler(worker)(handlerContext(newLease)));
    expect(await owner.genericTask.count({ where: { parentTaskId: queued.taskId } })).toBe(1);
  });

  it("keeps promo children disabled behind the original double gate and reports invalid account/capability groups", async () => {
    const channel = foundation.channels[0]!;
    const ids = await seedCatalogRows(owner, { channelAppId: channel.channelAppId, count: 51, prefix: "promo", status: "linked" });
    await linkSources(ids);
    await owner.channelCapability.create({ data: {
      channelAppId: channel.channelAppId, capabilityKey: "claimPromo", status: "enabled",
      sideEffecting: true, evidenceLevel: "OWNER_APPROVED_WRITE_PROBE",
    } });
    delete process.env.FEATURE_PROMO_LINK_CLAIM;
    delete process.env.PROMO_LINK_CLAIM_ALLOW_WRITE;
    const acceptedAt = new Date(Date.now() - 60 * 60 * 1_000);
    const queued = await enqueueCatalogBatch(owner, {
      operation: "promo_claim", selection: normalizeCatalogSelection({ scope: "explicit_ids", ids }),
      actorId: foundation.actorId, requestId: randomUUID(), channelAccounts: { [channel.channelAppId]: channel.accountId },
    }, acceptedAt);
    await materialize(queued.taskId);
    const child = await owner.genericTask.findFirstOrThrow({ where: { parentTaskId: queued.taskId }, include: { items: true } });
    expect(child).toMatchObject({ status: "disabled", totalCount: 51 });
    expect(child.items).toHaveLength(51);
    expect((child.params as { featureFlagEnabled: boolean }).featureFlagEnabled).toBe(false);
    expect((child.params as { allowWriteEnabled: boolean }).allowWriteEnabled).toBe(false);
    expect(new Set(child.items.map((item) => (item.payload as { expiresAt: string }).expiresAt))).toEqual(new Set([new Date(acceptedAt.getTime() + 6 * 60 * 60 * 1_000).toISOString()]));
    expect(await readCatalogBatchSummary(owner, queued.taskId, foundation.actorId)).toMatchObject({ phase: "disabled", submittedCount: 51 });

    await owner.channelAccount.update({ where: { id: channel.accountId }, data: { status: "disabled" } });
    const blocked = await enqueueCatalogBatch(owner, {
      operation: "promo_claim", selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: [ids[0]!] }),
      actorId: foundation.actorId, requestId: randomUUID(), channelAccounts: { [channel.channelAppId]: channel.accountId },
    });
    await materialize(blocked.taskId);
    const blockedParent = await owner.genericTask.findUniqueOrThrow({ where: { id: blocked.taskId } });
    expect(await owner.genericTask.count({ where: { parentTaskId: blocked.taskId } })).toBe(0);
    expect(blockedParent.result).toMatchObject({ submittedCount: 0, blockedCount: 1, blockedReasonCounts: { channel_binding_or_capability_unavailable: 1 } });
    expect(await readCatalogBatchSummary(owner, blocked.taskId, foundation.actorId)).toMatchObject({ phase: "completed_with_errors" });
  });

  it("projects parent-only status filters, detail, and progress from child task counters", async () => {
    const ids = await seedCatalogRows(owner, { channelAppId: foundation.channels[0]!.channelAppId, count: 51, prefix: "admin-parent" });
    const queued = await enqueueContent(normalizeCatalogSelection({ scope: "explicit_ids", ids }));
    await materialize(queued.taskId);
    const child = await owner.genericTask.findFirstOrThrow({ where: { parentTaskId: queued.taskId }, include: { items: true } });
    const listContext = await adminContext("/api/admin/tasks");
    const active = await listAdminTasks(owner, listContext, { family: "generic", status: "processing", limit: 100 }, {} as NodeJS.ProcessEnv);
    expect(active.items.filter((item) => item.taskId === queued.taskId)).toEqual([expect.objectContaining({
      status: "processing", totalCount: 51, successCount: 0, catalogBatch: expect.objectContaining({ phase: "executing", submittedCount: 51 }),
    })]);
    expect(active.items.some((item) => item.taskId === child.id)).toBe(false);
    const detail = await getAdminTaskDetail(owner, await adminContext("/api/admin/tasks/detail"), { family: "generic", taskId: queued.taskId }, {} as NodeJS.ProcessEnv);
    expect(detail).toMatchObject({ status: "processing", totalCount: 51, catalogBatch: { phase: "executing", submittedCount: 51, ineligibleCount: 0 } });
    const progress = await getAdminTaskProgress(owner, await adminContext("/api/admin/tasks/progress"), { taskId: queued.taskId }, {} as NodeJS.ProcessEnv);
    expect(progress).toMatchObject({ status: "processing", total: 51, success: 0, failed: 0, processed: 0, percent: 0 });

    await owner.genericTaskItem.updateMany({ where: { taskId: child.id }, data: { status: "success" } });
    await owner.genericTaskItem.update({ where: { id: child.items[0]!.id }, data: { status: "failed", error: { code: "fixture_failure" } } });
    await recomputeParentTask(owner, "generic", child.id);
    const failed = await listAdminTasks(owner, listContext, { family: "generic", status: "completed_with_errors", limit: 100 }, {} as NodeJS.ProcessEnv);
    expect(failed.items.filter((item) => item.taskId === queued.taskId)).toEqual([expect.objectContaining({
      status: "completed_with_errors", totalCount: 51, successCount: 50, failedCount: 1,
      catalogBatch: expect.objectContaining({ phase: "completed_with_errors" }),
    })]);
    expect(await getAdminTaskProgress(owner, await adminContext("/api/admin/tasks/progress"), { taskId: queued.taskId }, {} as NodeJS.ProcessEnv))
      .toMatchObject({ status: "partial_failed", total: 51, success: 50, failed: 1, processed: 51, percent: 100 });
  });

  it("does not report failed enumeration as queued and preserves disabled and expired phases", async () => {
    const [id] = await seedCatalogRows(owner, { channelAppId: foundation.channels[0]!.channelAppId, count: 1, prefix: "parent-phases" });
    const failed = await enqueueContent(normalizeCatalogSelection({ scope: "explicit_ids", ids: [id!] }));
    expect(await readCatalogBatchSummary(owner, failed.taskId, foundation.actorId)).toMatchObject({ phase: "queued" });
    const failedParent = await owner.genericTask.findUniqueOrThrow({ where: { id: failed.taskId }, include: { items: true } });
    await owner.genericTaskItem.update({ where: { id: failedParent.items[0]!.id }, data: { status: "failed", error: { code: "enumeration_failed" } } });
    await recomputeParentTask(owner, "generic", failed.taskId);
    expect(await readCatalogBatchSummary(owner, failed.taskId, foundation.actorId)).toMatchObject({ phase: "failed" });

    const disabled = await enqueueCatalogBatch(owner, {
      operation: "novel_materialize", selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: [id!] }),
      actorId: foundation.actorId, requestId: randomUUID(),
    }, new Date(), false);
    expect(await readCatalogBatchSummary(owner, disabled.taskId, foundation.actorId)).toMatchObject({ phase: "disabled" });

    const expired = await enqueueContent(normalizeCatalogSelection({ scope: "explicit_ids", ids: [id!] }));
    const expiredParent = await owner.genericTask.findUniqueOrThrow({ where: { id: expired.taskId }, include: { items: true } });
    await owner.genericTask.update({ where: { id: expired.taskId }, data: { result: { enumerationStatus: "expired" } } });
    await owner.genericTaskItem.update({ where: { id: expiredParent.items[0]!.id }, data: { status: "skipped" } });
    await recomputeParentTask(owner, "generic", expired.taskId);
    expect(await readCatalogBatchSummary(owner, expired.taskId, foundation.actorId)).toMatchObject({ phase: "expired" });
  });

  it("content success queues preview atomically; CAS loser and retired protocol leave no partial business rows", async () => {
    const appId = foundation.channels[0]!.channelAppId;
    const [successId, casId, templateId] = await seedCatalogRows(owner, { channelAppId: appId, count: 3, prefix: "content" });

    const successBatch = await enqueueContent(normalizeCatalogSelection({ scope: "explicit_ids", ids: [successId!] }));
    await materialize(successBatch.taskId);
    const successLease = await claim(NOVEL_MATERIALIZE_TASK_TYPE);
    process.env.MOBOREADER_PREVIEW_SOURCE_APP_CODES = `${foundation.channels[0]!.code}-source`;
    const successOutcome = await createNovelMaterializeHandler(worker)(handlerContext(successLease));
    await finalizeTaskItem(worker, successLease, successOutcome);
    expect(await owner.novel.count()).toBe(1);
    expect(await owner.article.count()).toBe(0);
    const preview = await owner.channelSyncTask.findFirst({ where: { taskType: "moboreader.preview_refresh.v1", items: { some: { novelSourceItemId: successId } } }, include: { items: true } });
    expect(preview?.items.map((item) => item.novelSourceItemId)).toContain(successId);
    const committedCounts = {
      novels: await owner.novel.count(), articles: await owner.article.count(),
      previewTasks: await owner.channelSyncTask.count(), previewItems: await owner.channelSyncTaskItem.count(),
      childTasks: await owner.genericTask.count({ where: { parentTaskId: successBatch.taskId } }),
      genericItems: await owner.genericTaskItem.count(),
    };
    const restartedWorker = new PrismaClient({ datasourceUrl: process.env.CATALOG_BATCH_WORKER_DATABASE_URL });
    const replayError = await finalizeTaskItem(restartedWorker, successLease, successOutcome).then(() => null, (error: unknown) => error);
    await restartedWorker.$disconnect();
    expect((replayError as { name?: string })?.name).toBe("LeaseLostError");
    expect({
      novels: await owner.novel.count(), articles: await owner.article.count(),
      previewTasks: await owner.channelSyncTask.count(), previewItems: await owner.channelSyncTaskItem.count(),
      childTasks: await owner.genericTask.count({ where: { parentTaskId: successBatch.taskId } }),
      genericItems: await owner.genericTaskItem.count(),
    }).toEqual(committedCounts);

    const casBatch = await enqueueContent(normalizeCatalogSelection({ scope: "explicit_ids", ids: [casId!] }));
    await materialize(casBatch.taskId);
    const casLease = await claim(NOVEL_MATERIALIZE_TASK_TYPE);
    const casOutcome = await createNovelMaterializeHandler(worker)(handlerContext(casLease));
    await owner.$executeRawUnsafe(`CREATE FUNCTION catalog_content_cas_loser() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER catalog_content_cas_loser_trigger BEFORE UPDATE OF novel_id ON novel_source_item FOR EACH ROW WHEN (OLD.id = '${casId}'::uuid AND OLD.novel_id IS NULL AND NEW.novel_id IS NOT NULL) EXECUTE FUNCTION catalog_content_cas_loser()`);
    const casError = await finalizeTaskItem(worker, casLease, casOutcome).then(() => null, (error: unknown) => error);
    expect((casError as { constructor?: { name?: string } })?.constructor?.name).toBe("ContentCreationConflictSignal");
    await owner.$executeRawUnsafe("DROP TRIGGER catalog_content_cas_loser_trigger ON novel_source_item");
    await owner.$executeRawUnsafe("DROP FUNCTION catalog_content_cas_loser()");
    expect(await owner.novel.count()).toBe(1);
    expect(await owner.article.count()).toBe(0);
    expect((await owner.novelSourceItem.findUniqueOrThrow({ where: { id: casId } })).novelId).toBeNull();

    const legacyBatch = await enqueueCatalogBatch(owner, {
      operation: "content_create", selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: [templateId!] }),
      actorId: foundation.actorId, requestId: randomUUID(), templateKeysByLocale: { en: "system-default-v1" },
    });
    await materialize(legacyBatch.taskId);
    const legacyParent = await owner.genericTask.findUniqueOrThrow({ where: { id: legacyBatch.taskId } });
    expect(legacyParent.status).toBe("failed");
    expect(await owner.genericTask.count({ where: { parentTaskId: legacyBatch.taskId } })).toBe(0);
    expect(await owner.novel.count()).toBe(1);
    expect(await owner.article.count()).toBe(0);
    expect((await owner.novelSourceItem.findUniqueOrThrow({ where: { id: templateId } })).novelId).toBeNull();
  });
});
