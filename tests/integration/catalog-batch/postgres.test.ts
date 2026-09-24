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
import { PROMO_LINK_CLAIM_CAPABILITY_KEY } from "@/lib/tasks/promo-link-claim-limits";
import { buildPromoLinkIdempotencyKey, UPSTREAM_EXISTING_PROMO_OFFER_TYPE } from "@/lib/tasks/promo-link-claim";
import { createPublicRedirectCode } from "@/lib/redirect";
import { prepareSideEffectIntent, transitionSideEffectIntent } from "@/lib/tasks/side-effect-intent";
import { PROMO_CLAIM_INTENT_OPERATION_TYPE } from "@/lib/tasks/promo-claim-release";
import { readSourceItemsPage } from "@/app/(admin)/catalog-sync/_lib/read-source-items";
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
// B-4 (施工提示词_Sonnet_B4_目录同步页推广链接状态筛选_2026-09-24): the
// first test in this file to actually exercise `readSourceItemsPage` under
// the real `web_app` role -- this env var has existed on the verification
// script since before this task, but nothing used it (the page previously
// only ever touched `novel_source_item`/`generic_task_item`, both already
// covered by other tests). `promo_link`/`side_effect_intent` are new reads
// for this role, so this is the actual grants-sufficiency proof, not just a
// correctness proof.
const web = new PrismaClient({ datasourceUrl: process.env.CATALOG_BATCH_WEB_DATABASE_URL });
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

/** Same as `linkSources`, but for exactly one id and returns the new `novelId` -- B-4's PromoLink fixtures need it for the required `novelId` FK. */
async function linkSource(id: string): Promise<string> {
  const novel = await owner.novel.create({ data: {
    businessId: `catalog-promo-status-${randomUUID()}`, title: "Promo status fixture", description: "Promo status fixture",
    locale: "en", slug: `catalog-promo-status-${randomUUID()}`,
  } });
  await owner.novelSourceItem.update({ where: { id }, data: { novelId: novel.id, status: "linked" } });
  return novel.id;
}

function hex64(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

/** B-4: seeds a `fetched` PromoLink -- the "已有推广码" state `promoLinkStatusIdConstraint`/`classifyPromoLinkRowStatus` (`@/lib/tasks/promo-link-status-filter`) detect. */
async function seedFetchedPromoLink(input: { novelSourceItemId: string; novelId: string; channelAppId: string; channelAccountId: string }): Promise<void> {
  await owner.promoLink.create({ data: {
    id: randomUUID(),
    novelId: input.novelId,
    novelSourceItemId: input.novelSourceItemId,
    channelAppId: input.channelAppId,
    channelAccountId: input.channelAccountId,
    offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE,
    publicRedirectCode: createPublicRedirectCode(),
    idempotencyKey: buildPromoLinkIdempotencyKey({
      channelAppId: input.channelAppId, novelSourceItemId: input.novelSourceItemId,
      channelAccountId: input.channelAccountId, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE,
    }),
    status: "fetched",
  } });
}

/**
 * B-4: seeds a `manual_review_required` `side_effect_intent` -- the "人工核对中"
 * state. `manual_review_required` is only reachable from `claim_retry_blocked`
 * (`isAllowedSideEffectTransition`, `src/lib/tasks/side-effect-intent.ts`),
 * so this drives an intent through the same two transitions
 * `worker/handlers/promo-link-claim.ts` does, rather than inventing a
 * shortcut into the terminal status.
 */
async function seedManualReviewIntent(input: { novelSourceItemId: string; channelAppId: string; channelAccountId: string }): Promise<void> {
  const effectKey = hex64();
  const idempotencyKey = buildPromoLinkIdempotencyKey({
    channelAppId: input.channelAppId, novelSourceItemId: input.novelSourceItemId,
    channelAccountId: input.channelAccountId, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE,
  });
  await prepareSideEffectIntent(owner, {
    effectKey,
    operationType: PROMO_CLAIM_INTENT_OPERATION_TYPE,
    idempotencyKey,
    targetType: "promo_link",
    targetId: idempotencyKey,
    channelAppId: input.channelAppId,
    channelAccountId: input.channelAccountId,
    requestSummary: { offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE, novelSourceItemId: input.novelSourceItemId },
  });
  await transitionSideEffectIntent(owner, { effectKey, status: "claim_retry_blocked" });
  await transitionSideEffectIntent(owner, { effectKey, status: "manual_review_required" });
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
  afterAll(async () => Promise.all([owner.$disconnect(), worker.$disconnect(), web.$disconnect()]));

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
    expect(parent.params).toMatchObject({ selection, enumEligibilityPolicyVersion: 2 });
    expect(parent.items[0]!.payload).toMatchObject({ selection, enumEligibilityPolicyVersion: 2 });
    expect((parent.params as { inputFingerprint: string }).inputFingerprint).toBe(
      createHash("sha256").update(JSON.stringify({
        operation: "novel_materialize",
        selection,
        actorId: foundation.actorId,
        requestId,
      })).digest("hex"),
    );
    expect(JSON.stringify((parent.params as { selection: unknown }).selection)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    expect(await owner.operationAudit.findFirstOrThrow({ where: {
      taskId: first.taskId,
      action: "catalog_batch.queued",
    } })).toMatchObject({ afterSnapshot: expect.objectContaining({ enumEligibilityPolicyVersion: 2 }) });
  });

  it.each([
    { enumEligibilityPolicyVersion: 1 },
    { enumEligibilityPolicyVersion: 2 },
    { enumEligibilityPolicyVersion: 99, unknownMetadata: "must-not-affect-fingerprint" },
  ])("ignores runtime-only enqueue metadata %# when selecting policy and fingerprinting", async (metadata) => {
    const selection = normalizeCatalogSelection({ scope: "explicit_ids", ids: [randomUUID()] });
    const requestId = randomUUID();
    const businessInput = {
      operation: "novel_materialize" as const,
      selection,
      actorId: foundation.actorId,
      requestId,
    };
    const first = await enqueueCatalogBatch(owner, { ...businessInput, ...metadata } as typeof businessInput);
    const replay = await enqueueCatalogBatch(owner, businessInput);
    expect(replay).toMatchObject({ taskId: first.taskId, duplicate: true });

    const parent = await owner.genericTask.findUniqueOrThrow({ where: { id: first.taskId } });
    expect(parent.params).toMatchObject({ enumEligibilityPolicyVersion: 2 });
    expect(parent.params).not.toHaveProperty("unknownMetadata");
    expect((parent.params as { inputFingerprint: string }).inputFingerprint).toBe(
      createHash("sha256").update(JSON.stringify(businessInput)).digest("hex"),
    );
  });

  it("v2 blocks known locale failures before child creation and preserves mutually exclusive counts", async () => {
    const channelAppId = foundation.channels[0]!.channelAppId;
    const [eligibleId] = await seedCatalogRows(owner, { channelAppId, count: 1, prefix: "locale-eligible" });
    const [missingId] = await seedCatalogRows(owner, { channelAppId, count: 1, prefix: "locale-missing", sourceLocale: null });
    const [unsupportedId] = await seedCatalogRows(owner, { channelAppId, count: 1, prefix: "locale-unsupported", sourceLocale: "it" });
    const [ineligibleId] = await seedCatalogRows(owner, {
      channelAppId, count: 1, prefix: "locale-ineligible", status: "ignored", sourceLocale: "it",
    });
    const [alreadyLinkedId] = await seedCatalogRows(owner, {
      channelAppId, count: 1, prefix: "locale-linked", sourceLocale: null,
    });
    await linkSources([alreadyLinkedId!]);
    const missingSelectionId = randomUUID();
    const queued = await enqueueContent(normalizeCatalogSelection({
      scope: "explicit_ids",
      ids: [eligibleId!, missingId!, unsupportedId!, ineligibleId!, alreadyLinkedId!, missingSelectionId],
    }));

    await materialize(queued.taskId);

    const parent = await owner.genericTask.findUniqueOrThrow({ where: { id: queued.taskId } });
    const children = await owner.genericTask.findMany({
      where: { parentTaskId: queued.taskId },
      include: { items: true },
    });
    expect(children).toHaveLength(1);
    expect(children[0]!.items.map((item) => item.targetId)).toEqual([eligibleId]);
    expect(parent.result).toMatchObject({
      enumEligibilityPolicyVersion: 2,
      selectedCount: 6,
      submittedCount: 1,
      ineligibleCount: 2,
      alreadyLinkedCount: 1,
      blockedCount: 2,
      blockedReasonCounts: { missing_locale: 1, unsupported_locale: 1 },
      childTaskCount: 1,
    });
    const result = parent.result as {
      selectedCount: number;
      submittedCount: number;
      ineligibleCount: number;
      alreadyLinkedCount: number;
      blockedCount: number;
    };
    expect(result.selectedCount).toBe(
      result.submittedCount + result.ineligibleCount + result.alreadyLinkedCount + result.blockedCount,
    );
    expect(await owner.operationAudit.findFirstOrThrow({ where: {
      taskId: queued.taskId,
      action: "catalog_batch.materialized",
    } })).toMatchObject({ afterSnapshot: expect.objectContaining({
      enumEligibilityPolicyVersion: 2,
      blockedReasonCounts: { missing_locale: 1, unsupported_locale: 1 },
    }) });
    expect(await readCatalogBatchSummary(owner, queued.taskId, foundation.actorId)).toMatchObject({
      phase: "executing",
      submittedCount: 1,
      ineligibleCount: 2,
      blockedCount: 2,
    });
    await owner.genericTaskItem.updateMany({ where: { taskId: children[0]!.id }, data: { status: "success" } });
    await recomputeParentTask(owner, "generic", children[0]!.id);
    expect(await readCatalogBatchSummary(owner, queued.taskId, foundation.actorId)).toMatchObject({
      phase: "completed_with_errors",
      submittedCount: 1,
      ineligibleCount: 2,
      blockedCount: 2,
    });
  });

  it("v2 completes an all-blocked batch with no child tasks and an error-bearing summary", async () => {
    const channelAppId = foundation.channels[0]!.channelAppId;
    const missingIds = await seedCatalogRows(owner, {
      channelAppId, count: 2, prefix: "all-blocked-missing", sourceLocale: null,
    });
    const unsupportedIds = await seedCatalogRows(owner, {
      channelAppId, count: 2, prefix: "all-blocked-unsupported", sourceLocale: "fil",
    });
    const queued = await enqueueContent(normalizeCatalogSelection({
      scope: "explicit_ids", ids: [...missingIds, ...unsupportedIds],
    }));

    await materialize(queued.taskId);

    expect(await owner.genericTask.count({ where: { parentTaskId: queued.taskId } })).toBe(0);
    expect(await owner.genericTask.findUniqueOrThrow({ where: { id: queued.taskId } })).toMatchObject({
      status: "completed",
      result: expect.objectContaining({
        submittedCount: 0,
        blockedCount: 4,
        blockedReasonCounts: { missing_locale: 2, unsupported_locale: 2 },
        childTaskCount: 0,
      }),
    });
    expect(await readCatalogBatchSummary(owner, queued.taskId, foundation.actorId)).toMatchObject({
      phase: "completed_with_errors",
      submittedCount: 0,
      blockedCount: 4,
    });

    await owner.novelSourceItem.update({ where: { id: missingIds[0]! }, data: { sourceLocale: "en" } });
    expect(await owner.genericTask.count({ where: { parentTaskId: queued.taskId } })).toBe(0);
    const repaired = await enqueueContent(normalizeCatalogSelection({
      scope: "explicit_ids", ids: [missingIds[0]!],
    }));
    await materialize(repaired.taskId);
    expect(await owner.genericTask.findFirstOrThrow({ where: { parentTaskId: repaired.taskId } })).toMatchObject({
      totalCount: 1,
    });
  });

  it("treats a historical versionless materialization payload as v1 and replays its requestId", async () => {
    const channelAppId = foundation.channels[0]!.channelAppId;
    const [sourceId] = await seedCatalogRows(owner, {
      channelAppId, count: 1, prefix: "historical-v1", sourceLocale: null,
    });
    const selection = normalizeCatalogSelection({ scope: "explicit_ids", ids: [sourceId!] });
    const requestId = randomUUID();
    const queued = await enqueueContent(selection, requestId);
    const parent = await owner.genericTask.findUniqueOrThrow({
      where: { id: queued.taskId }, include: { items: true },
    });
    const params = { ...(parent.params as Record<string, unknown>) };
    const itemPayload = { ...(parent.items[0]!.payload as Record<string, unknown>) };
    delete params.enumEligibilityPolicyVersion;
    delete itemPayload.enumEligibilityPolicyVersion;
    await owner.genericTask.update({ where: { id: queued.taskId }, data: { params: params as Prisma.InputJsonObject } });
    await owner.genericTaskItem.update({
      where: { id: parent.items[0]!.id }, data: { payload: itemPayload as Prisma.InputJsonObject },
    });

    expect(await enqueueContent(selection, requestId)).toMatchObject({ taskId: queued.taskId, duplicate: true });
    await materialize(queued.taskId);

    const child = await owner.genericTask.findFirstOrThrow({
      where: { parentTaskId: queued.taskId }, include: { items: true },
    });
    expect(child.items.map((item) => item.targetId)).toEqual([sourceId]);
    expect(await owner.genericTask.findUniqueOrThrow({ where: { id: queued.taskId } })).toMatchObject({
      result: expect.objectContaining({
        enumEligibilityPolicyVersion: 1,
        submittedCount: 1,
        blockedCount: 0,
      }),
    });
  });

  it("keeps the core locale gate when source facts change after v2 enumeration", async () => {
    const channelAppId = foundation.channels[0]!.channelAppId;
    const [sourceId] = await seedCatalogRows(owner, {
      channelAppId, count: 1, prefix: "locale-race", sourceLocale: "en",
    });
    const queued = await enqueueContent(normalizeCatalogSelection({
      scope: "explicit_ids", ids: [sourceId!],
    }));
    await materialize(queued.taskId);
    await owner.novelSourceItem.update({ where: { id: sourceId! }, data: { sourceLocale: null } });

    const childLease = await claim(NOVEL_MATERIALIZE_TASK_TYPE);
    const childOutcome = await createNovelMaterializeHandler(worker)(handlerContext(childLease));
    await expect(finalizeTaskItem(worker, childLease, childOutcome)).rejects.toMatchObject({
      code: "missing_locale",
    });
    expect(await owner.novel.count()).toBe(0);
    expect(await owner.novelSourceItem.findUniqueOrThrow({ where: { id: sourceId! } })).toMatchObject({
      status: "pending",
      novelId: null,
    });
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
    expect(await owner.genericTask.findUniqueOrThrow({ where: { id: queued.taskId } })).toMatchObject({
      params: expect.objectContaining({ enumEligibilityPolicyVersion: 1 }),
    });
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

  // -------------------------------------------------------------------
  // B-4（施工提示词_Sonnet_B4_目录同步页推广链接状态筛选_2026-09-24）：
  // 目录同步页新增的"推广链接状态"筛选（未领取/已领取/人工核对中）。
  // -------------------------------------------------------------------

  /**
   * Seeds, per locale (`en`/`ja`): one `linked` book with a `fetched`
   * PromoLink ("已领取"), one `linked` book with a `manual_review_required`
   * intent and no PromoLink ("人工核对中"), two `linked` books with neither
   * ("未领取"), and one still-`pending` (never linked) book -- the last one
   * proves the `status` filter's intersection with `promoLinkStatus` really
   * excludes unlinked books, rather than the promo-link-status filter
   * accidentally treating them as "未领取" too.
   */
  async function seedPromoLinkStatusFixture() {
    const channel = foundation.channels[0]!;
    await owner.channelCapability.create({ data: {
      channelAppId: channel.channelAppId, capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY, status: "enabled",
      sideEffecting: true, evidenceLevel: "OWNER_APPROVED_WRITE_PROBE",
    } });
    const ids: Record<string, string> = {};
    for (const locale of ["en", "ja"] as const) {
      const [claimedId] = await seedCatalogRows(owner, { channelAppId: channel.channelAppId, count: 1, prefix: `pls-${locale}-claimed`, sourceLocale: locale });
      const [manualId] = await seedCatalogRows(owner, { channelAppId: channel.channelAppId, count: 1, prefix: `pls-${locale}-manual`, sourceLocale: locale });
      const freeIds = await seedCatalogRows(owner, { channelAppId: channel.channelAppId, count: 2, prefix: `pls-${locale}-free`, sourceLocale: locale });
      const [pendingId] = await seedCatalogRows(owner, { channelAppId: channel.channelAppId, count: 1, prefix: `pls-${locale}-pending`, sourceLocale: locale });

      const claimedNovelId = await linkSource(claimedId!);
      await seedFetchedPromoLink({ novelSourceItemId: claimedId!, novelId: claimedNovelId, channelAppId: channel.channelAppId, channelAccountId: channel.accountId });

      await linkSource(manualId!);
      await seedManualReviewIntent({ novelSourceItemId: manualId!, channelAppId: channel.channelAppId, channelAccountId: channel.accountId });

      await linkSources(freeIds);
      // pendingId is deliberately left unlinked (status stays "pending").

      ids[`${locale}-claimed`] = claimedId!;
      ids[`${locale}-manual`] = manualId!;
      ids[`${locale}-free`] = freeIds.join(",");
      ids[`${locale}-pending`] = pendingId!;
    }
    return { channel, ids };
  }

  it("推广链接状态三态互斥、覆盖全部，并与 status/sourceLocale 取交集 (web_app role)", async () => {
    const { ids } = await seedPromoLinkStatusFixture();
    const enFreeIds = ids["en-free"]!.split(",");

    const claimed = await readSourceItemsPage({ status: "linked", sourceLocale: "en", promoLinkStatus: "claimed" }, web);
    expect(claimed.items.map((item) => item.id)).toEqual([ids["en-claimed"]]);
    expect(claimed.items[0]).toMatchObject({ promoClaimEligible: false, promoClaimIneligibleReason: "already_has_promo_code" });

    const manualReview = await readSourceItemsPage({ status: "linked", sourceLocale: "en", promoLinkStatus: "manual_review" }, web);
    expect(manualReview.items.map((item) => item.id)).toEqual([ids["en-manual"]]);
    expect(manualReview.items[0]).toMatchObject({ promoClaimEligible: false, promoClaimIneligibleReason: "manual_review_pending" });

    const notClaimed = await readSourceItemsPage({ status: "linked", sourceLocale: "en", promoLinkStatus: "not_claimed" }, web);
    expect(new Set(notClaimed.items.map((item) => item.id))).toEqual(new Set(enFreeIds));
    for (const item of notClaimed.items) {
      expect(item).toMatchObject({ promoClaimEligible: true, promoClaimIneligibleReason: null });
    }

    // Mutual exclusivity + completeness, intersected with status=linked: the
    // three buckets, summed, equal every `linked` `en` row -- the unlinked
    // `en-pending` row must not appear in any bucket or in the unfiltered
    // "linked" total, proving the `status` intersection actually excludes it.
    const allLinkedEn = await readSourceItemsPage({ status: "linked", sourceLocale: "en" }, web);
    expect(allLinkedEn.total).toBe(4);
    expect(claimed.total + manualReview.total + notClaimed.total).toBe(allLinkedEn.total);
    expect(allLinkedEn.items.map((item) => item.id)).not.toContain(ids["en-pending"]);

    // sourceLocale intersection: the `ja` claimed book must not leak into
    // the `en`-scoped "claimed" bucket (already implied by the exact
    // `toEqual` above; asserted again explicitly for clarity).
    expect(claimed.items.map((item) => item.id)).not.toContain(ids["ja-claimed"]);
  });

  it("一个还没到 fetched 的 PromoLink（例如 status=pending）不算已领取——判定必须看 status，不能只看'存在 PromoLink 行'", async () => {
    const channel = foundation.channels[0]!;
    const [id] = await seedCatalogRows(owner, { channelAppId: channel.channelAppId, count: 1, prefix: "pls-pending-link", sourceLocale: "en" });
    const novelId = await linkSource(id!);
    // A PromoLink row exists, but its status is still "pending" (upstream
    // call not resolved yet) -- this must NOT be counted as "已领取". Only a
    // real Postgres query (not a mocked `findMany`) can catch a mutation
    // that drops the `status: "fetched"` condition from the WHERE clause,
    // since a mock ignores its call args and just returns canned rows.
    await owner.promoLink.create({ data: {
      id: randomUUID(), novelId, novelSourceItemId: id!, channelAppId: channel.channelAppId, channelAccountId: channel.accountId,
      offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE, publicRedirectCode: createPublicRedirectCode(),
      idempotencyKey: buildPromoLinkIdempotencyKey({ channelAppId: channel.channelAppId, novelSourceItemId: id!, channelAccountId: channel.accountId, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE }),
      status: "pending",
    } });

    const claimed = await readSourceItemsPage({ status: "linked", promoLinkStatus: "claimed" }, web);
    expect(claimed.items.map((item) => item.id)).not.toContain(id);
    const notClaimed = await readSourceItemsPage({ status: "linked", promoLinkStatus: "not_claimed" }, web);
    expect(notClaimed.items.map((item) => item.id)).toContain(id);
    const page = await readSourceItemsPage({ status: "linked" }, web);
    expect(page.items.find((item) => item.id === id)).toMatchObject({ promoClaimEligible: true, promoClaimIneligibleReason: null });
  });

  it("一个还没进入人工核对的 side_effect_intent（status=prepared，尚未转态）不算人工核对中——判定必须看 status，不能只看'存在同 operation_type 的意图记录'", async () => {
    const channel = foundation.channels[0]!;
    const [id] = await seedCatalogRows(owner, { channelAppId: channel.channelAppId, count: 1, prefix: "pls-prepared-intent", sourceLocale: "en" });
    await linkSource(id!);
    const idempotencyKey = buildPromoLinkIdempotencyKey({ channelAppId: channel.channelAppId, novelSourceItemId: id!, channelAccountId: channel.accountId, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE });
    // Prepared but never transitioned -- the claim attempt has not (yet)
    // been decided as needing manual review. Only a real Postgres query
    // (not a mocked `$queryRaw`) can catch a mutation that drops the
    // `status = 'manual_review_required'` condition from the SQL, since a
    // mock ignores its call args and just returns canned rows.
    await prepareSideEffectIntent(owner, {
      effectKey: hex64(), operationType: PROMO_CLAIM_INTENT_OPERATION_TYPE, idempotencyKey,
      targetType: "promo_link", targetId: idempotencyKey,
      channelAppId: channel.channelAppId, channelAccountId: channel.accountId,
      requestSummary: { offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE, novelSourceItemId: id },
    });

    const manualReview = await readSourceItemsPage({ status: "linked", promoLinkStatus: "manual_review" }, web);
    expect(manualReview.items.map((item) => item.id)).not.toContain(id);
    const notClaimed = await readSourceItemsPage({ status: "linked", promoLinkStatus: "not_claimed" }, web);
    expect(notClaimed.items.map((item) => item.id)).toContain(id);
  });

  it("一本书先进入人工核对、后来重试拿到码 -> 只算已领取，不再算人工核对中 (claimed 优先)", async () => {
    const channel = foundation.channels[0]!;
    const [id] = await seedCatalogRows(owner, { channelAppId: channel.channelAppId, count: 1, prefix: "pls-retried", sourceLocale: "en" });
    const novelId = await linkSource(id!);
    await seedManualReviewIntent({ novelSourceItemId: id!, channelAppId: channel.channelAppId, channelAccountId: channel.accountId });
    await seedFetchedPromoLink({ novelSourceItemId: id!, novelId, channelAppId: channel.channelAppId, channelAccountId: channel.accountId });

    const claimed = await readSourceItemsPage({ status: "linked", promoLinkStatus: "claimed" }, web);
    expect(claimed.items.map((item) => item.id)).toContain(id);
    const manualReview = await readSourceItemsPage({ status: "linked", promoLinkStatus: "manual_review" }, web);
    expect(manualReview.items.map((item) => item.id)).not.toContain(id);
  });

  it(
    "全选一致性：全选 + 未领取 + en 提交后，worker 枚举入片的书恰好等于界面筛选结果（有码书/人工核对书零入片）(worker_app role)",
    async () => {
      const { channel, ids } = await seedPromoLinkStatusFixture();
      const enFreeIds = new Set(ids["en-free"]!.split(","));
      process.env.FEATURE_PROMO_LINK_CLAIM = "true";
      process.env.PROMO_LINK_CLAIM_ALLOW_WRITE = "true";

      const listed = await readSourceItemsPage({ status: "linked", sourceLocale: "en", promoLinkStatus: "not_claimed", pageSize: "50" }, web);
      expect(new Set(listed.items.map((item) => item.id))).toEqual(enFreeIds);

      const selection = normalizeCatalogSelection({
        scope: "all_filtered",
        filter: { status: "linked", sourceLocale: "en", promoLinkStatus: "not_claimed" },
      });
      const enqueued = await enqueueCatalogBatch(owner, {
        operation: "promo_claim", selection, actorId: foundation.actorId, requestId: randomUUID(),
        channelAccounts: { [channel.channelAppId]: channel.accountId },
      });
      await materialize(enqueued.taskId);

      const parent = await owner.genericTask.findUniqueOrThrow({ where: { id: enqueued.taskId } });
      expect(parent.result).toMatchObject({ enumerationStatus: "completed", submittedCount: enFreeIds.size });

      const child = await owner.genericTask.findFirstOrThrow({ where: { parentTaskId: enqueued.taskId }, include: { items: true } });
      const enumeratedIds = new Set(child.items.map((item) => item.targetId));
      expect(enumeratedIds).toEqual(enFreeIds);
      expect(enumeratedIds.has(ids["en-claimed"]!)).toBe(false);
      expect(enumeratedIds.has(ids["en-manual"]!)).toBe(false);
      expect(enumeratedIds.has(ids["ja-claimed"]!)).toBe(false);
      expect(enumeratedIds.has(ids["en-pending"]!)).toBe(false);
    },
  );

  it("旧的 selection 负载（没有 promoLinkStatus 字段）向后兼容——等价于'全部'，枚举不做任何推广链接状态 narrowing", async () => {
    const { channel, ids } = await seedPromoLinkStatusFixture();
    process.env.FEATURE_PROMO_LINK_CLAIM = "true";
    process.env.PROMO_LINK_CLAIM_ALLOW_WRITE = "true";

    // No `promoLinkStatus` at all -- simulates a selection persisted before
    // this field existed (or a stale client not yet redeployed).
    const selection = normalizeCatalogSelection({ scope: "all_filtered", filter: { status: "linked", sourceLocale: "en" } });
    expect(selection).toMatchObject({ scope: "all_filtered", filter: { status: "linked", sourceLocale: "en" } });
    if (selection.scope === "all_filtered") expect(selection.filter).not.toHaveProperty("promoLinkStatus");

    const enqueued = await enqueueCatalogBatch(owner, {
      operation: "promo_claim", selection, actorId: foundation.actorId, requestId: randomUUID(),
      channelAccounts: { [channel.channelAppId]: channel.accountId },
    });
    await materialize(enqueued.taskId);

    const child = await owner.genericTask.findFirstOrThrow({ where: { parentTaskId: enqueued.taskId }, include: { items: true } });
    const enumeratedIds = new Set(child.items.map((item) => item.targetId));
    // All 4 `en` linked rows (1 claimed + 1 manual review + 2 free) are
    // eligible per the pre-existing `status === "linked" && novelId !== null`
    // check -- an absent `promoLinkStatus` must not narrow this at all.
    expect(enumeratedIds).toEqual(new Set([ids["en-claimed"], ids["en-manual"], ...ids["en-free"]!.split(",")]));
  });
});
