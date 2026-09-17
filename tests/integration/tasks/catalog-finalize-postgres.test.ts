import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimPendingItem,
  finalizeTaskItem,
  LeaseLostError,
  recoverExpiredItem,
  type TaskLease,
} from "@/lib/tasks";
import { retryCatalogFinalizeTask, retryFailedTask } from "@/server/task-admin";
import {
  issueTaskAuthorization,
  newStores,
  NOW,
  seedTaskAdmin,
} from "../../backend/task-admin/test-support";

const enabled = process.env.CATALOG_FINALIZE_DATABASE_TEST === "1";
function requiredUrl(name: string) {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
}
const owner = new PrismaClient({ datasourceUrl: requiredUrl("CATALOG_FINALIZE_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: requiredUrl("CATALOG_FINALIZE_WEB_DATABASE_URL") });
const worker = new PrismaClient({ datasourceUrl: requiredUrl("CATALOG_FINALIZE_WORKER_DATABASE_URL") });

async function truncateDatabase() {
  const tables = await owner.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

async function seedTask(input: { pageStatus?: string; finalizeStatus?: string } = {}) {
  const taskId = randomUUID();
  const pageId = randomUUID();
  const finalizeId = randomUUID();
  await owner.genericTask.create({
    data: {
      id: taskId,
      taskType: "catalog_scan",
      operationScopeHash: "a".repeat(64),
      mode: "apply",
      status: "processing",
      requestToken: randomUUID(),
      totalCount: 1,
      result: { terminalPage: 1, finalization: { status: "pending", generation: 1 }, terminalState: "processing" },
      items: {
        create: [
          { id: pageId, targetType: "catalog_page", targetId: "1", status: input.pageStatus ?? "pending", payload: {} },
          {
            id: finalizeId,
            targetType: "catalog_finalize",
            targetId: "v1",
            status: input.finalizeStatus === "processing" ? "pending" : input.finalizeStatus ?? "pending",
            payload: { kind: "catalog_finalize", actorId: "integration", requestId: randomUUID(), generation: 1 },
          },
        ],
      },
    },
  });
  if (input.finalizeStatus === "processing") {
    await owner.genericTaskItem.update({
      where: { id: finalizeId },
      data: {
        status: "processing",
        attemptCount: 1,
        executionToken: randomUUID(),
        leaseEpoch: 1n,
        lockedBy: "seed-worker",
        lockedUntil: new Date(Date.now() + 60_000),
        heartbeatAt: new Date(),
        startedAt: new Date(),
      },
    });
  }
  return { taskId, pageId, finalizeId };
}

describe.skipIf(!enabled)("catalog finalize PostgreSQL state machine", () => {
  beforeAll(async () => {
    const [database] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
      SELECT current_database() AS name, current_setting('server_version') AS version
    `;
    if (!database.name.includes("p1_13")) throw new Error(`Refusing catalog-finalize tests against ${database.name}`);
    if (!database.version.startsWith("16.")) throw new Error(`PostgreSQL 16 required, got ${database.version}`);
    await Promise.all([web.$connect(), worker.$connect()]);
  });
  beforeEach(truncateDatabase);
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect()]);
  });

  it("does not claim finalize until every page has left pending/processing", async () => {
    const seeded = await seedTask();
    expect(await claimPendingItem(worker, {
      family: "generic",
      taskTypes: ["catalog_scan"],
      workerId: "gate-worker",
      leaseMs: 60_000,
      claimTarget: { family: "generic", taskId: seeded.taskId, itemId: seeded.finalizeId },
    })).toBeNull();

    await owner.genericTaskItem.update({
      where: { id: seeded.pageId },
      data: { status: "success", result: { returnedCount: 1 }, finishedAt: new Date() },
    });
    expect(await claimPendingItem(worker, {
      family: "generic",
      taskTypes: ["catalog_scan"],
      workerId: "gate-worker",
      leaseMs: 60_000,
      claimTarget: { family: "generic", taskId: seeded.taskId, itemId: seeded.finalizeId },
    })).toMatchObject({ itemId: seeded.finalizeId, targetType: "catalog_finalize", attemptCount: 1 });
  });

  it.each([
    ["execution token", (lease: TaskLease) => ({ ...lease, executionToken: randomUUID() })],
    ["lease epoch", (lease: TaskLease) => ({ ...lease, leaseEpoch: lease.leaseEpoch - 1n })],
    ["worker owner", (lease: TaskLease) => ({ ...lease, workerId: "stale-worker" })],
  ] as const)("rejects a stale %s with the real fencing predicate", async (_label, mutate) => {
    const seeded = await seedTask({ pageStatus: "success" });
    const lease = await claimPendingItem(worker, {
      family: "generic", taskTypes: ["catalog_scan"], workerId: "current-worker", leaseMs: 60_000,
      claimTarget: { family: "generic", taskId: seeded.taskId, itemId: seeded.finalizeId },
    });
    expect(lease).not.toBeNull();
    await expect(finalizeTaskItem(worker, mutate(lease!), { status: "retry", error: { code: "retry" } }))
      .rejects.toBeInstanceOf(LeaseLostError);
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: seeded.finalizeId } }))
      .toMatchObject({ status: "processing", attemptCount: 1 });
  });

  it("rejects a lease whose locked_until has expired", async () => {
    const seeded = await seedTask({ pageStatus: "success" });
    const lease = await claimPendingItem(worker, {
      family: "generic", taskTypes: ["catalog_scan"], workerId: "current-worker", leaseMs: 60_000,
      claimTarget: { family: "generic", taskId: seeded.taskId, itemId: seeded.finalizeId },
    });
    expect(lease).not.toBeNull();
    await owner.genericTaskItem.update({
      where: { id: seeded.finalizeId },
      data: { lockedUntil: new Date(Date.now() - 1_000) },
    });
    await expect(finalizeTaskItem(worker, lease!, { status: "retry", error: { code: "retry" } }))
      .rejects.toBeInstanceOf(LeaseLostError);
  });

  it("terminalizes an expired exhausted finalize lease and marks finalization failed", async () => {
    const seeded = await seedTask({ pageStatus: "success", finalizeStatus: "processing" });
    await owner.genericTaskItem.update({
      where: { id: seeded.finalizeId },
      data: {
        attemptCount: 3,
        executionToken: randomUUID(),
        leaseEpoch: 3n,
        lockedBy: "dead-worker",
        lockedUntil: new Date(Date.now() - 60_000),
        heartbeatAt: new Date(Date.now() - 60_000),
      },
    });

    expect(await recoverExpiredItem(worker, {
      family: "generic",
      taskTypes: ["catalog_scan"],
      maxAttemptsByType: { catalog_scan: 3 },
      workerId: "recovery-worker",
    })).toMatchObject({ action: "failed", itemId: seeded.finalizeId, attemptCount: 3 });
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: seeded.finalizeId } }))
      .toMatchObject({ status: "failed", attemptCount: 3 });
    expect(await owner.genericTask.findUniqueOrThrow({ where: { id: seeded.taskId } })).toMatchObject({
      status: "completed_with_errors",
      failedCount: 0,
      result: { finalization: { status: "failed", generation: 1, reason: "lease_expired" } },
    });
  });

  it("lets web_app formally re-finalize with a full budget, monotonic epoch, and idempotent replay", async () => {
    const seeded = await seedTask({ pageStatus: "success", finalizeStatus: "failed" });
    await owner.genericTask.update({
      where: { id: seeded.taskId },
      data: {
        status: "completed_with_errors",
        result: {
          terminalPage: 1,
          catalogObservedTotal: 973,
          checkpoint: { lastPage: 1 },
          finalization: { status: "failed", generation: 1 },
          terminalState: "partial_failed",
        },
      },
    });
    await owner.genericTaskItem.update({
      where: { id: seeded.finalizeId },
      data: { attemptCount: 3, leaseEpoch: 7n, error: { code: "exhausted" }, finishedAt: new Date() },
    });
    const stores = newStores();
    const admin = seedTaskAdmin(stores, { identityId: "catalog-finalize-admin" });
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/retry-catalog-finalize",
    });
    const dependencies = { db: web, identities: stores, sessions: stores, now: NOW };
    const first = await retryCatalogFinalizeTask({ ...ticket, taskId: seeded.taskId }, dependencies);
    const replay = await retryCatalogFinalizeTask({ ...ticket, taskId: seeded.taskId }, dependencies);
    expect(first).toMatchObject({ status: "pending", generation: 2, wrote: true });
    expect(replay).toMatchObject({ status: "pending", generation: 2, wrote: false, auditId: first.auditId });
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: seeded.finalizeId } })).toMatchObject({
      status: "pending", attemptCount: 0, leaseEpoch: 7n,
      payload: { generation: 2 },
    });
    expect(await owner.genericTask.findUniqueOrThrow({ where: { id: seeded.taskId } })).toMatchObject({
      status: "pending",
      result: {
        terminalPage: 1,
        catalogObservedTotal: 973,
        checkpoint: { lastPage: 1 },
        finalization: { status: "pending", generation: 2 },
        terminalState: "processing",
      },
    });
  });

  it("retries failed pages without erasing EOF evidence and rearms exactly one new finalize generation", async () => {
    const seeded = await seedTask({ pageStatus: "failed", finalizeStatus: "failed" });
    await owner.genericTask.update({
      where: { id: seeded.taskId },
      data: {
        status: "completed_with_errors",
        failedCount: 1,
        result: {
          terminalPage: 1,
          catalogObservedTotal: 973,
          checkpoint: { lastPage: 1, observedTotal: 973 },
          finalization: { status: "failed", generation: 1 },
          terminalState: "partial_failed",
          previewEnqueue: { status: "enqueued", taskId: randomUUID() },
        },
      },
    });
    await owner.genericTaskItem.update({
      where: { id: seeded.finalizeId },
      data: { attemptCount: 3, leaseEpoch: 9n, error: { code: "exhausted" }, finishedAt: new Date() },
    });
    const stores = newStores();
    const admin = seedTaskAdmin(stores, { identityId: "catalog-page-retry-admin" });
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/retry-failed",
    });
    const result = await retryFailedTask({ ...ticket, family: "generic", taskId: seeded.taskId }, {
      db: web, identities: stores, sessions: stores, now: NOW,
    });
    expect(result).toMatchObject({ status: "pending", retriedItemCount: 1, failedCount: 0 });
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: seeded.pageId } })).toMatchObject({ status: "pending" });
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: seeded.finalizeId } })).toMatchObject({
      status: "pending", attemptCount: 0, leaseEpoch: 9n, payload: { generation: 2 },
    });
    expect(await owner.genericTask.findUniqueOrThrow({ where: { id: seeded.taskId } })).toMatchObject({
      result: {
        terminalPage: 1,
        catalogObservedTotal: 973,
        checkpoint: { lastPage: 1, observedTotal: 973 },
        finalization: { status: "pending", generation: 2 },
        terminalState: "processing",
        previewEnqueue: null,
      },
    });
    expect(await owner.genericTaskItem.count({
      where: { taskId: seeded.taskId, targetType: "catalog_finalize", targetId: "v1" },
    })).toBe(1);
  });
});
