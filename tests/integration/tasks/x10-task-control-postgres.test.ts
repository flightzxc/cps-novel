import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimPendingItem,
  finalizeTaskItem,
  PROMO_LINK_CLAIM_TASK_TYPE,
} from "@/lib/tasks";
import {
  abortTask,
  pauseTask,
  resumeTask,
  TASK_ABORT_TERMINATION_REASON,
  TaskAdminError,
} from "@/server/task-admin";
import { maybeHaltTaskOnGlobalFailure } from "../../../worker/handlers/promo-link-claim-system-hold";

import {
  issueTaskAuthorization,
  newStores,
  NOW,
  seedTaskAdmin,
} from "../../backend/task-admin/test-support";

/**
 * X10 task control (pause/resume/abort) — formal statuses
 * (`20260916090000_x10_task_control_paused_cancelled`) against a disposable,
 * real PostgreSQL 16.14. The Owner explicitly required this suite before
 * local UAT.
 *
 * `tests/integration/README.md` claims "Owner: Codex（独占写入）" for this
 * whole directory. This file is added anyway, on the Owner's explicit
 * instruction in this task's brief — see the delivery report for the
 * pointer back to that instruction.
 *
 * Gated the same way every other `*_DATABASE_TEST`-style suite in this repo
 * is (see `tests/integration/tasks/p1-13-postgres-acceptance.test.ts`): a
 * no-op under plain `npm test` (no live Postgres needed), and only runs
 * against a real, disposable instance when explicitly asked. See this
 * file's own header comment / the delivery report for the exact
 * docker run / prisma migrate deploy / env var incantation to reproduce it.
 */
const enabled = process.env.X10_TASK_CONTROL_DATABASE_TEST === "1";
const prisma = new PrismaClient();

function freshScopeHash(): string {
  return randomUUID().replaceAll("-", "").padEnd(64, "0");
}

async function truncateDatabase() {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

type Foundation = Readonly<{
  channelId: string;
  sourceAppId: string;
  channelAppId: string;
  accountId: string;
}>;

async function seedFoundation(): Promise<Foundation> {
  const channel = await prisma.channel.create({
    data: { code: `x10-channel-${randomUUID()}`, name: "X10 Channel" },
  });
  const sourceApp = await prisma.sourceApp.create({
    data: { code: `x10-source-${randomUUID()}`, name: "X10 Source" },
  });
  const channelApp = await prisma.channelApp.create({
    data: {
      channelId: channel.id,
      sourceAppId: sourceApp.id,
      externalAppId: `x10-app-${randomUUID()}`,
      projectType: 2,
    },
  });
  const account = await prisma.channelAccount.create({
    data: {
      channelId: channel.id,
      businessId: `x10-account-${randomUUID()}`,
      accountName: "X10 Account",
    },
  });
  return {
    channelId: channel.id,
    sourceAppId: sourceApp.id,
    channelAppId: channelApp.id,
    accountId: account.id,
  };
}

async function seedNovelSourceItem(foundation: Foundation): Promise<string> {
  const item = await prisma.novelSourceItem.create({
    data: {
      channelAppId: foundation.channelAppId,
      externalBookId: `x10-book-${randomUUID()}`,
      sourceLanguageCode: "en",
      title: "X10 Book",
      description: "",
      rawPayload: {},
    },
  });
  return item.id;
}

/** An "active but never validated" credential is `not_ready` for a resume precondition recheck (`credential_never_validated`). */
async function seedCredential(
  foundation: Foundation,
  overrides: { lastValidatedAt?: Date | null; status?: string } = {},
): Promise<string> {
  const credential = await prisma.channelAccountCredential.create({
    data: {
      channelAccountId: foundation.accountId,
      encryptedSecret: Buffer.from("x10-test-ciphertext-not-a-real-secret"),
      keyVersion: 1,
      secretFingerprint: randomUUID(),
      fingerprintPrefix: "x10test",
      status: overrides.status ?? "active",
      lastValidatedAt: overrides.lastValidatedAt === undefined ? NOW : overrides.lastValidatedAt,
    },
  });
  return credential.id;
}

async function createGenericTask(input: {
  taskType: string;
  channelAccountId?: string | null;
  channelAppId?: string | null;
  itemCount: number;
}): Promise<{ taskId: string; itemIds: string[] }> {
  const task = await prisma.genericTask.create({
    data: {
      taskType: input.taskType,
      channelAccountId: input.channelAccountId ?? null,
      channelAppId: input.channelAppId ?? null,
      operationScopeHash: freshScopeHash(),
      requestToken: randomUUID(),
      totalCount: input.itemCount,
      items: {
        create: Array.from({ length: input.itemCount }, () => ({
          targetType: "x10.acceptance",
          targetId: randomUUID(),
          payload: {},
        })),
      },
    },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  return { taskId: task.id, itemIds: task.items.map((item) => item.id) };
}

async function createChannelSyncTask(
  foundation: Foundation,
  novelSourceItemIds: readonly string[],
): Promise<{ taskId: string }> {
  const task = await prisma.channelSyncTask.create({
    data: {
      taskType: "x10.channel_sync.acceptance",
      channelAccountId: foundation.accountId,
      channelAppId: foundation.channelAppId,
      operationScopeHash: freshScopeHash(),
      requestToken: randomUUID(),
      mode: "apply",
      totalCount: novelSourceItemIds.length,
      items: {
        create: novelSourceItemIds.map((novelSourceItemId) => ({ novelSourceItemId })),
      },
    },
  });
  return { taskId: task.id };
}

async function genericTaskStatus(taskId: string): Promise<string> {
  const task = await prisma.genericTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } });
  return task.status;
}

async function channelSyncTaskStatus(taskId: string): Promise<string> {
  const task = await prisma.channelSyncTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } });
  return task.status;
}

async function genericItemStatus(itemId: string): Promise<string> {
  const item = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: itemId }, select: { status: true } });
  return item.status;
}

/** A fresh admin ticket for one of the three control mutations, backed by an in-memory identity/session store — only `db` below is the real disposable Postgres. */
async function ticketFor(pathname: "/api/admin/tasks/pause" | "/api/admin/tasks/resume" | "/api/admin/tasks/abort") {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname });
  return { ...ticket, admin, dependencies: { db: prisma, identities: stores, sessions: stores, now: NOW } };
}

describe.skipIf(!enabled).sequential("X10 task control — PostgreSQL acceptance", () => {
  let foundation: Foundation;

  beforeAll(async () => {
    const [database] = await prisma.$queryRawUnsafe<Array<{ name: string; version: string }>>(
      "SELECT current_database() AS name, current_setting('server_version') AS version",
    );
    if (!database.name.includes("taskctl")) {
      throw new Error(`Refusing X10 task-control setup against ${database.name}`);
    }
    if (!database.version.startsWith("16.14")) {
      throw new Error(`PostgreSQL 16.14 required, got ${database.version}`);
    }
  });

  beforeEach(async () => {
    await truncateDatabase();
    foundation = await seedFoundation();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("migrated CHECK: accepts 'paused' and 'cancelled' on both tables, and still rejects a bogus value", async () => {
    const { taskId: genericId } = await createGenericTask({ taskType: "x10.acceptance", itemCount: 1 });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE generic_task SET status = 'paused' WHERE id = '${genericId}'`),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE generic_task SET status = 'cancelled' WHERE id = '${genericId}'`),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE generic_task SET status = 'not_a_real_status' WHERE id = '${genericId}'`),
    ).rejects.toThrow(/violates check constraint "generic_task_status_check"/);

    const sourceItemId = await seedNovelSourceItem(foundation);
    const { taskId: channelSyncId } = await createChannelSyncTask(foundation, [sourceItemId]);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE channel_sync_task SET status = 'paused' WHERE id = '${channelSyncId}'`),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE channel_sync_task SET status = 'cancelled' WHERE id = '${channelSyncId}'`),
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE channel_sync_task SET status = 'not_a_real_status' WHERE id = '${channelSyncId}'`),
    ).rejects.toThrow(/violates check constraint "channel_sync_task_status_check"/);
  });

  it("pause: stops leasing new items, leaves pending items exactly pending, and the in-flight item finishes normally without the recompute guard flipping the parent back to processing", async () => {
    const { taskId, itemIds } = await createGenericTask({ taskType: "x10.acceptance", itemCount: 2 });
    // Both items land in the same `create: [...]` batch and so share one
    // `created_at` -- `selectPending`'s `ORDER BY i.created_at, i.id` then
    // ties on random UUID ordering, not array/insertion order. Pin the
    // claim to a specific known item id instead of assuming which one a
    // plain, untargeted claim would pick.
    const [itemA, itemB] = itemIds;
    const lease = await claimPendingItem(prisma, {
      family: "generic",
      taskTypes: ["x10.acceptance"],
      workerId: "x10-worker",
      leaseMs: 60_000,
      claimTarget: { family: "generic", taskId, itemId: itemA },
    });
    expect(lease?.itemId).toBe(itemA);
    expect(await genericTaskStatus(taskId)).toBe("processing");

    const ticket = await ticketFor("/api/admin/tasks/pause");
    const result = await pauseTask(
      { ...ticket, family: "generic", taskId, reason: "x10 acceptance pause" },
      ticket.dependencies,
    );
    expect(result).toMatchObject({ status: "paused", wrote: true });
    expect(await genericTaskStatus(taskId)).toBe("paused");
    // Pause leaves every still-pending item exactly pending -- never skipped.
    expect(await genericItemStatus(itemB)).toBe("pending");

    // Worker stops leasing new items: the same taskTypes/family now yields
    // nothing, even though item B is genuinely still `pending` -- the
    // parent-eligibility EXISTS pushdown in `selectPending` requires
    // `t.status IN ('pending','processing')`.
    const claimAfterPause = await claimPendingItem(prisma, {
      family: "generic",
      taskTypes: ["x10.acceptance"],
      workerId: "x10-worker-2",
      leaseMs: 60_000,
    });
    expect(claimAfterPause).toBeNull();

    // The in-flight item (A) finishes normally.
    await finalizeTaskItem(prisma, lease!, { status: "success", result: { ok: true } });
    expect(await genericItemStatus(itemA)).toBe("success");
    // THE GUARD, against real SQL: item counts alone (1 success, 1 pending)
    // would otherwise recompute `processing` (pending+processing > 0) --
    // must stay `paused`.
    expect(await genericTaskStatus(taskId)).toBe("paused");
    expect(await genericItemStatus(itemB)).toBe("pending");
  });

  it("system hold: a finalize after the worker's own system hold does not flip the parent back to processing (same guard, different trigger than manual pause)", async () => {
    const { taskId, itemIds } = await createGenericTask({
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      channelAccountId: foundation.accountId,
      channelAppId: foundation.channelAppId,
      itemCount: 3,
    });
    // A (about to trip the hold) and C (a concurrent worker's in-flight
    // item) are both leased; B is left genuinely pending so the hold's own
    // `terminatePendingTaskItems` has something real to terminate. Pinned to
    // specific known item ids -- all three share one `created_at` from the
    // same `create: [...]` batch, so an untargeted claim's tie-break on
    // random UUID order would not reliably pick "the first two".
    const [itemA, itemB, itemC] = itemIds;
    const leaseA = await claimPendingItem(prisma, {
      family: "generic", taskTypes: [PROMO_LINK_CLAIM_TASK_TYPE], workerId: "x10-worker-a", leaseMs: 60_000,
      claimTarget: { family: "generic", taskId, itemId: itemA },
    });
    const leaseC = await claimPendingItem(prisma, {
      family: "generic", taskTypes: [PROMO_LINK_CLAIM_TASK_TYPE], workerId: "x10-worker-c", leaseMs: 60_000,
      claimTarget: { family: "generic", taskId, itemId: itemC },
    });
    expect(leaseA?.itemId).toBe(itemA);
    expect(leaseC?.itemId).toBe(itemC);
    expect(await genericTaskStatus(taskId)).toBe("processing");

    // A's own finalize is exactly `worker/handlers/promo-link-claim.ts`'s
    // real wiring: a deterministic credential failure code drives the halt
    // from inside `protectedWrite`, in the very same transaction that also
    // finalizes A itself.
    await finalizeTaskItem(prisma, leaseA!, {
      status: "failed",
      error: { code: "credential_validation_failed", message: "credential is unusable" },
      protectedWrite: (tx) => maybeHaltTaskOnGlobalFailure(tx, {
        taskId, itemId: leaseA!.itemId, failureCode: "credential_validation_failed",
      }).then(() => undefined),
    });

    expect(await genericTaskStatus(taskId)).toBe("disabled");
    expect(await genericItemStatus(itemA)).toBe("failed");
    // B was still pending at the moment of the hold -> terminated (skipped).
    expect(await genericItemStatus(itemB)).toBe("skipped");
    // C was already leased (not `pending`) -> untouched by the hold itself,
    // still genuinely in flight.
    expect(await genericItemStatus(itemC)).toBe("processing");

    // C, a *different* item leased by a *different* worker before the hold,
    // now finishes normally -- its own `finalizeTaskItem` call runs
    // `recomputeParentTask` fresh. Without the guard covering `disabled`
    // (not just `paused`/`cancelled`), item counts at this point (1 failed,
    // 1 skipped, 1 about to become success, 0 pending, 0 processing once C
    // commits) would recompute to a terminal status derived from counts --
    // masking the system hold. It must stay exactly `disabled`.
    await finalizeTaskItem(prisma, leaseC!, { status: "success", result: { ok: true } });
    expect(await genericItemStatus(itemC)).toBe("success");
    expect(await genericTaskStatus(taskId)).toBe("disabled");
  });

  it("resume: refused while the promo-claim credential precondition still fails, accepted once it passes, and the remaining pending item is then claimable and processes to completion", async () => {
    const { taskId, itemIds } = await createGenericTask({
      taskType: PROMO_LINK_CLAIM_TASK_TYPE,
      channelAccountId: foundation.accountId,
      channelAppId: foundation.channelAppId,
      itemCount: 2,
    });
    const [itemA, itemB] = itemIds;

    // Pause first (no usable credential yet at all -- zero rows).
    const pauseTicket = await ticketFor("/api/admin/tasks/pause");
    await pauseTask({ ...pauseTicket, family: "generic", taskId }, pauseTicket.dependencies);
    expect(await genericTaskStatus(taskId)).toBe("paused");

    const refusedTicket = await ticketFor("/api/admin/tasks/resume");
    await expect(
      resumeTask({ ...refusedTicket, family: "generic", taskId }, refusedTicket.dependencies),
    ).rejects.toMatchObject({ code: "task_admin_precondition_failed", status: 409 });
    expect(await genericTaskStatus(taskId)).toBe("paused"); // never flipped

    // Make the credential usable, then resume again.
    await seedCredential(foundation);
    const acceptedTicket = await ticketFor("/api/admin/tasks/resume");
    const resumed = await resumeTask({ ...acceptedTicket, family: "generic", taskId }, acceptedTicket.dependencies);
    expect(resumed).toMatchObject({ status: "pending", wrote: true });
    expect(await genericTaskStatus(taskId)).toBe("pending");

    // Both items -- including the one that was already pending before the
    // pause/resume round trip -- are genuinely claimable and process to
    // completion after resume.
    const firstLease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: [PROMO_LINK_CLAIM_TASK_TYPE], workerId: "x10-worker", leaseMs: 60_000,
    });
    expect(firstLease).not.toBeNull();
    await finalizeTaskItem(prisma, firstLease!, { status: "success", result: {} });
    const secondLease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: [PROMO_LINK_CLAIM_TASK_TYPE], workerId: "x10-worker", leaseMs: 60_000,
    });
    expect(secondLease).not.toBeNull();
    await finalizeTaskItem(prisma, secondLease!, { status: "success", result: {} });

    expect(await genericItemStatus(itemA)).toBe("success");
    expect(await genericItemStatus(itemB)).toBe("success");
    expect(await genericTaskStatus(taskId)).toBe("completed");
  });

  it("abort: terminates remaining pending items, leaves already-success/failed rows untouched, and a later finalize of the in-flight item does not un-cancel the parent", async () => {
    const { taskId, itemIds } = await createGenericTask({ taskType: "x10.acceptance", itemCount: 4 });
    const [itemSuccess, itemFailed, itemPending, itemInFlight] = itemIds;

    // Drive two items to real terminal history the normal way (claim then
    // finalize), leave one genuinely pending, and leave one leased
    // (in-flight) at the moment of abort.
    for (const [itemId, outcome] of [[itemSuccess, "success"], [itemFailed, "failed"]] as const) {
      const lease = await claimPendingItem(prisma, {
        family: "generic", taskTypes: ["x10.acceptance"], workerId: "x10-worker",
        leaseMs: 60_000, claimTarget: { family: "generic", taskId, itemId },
      });
      expect(lease?.itemId).toBe(itemId);
      await finalizeTaskItem(prisma, lease!, outcome === "failed"
        ? { status: "failed", error: { code: "unknown", message: "boom" } }
        : { status: "success", result: {} });
    }
    const inFlightLease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["x10.acceptance"], workerId: "x10-worker",
      leaseMs: 60_000, claimTarget: { family: "generic", taskId, itemId: itemInFlight },
    });
    expect(inFlightLease?.itemId).toBe(itemInFlight);
    expect(await genericItemStatus(itemPending)).toBe("pending");

    const successSnapshot = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: itemSuccess } });
    const failedSnapshot = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: itemFailed } });

    const ticket = await ticketFor("/api/admin/tasks/abort");
    const result = await abortTask({ ...ticket, family: "generic", taskId, reason: "x10 acceptance abort" }, ticket.dependencies);
    expect(result).toMatchObject({ status: "cancelled", terminatedPendingItemCount: 1, wrote: true });
    expect(await genericTaskStatus(taskId)).toBe("cancelled");

    // The still-pending item was terminated (skipped), carrying the abort's
    // own reason code -- distinct from the system hold's.
    const terminated = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: itemPending } });
    expect(terminated.status).toBe("skipped");
    expect((terminated.error as { code?: string } | null)?.code).toBe(TASK_ABORT_TERMINATION_REASON);

    // History is never deleted or rewritten.
    const successAfter = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: itemSuccess } });
    const failedAfter = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: itemFailed } });
    expect(successAfter).toEqual(successSnapshot);
    expect(failedAfter).toEqual(failedSnapshot);

    // Abort is irreversible: a second attempt is refused, not a no-op.
    const secondTicket = await ticketFor("/api/admin/tasks/abort");
    await expect(
      abortTask({ ...secondTicket, family: "generic", taskId }, secondTicket.dependencies),
    ).rejects.toBeInstanceOf(TaskAdminError);

    // The item that was in flight at the moment of abort finishes normally
    // afterward -- its own `recomputeParentTask` call must not un-cancel
    // the parent (the guard, for `cancelled`, against real SQL).
    await finalizeTaskItem(prisma, inFlightLease!, { status: "success", result: {} });
    expect(await genericItemStatus(itemInFlight)).toBe("success");
    expect(await genericTaskStatus(taskId)).toBe("cancelled");
  });

  it("channel_sync family: pause guard survives a real finalize (own CASE branch, not just generic's), then resume -> complete round trip", async () => {
    const [sourceItemA, sourceItemB] = await Promise.all([seedNovelSourceItem(foundation), seedNovelSourceItem(foundation)]);
    const { taskId } = await createChannelSyncTask(foundation, [sourceItemA, sourceItemB]);
    const itemA = await prisma.channelSyncTaskItem.findFirstOrThrow({ where: { taskId, novelSourceItemId: sourceItemA }, select: { id: true } });
    const itemB = await prisma.channelSyncTaskItem.findFirstOrThrow({ where: { taskId, novelSourceItemId: sourceItemB }, select: { id: true } });

    const lease = await claimPendingItem(prisma, {
      family: "channel_sync", taskTypes: ["x10.channel_sync.acceptance"], workerId: "x10-worker", leaseMs: 60_000,
      claimTarget: { family: "channel_sync", taskId, itemId: itemA.id },
    });
    expect(lease?.itemId).toBe(itemA.id);

    const pauseTicket = await ticketFor("/api/admin/tasks/pause");
    const paused = await pauseTask({ ...pauseTicket, family: "channel_sync", taskId }, pauseTicket.dependencies);
    expect(paused).toMatchObject({ status: "paused", wrote: true });
    expect(await channelSyncTaskStatus(taskId)).toBe("paused");
    expect(await claimPendingItem(prisma, {
      family: "channel_sync", taskTypes: ["x10.channel_sync.acceptance"], workerId: "x10-worker-2", leaseMs: 60_000,
    })).toBeNull();

    // channel_sync_task's own CASE expression (a separate, hand-written SQL
    // branch from generic_task's -- see `recomputeParentTask`, store.ts) --
    // the in-flight item (A) finishes normally while B is still pending.
    // Without the guard here specifically, item counts (0 success -> 1
    // success, 1 pending) would recompute `processing`.
    await finalizeTaskItem(prisma, lease!, { status: "success", result: {} });
    expect(await channelSyncTaskStatus(taskId)).toBe("paused");
    const itemBStatus = await prisma.channelSyncTaskItem.findUniqueOrThrow({ where: { id: itemB.id }, select: { status: true } });
    expect(itemBStatus.status).toBe("pending");

    const resumeTicket = await ticketFor("/api/admin/tasks/resume");
    const resumed = await resumeTask({ ...resumeTicket, family: "channel_sync", taskId }, resumeTicket.dependencies);
    expect(resumed).toMatchObject({ status: "pending", wrote: true });
    expect(await channelSyncTaskStatus(taskId)).toBe("pending");

    const secondLease = await claimPendingItem(prisma, {
      family: "channel_sync", taskTypes: ["x10.channel_sync.acceptance"], workerId: "x10-worker", leaseMs: 60_000,
    });
    expect(secondLease?.itemId).toBe(itemB.id);
    await finalizeTaskItem(prisma, secondLease!, { status: "success", result: {} });
    expect(await channelSyncTaskStatus(taskId)).toBe("completed");

    // A fresh abort attempt on an already-terminal task is refused.
    const abortTicket = await ticketFor("/api/admin/tasks/abort");
    await expect(
      abortTask({ ...abortTicket, family: "channel_sync", taskId }, abortTicket.dependencies),
    ).rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
  });

  it("concurrent pause vs. a finishing worker never produces a paused parent with a runnable successor -- the guard holds under real interleaving, not only sequential ordering", async () => {
    for (let trial = 0; trial < 15; trial += 1) {
      const { taskId, itemIds } = await createGenericTask({ taskType: "x10.acceptance", itemCount: 2 });
      const [itemInFlight, itemPending] = itemIds;
      const lease = await claimPendingItem(prisma, {
        family: "generic", taskTypes: ["x10.acceptance"], workerId: "x10-worker",
        leaseMs: 60_000, claimTarget: { family: "generic", taskId, itemId: itemInFlight },
      });
      expect(lease?.itemId).toBe(itemInFlight);

      const ticket = await ticketFor("/api/admin/tasks/pause");
      // Race pauseTask's own transaction (lockParent FOR UPDATE + conditional
      // updateMany) against finalizeTaskItem's transaction (guardedFinalize +
      // recomputeParentTask) on the very same parent row. Whichever commits
      // first, Postgres serializes the two via row-level locking -- the
      // invariant under test is the FINAL state, not which one "won".
      const settled = await Promise.allSettled([
        pauseTask({ ...ticket, family: "generic", taskId, reason: `trial ${trial}` }, ticket.dependencies),
        finalizeTaskItem(prisma, lease!, { status: "success", result: { trial } }),
      ]);
      // Both are expected to succeed -- they touch disjoint rows for their
      // own primary write (the item vs. the pause's own eligibility read),
      // and only serialize, never conflict, on the shared parent row.
      for (const outcome of settled) {
        if (outcome.status === "rejected") throw outcome.reason;
      }

      expect(await genericItemStatus(itemInFlight)).toBe("success");
      // Never a "runnable successor": the parent is durably paused and the
      // still-pending sibling was never touched.
      expect(await genericTaskStatus(taskId)).toBe("paused");
      expect(await genericItemStatus(itemPending)).toBe("pending");
      const claimAfter = await claimPendingItem(prisma, {
        family: "generic", taskTypes: ["x10.acceptance"], workerId: "x10-worker-late", leaseMs: 60_000,
      });
      expect(claimAfter).toBeNull();
    }
  });
});
