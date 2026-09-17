import { describe, expect, it } from "vitest";

import {
  MANUAL_REVIEW_AUDIT_ACTION,
  CATALOG_FINALIZE_RETRY_AUDIT_ACTION,
  retryCatalogFinalizeTask,
  retryFailedTask,
  resolveManualReview,
  TASK_RETRY_AUDIT_ACTION,
  TaskAdminError,
} from "@/server/task-admin";

import {
  INTENT_ID,
  issueTaskAuthorization,
  newStores,
  NOW,
  seedTaskAdmin,
  TASK_ID,
  TaskAdminFakeDb,
} from "./test-support";

const REASON = "operator checked the failed task evidence";

describe("X9 failed-item retry", () => {
  it.each(["channel_sync", "generic"] as const)(
    "requeues every failed %s item, preserves fencing counters, recounts parent, and audits in the transaction",
    async (family) => {
      const stores = newStores();
      const admin = seedTaskAdmin(stores);
      const ticket = await issueTaskAuthorization(stores, {
        token: admin.token,
        pathname: "/api/admin/tasks/retry-failed",
      });
      const fake = new TaskAdminFakeDb();
      const failedBefore = fake.items.get(family)!.filter((row) => row.status === "failed")
        .map((row) => ({ id: row.id, attemptCount: row.attemptCount, leaseEpoch: row.leaseEpoch }));

      const result = await retryFailedTask(
        { ...ticket, family, taskId: TASK_ID },
        { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
      );

      expect(result).toMatchObject({
        family,
        taskId: TASK_ID,
        status: "pending",
        retriedItemCount: 2,
        totalCount: 3,
        successCount: 1,
        failedCount: 0,
        skippedCount: 0,
        wrote: true,
      });
      for (const before of failedBefore) {
        const after = fake.items.get(family)!.find((row) => row.id === before.id)!;
        expect(after).toMatchObject({
          status: "pending",
          attemptCount: before.attemptCount,
          leaseEpoch: before.leaseEpoch,
          executionToken: null,
          lockedBy: null,
          lockedUntil: null,
          heartbeatAt: null,
          finishedAt: null,
        });
      }
      expect(fake.parents.get(family)).toMatchObject({
        status: "pending",
        totalCount: 3,
        successCount: 1,
        failedCount: 0,
        completedAt: null,
      });
      expect(fake.itemUpdateCalls.get(family)).toBe(1);
      expect(fake.parentUpdateCalls.get(family)).toBe(1);
      expect(fake.audits).toHaveLength(1);
      expect(fake.audits[0]).toMatchObject({
        action: TASK_RETRY_AUDIT_ACTION,
        actorId: admin.identity.id,
        entityId: TASK_ID,
        taskType: family,
        reason: null,
      });
    },
  );

  it.each(["prepared", "claim_retry_blocked", "manual_review_required"])(
    "fails closed while a failed item has an unresolved %s intent",
    async (unresolvedStatus) => {
      const stores = newStores();
      const admin = seedTaskAdmin(stores);
      const ticket = await issueTaskAuthorization(stores, {
        token: admin.token,
        pathname: "/api/admin/tasks/retry-failed",
      });
      const fake = new TaskAdminFakeDb();
      fake.unresolvedStatus = unresolvedStatus;

      await expect(retryFailedTask(
        { ...ticket, family: "channel_sync", taskId: TASK_ID },
        { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
      )).rejects.toMatchObject({ code: "task_admin_unresolved_intent", status: 409 });
      expect(fake.itemUpdateCalls.size).toBe(0);
      expect(fake.parentUpdateCalls.size).toBe(0);
      expect(fake.audits).toHaveLength(0);
    },
  );

  it("fails closed for an unlinked generic promo intent in the same item/account/app scope", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/retry-failed",
    });
    const fake = new TaskAdminFakeDb();
    fake.genericUnlinkedBlocked = true;

    await expect(retryFailedTask(
      { ...ticket, family: "generic", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    )).rejects.toMatchObject({ code: "task_admin_unresolved_intent", status: 409 });
    expect(fake.itemUpdateCalls.size).toBe(0);
  });

  it("safely replays the same committed request id when no reason was supplied", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/retry-failed",
    });
    const fake = new TaskAdminFakeDb();
    const dependencies = { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
    const input = { ...ticket, family: "generic" as const, taskId: TASK_ID };

    const first = await retryFailedTask(input, dependencies);
    const replay = await retryFailedTask(input, dependencies);
    expect(first.wrote).toBe(true);
    expect(replay).toMatchObject({ wrote: false, auditId: first.auditId, retriedItemCount: 2 });
    expect(fake.itemUpdateCalls.get("generic")).toBe(1);
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ reason: null });
  });

  it("still accepts an explicit reason on first write and rejects a replay whose reason binding changed", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/retry-failed",
    });
    const fake = new TaskAdminFakeDb();
    const dependencies = { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
    const input = { ...ticket, family: "generic" as const, taskId: TASK_ID, reason: REASON };

    const first = await retryFailedTask(input, dependencies);
    expect(first.wrote).toBe(true);
    expect(fake.audits[0]).toMatchObject({ reason: REASON });

    await expect(retryFailedTask({ ...input, reason: "different binding" }, dependencies))
      .rejects.toMatchObject({ code: "task_admin_idempotency_conflict", status: 409 });
  });

  it("rejects non-terminal parents and zero-failed-item races with 409", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/retry-failed",
    });
    const fake = new TaskAdminFakeDb();
    fake.parents.get("channel_sync")!.status = "processing";
    await expect(retryFailedTask(
      { ...ticket, family: "channel_sync", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    )).rejects.toBeInstanceOf(TaskAdminError);
    expect(fake.itemUpdateCalls.size).toBe(0);
  });

  it("catalog retry preserves EOF evidence and rearms finalize as a new generation", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/retry-failed",
    });
    const fake = new TaskAdminFakeDb();
    const parent = fake.parents.get("generic")!;
    parent.taskType = "catalog_scan";
    parent.result = {
      terminalPage: 974,
      catalogObservedTotal: 97_320,
      checkpoint: { lastCompletedPage: 973 },
      finalization: { status: "completed", generation: 1 },
      terminalState: "partial_failed",
      previewEnqueue: { status: "enqueued" },
    };
    const [failedPage, successPage, finalize] = fake.items.get("generic")!;
    Object.assign(failedPage, { targetType: "catalog_page", targetId: "974", status: "failed" });
    Object.assign(successPage, { targetType: "catalog_page", targetId: "973", status: "success" });
    Object.assign(finalize, {
      targetType: "catalog_finalize", targetId: "v1", status: "success", attemptCount: 1,
      payload: { kind: "catalog_finalize", actorId: "worker", requestId: "old", generation: 1 },
    });
    fake.items.set("generic", [failedPage, successPage, finalize]);

    const result = await retryFailedTask(
      { ...ticket, family: "generic", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    );

    expect(result).toMatchObject({ retriedItemCount: 1, status: "pending" });
    expect(failedPage.status).toBe("pending");
    expect(finalize).toMatchObject({ status: "pending", attemptCount: 0, payload: { generation: 2 } });
    expect(parent.result).toMatchObject({
      terminalPage: 974,
      catalogObservedTotal: 97_320,
      checkpoint: { lastCompletedPage: 973 },
      finalization: { status: "pending", generation: 2 },
      terminalState: "processing",
      previewEnqueue: null,
    });
  });
});

describe("catalog finalize formal recovery", () => {
  it("starts a new audited generation, resets only finalize attempts, and replays idempotently", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/retry-catalog-finalize",
    });
    const fake = new TaskAdminFakeDb();
    const parent = fake.parents.get("generic")!;
    parent.taskType = "catalog_scan";
    parent.failedCount = 0;
    parent.result = {
      terminalPage: 974,
      catalogObservedTotal: 97_320,
      finalization: { status: "failed", generation: 1 },
      terminalState: "partial_failed",
    };
    const finalize = fake.items.get("generic")![0];
    Object.assign(finalize, {
      targetType: "catalog_finalize",
      targetId: "v1",
      status: "failed",
      attemptCount: 3,
      leaseEpoch: 9n,
      payload: { kind: "catalog_finalize", actorId: "worker", requestId: "original", generation: 1 },
    });
    fake.items.set("generic", [finalize]);
    const dependencies = { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW };

    const first = await retryCatalogFinalizeTask({ ...ticket, taskId: TASK_ID }, dependencies);
    const replay = await retryCatalogFinalizeTask({ ...ticket, taskId: TASK_ID }, dependencies);

    expect(first).toMatchObject({ status: "pending", generation: 2, wrote: true });
    expect(replay).toMatchObject({ status: "pending", generation: 2, wrote: false, auditId: first.auditId });
    expect(finalize).toMatchObject({ status: "pending", attemptCount: 0, leaseEpoch: 9n, payload: { generation: 2 } });
    expect(parent).toMatchObject({
      status: "pending",
      failedCount: 0,
      result: {
        terminalPage: 974,
        catalogObservedTotal: 97_320,
        finalization: { status: "pending", generation: 2 },
        terminalState: "processing",
      },
    });
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({ action: CATALOG_FINALIZE_RETRY_AUDIT_ACTION });
  });
});

describe("X9 manual-review adjudication", () => {
  it.each([
    ["effect_confirmed", "confirmed"],
    ["no_effect_confirmed", "failed"],
  ] as const)("maps %s to %s, writes only local intent plus audit, and supports replay", async (resolution, status) => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/manual-reviews/resolve",
    });
    const fake = new TaskAdminFakeDb();
    const dependencies = { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
    const input = { ...ticket, intentId: INTENT_ID, resolution, reason: REASON };

    const result = await resolveManualReview(input, dependencies);
    expect(result).toEqual({
      intentId: INTENT_ID,
      resolution,
      status,
      resolvedAt: NOW.toISOString(),
      automaticReconciliation: false,
      nextActions: ["upstream_readback", "authorized_rescan"],
      wrote: true,
      auditId: "1",
    });
    expect(fake.intents.get(INTENT_ID)).toMatchObject({ status, confirmedAt: NOW });
    expect(fake.audits[0]).toMatchObject({
      action: MANUAL_REVIEW_AUDIT_ACTION,
      actorId: admin.identity.id,
      entityId: INTENT_ID,
      reason: REASON,
    });
    expect(fake.promoMutationCalls).toBe(0);

    const replay = await resolveManualReview(input, dependencies);
    expect(replay).toMatchObject({ wrote: false, status, auditId: "1" });
    expect(fake.audits).toHaveLength(1);
  });

  it("uses status-qualified CAS so two concurrent admins have exactly one winner", async () => {
    const stores = newStores();
    const firstAdmin = seedTaskAdmin(stores, { identityId: "admin-1" });
    const secondAdmin = seedTaskAdmin(stores, { identityId: "admin-2" });
    const [firstTicket, secondTicket] = await Promise.all([
      issueTaskAuthorization(stores, {
        token: firstAdmin.token,
        pathname: "/api/admin/tasks/manual-reviews/resolve",
      }),
      issueTaskAuthorization(stores, {
        token: secondAdmin.token,
        pathname: "/api/admin/tasks/manual-reviews/resolve",
      }),
    ]);
    const fake = new TaskAdminFakeDb();
    fake.manualReadBarrier = true;
    const dependencies = { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW };

    const settled = await Promise.allSettled([
      resolveManualReview(
        { ...firstTicket, intentId: INTENT_ID, resolution: "effect_confirmed", reason: REASON },
        dependencies,
      ),
      resolveManualReview(
        { ...secondTicket, intentId: INTENT_ID, resolution: "no_effect_confirmed", reason: REASON },
        dependencies,
      ),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "task_admin_concurrent_write",
      status: 409,
    });
    expect(fake.audits).toHaveLength(1);
    expect(fake.promoMutationCalls).toBe(0);
  });

  it("requires a current 2FA-completed task:manage session", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores, { role: "ops", twoFactorCompleted: false });
    await expect(issueTaskAuthorization(stores, {
      token: admin.token,
      pathname: "/api/admin/tasks/manual-reviews/resolve",
      env: { TASK_MANAGE_ROLES: "ops" } as unknown as NodeJS.ProcessEnv,
    })).rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });
  });
});
