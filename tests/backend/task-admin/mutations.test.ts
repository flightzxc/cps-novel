import { describe, expect, it } from "vitest";

import {
  MANUAL_REVIEW_AUDIT_ACTION,
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
  it(
    "channel_sync (unchanged in-place semantics): requeues every failed item, preserves fencing counters, recounts parent, and audits in the transaction",
    async () => {
      const family = "channel_sync" as const;
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
        { ...ticket, family, taskId: TASK_ID, reason: REASON },
        { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
      );

      expect(result).toMatchObject({
        family,
        taskId: TASK_ID,
        originTaskId: null,
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
        reason: REASON,
      });
    },
  );

  it(
    "generic (C-7 CPS parity): creates a NEW sibling task linked by originTaskId, copies only the failed items, and leaves the origin task untouched",
    async () => {
      const stores = newStores();
      const admin = seedTaskAdmin(stores);
      const ticket = await issueTaskAuthorization(stores, {
        token: admin.token,
        pathname: "/api/admin/tasks/retry-failed",
      });
      const fake = new TaskAdminFakeDb();
      const originBefore = { ...fake.parents.get("generic")! };
      const originItemsBefore = fake.items.get("generic")!.map((row) => ({ ...row }));

      const result = await retryFailedTask(
        { ...ticket, family: "generic", taskId: TASK_ID, reason: REASON },
        { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
      );

      expect(result).toMatchObject({
        family: "generic",
        originTaskId: TASK_ID,
        status: "pending",
        retriedItemCount: 2,
        totalCount: 2,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        wrote: true,
      });
      expect(result.taskId).not.toBe(TASK_ID);

      // The origin task and its own items are untouched -- no in-place reset.
      expect(fake.parents.get("generic")).toEqual(originBefore);
      expect(fake.items.get("generic")).toEqual(originItemsBefore);
      expect(fake.itemUpdateCalls.get("generic")).toBeUndefined();
      expect(fake.parentUpdateCalls.get("generic")).toBeUndefined();

      // The new sibling task was created with originTaskId pointing back,
      // and carries only the two failed items (never the success item).
      expect(fake.createdGenericTasks).toHaveLength(1);
      expect(fake.createdGenericTasks[0]).toMatchObject({
        id: result.taskId,
        taskType: "catalog_scan",
        originTaskId: TASK_ID,
      });
      const newItems = fake.createdGenericTaskItems.get(result.taskId) ?? [];
      expect(newItems).toHaveLength(2);
      for (const row of newItems) expect(row.status).toBe("pending");
      expect(newItems.map((row) => row.targetId).sort()).toEqual(["source-1", "source-2"]);
      expect(newItems.map((row) => row.payload)).toEqual([
        { seededFrom: "source-1" },
        { seededFrom: "source-2" },
      ]);

      expect(fake.audits).toHaveLength(1);
      expect(fake.audits[0]).toMatchObject({
        action: TASK_RETRY_AUDIT_ACTION,
        actorId: admin.identity.id,
        entityId: TASK_ID,
        taskType: "generic",
        reason: REASON,
      });
    },
  );

  it(
    "generic (C-7 negative case): a second retry of the SAME origin task under a different requestId is rejected by generic_task_origin_key (409, not a double-create)",
    async () => {
      const stores = newStores();
      const admin = seedTaskAdmin(stores);
      const fake = new TaskAdminFakeDb();
      const dependencies = { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW };

      const first = await issueTaskAuthorization(stores, {
        token: admin.token,
        pathname: "/api/admin/tasks/retry-failed",
      });
      const firstResult = await retryFailedTask(
        { ...first, family: "generic", taskId: TASK_ID, reason: REASON },
        dependencies,
      );
      expect(firstResult.wrote).toBe(true);

      // A genuinely different admin submission (different requestId, so the
      // committedAudit idempotency replay above never matches it) racing to
      // retry the SAME origin task must not silently create a second
      // sibling task -- this is exactly the scenario
      // `generic_task_origin_key` (`@@unique([taskType, originTaskId])`)
      // exists to close off.
      const second = await issueTaskAuthorization(stores, {
        token: admin.token,
        pathname: "/api/admin/tasks/retry-failed",
      });
      await expect(retryFailedTask(
        { ...second, family: "generic", taskId: TASK_ID, reason: "a second, independent retry attempt" },
        dependencies,
      )).rejects.toMatchObject({ code: "task_admin_active_scope_conflict", status: 409 });

      // Exactly one sibling task exists -- the rejected attempt never wrote one.
      expect(fake.createdGenericTasks).toHaveLength(1);
      expect(fake.audits).toHaveLength(1);
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
        { ...ticket, family: "channel_sync", taskId: TASK_ID, reason: REASON },
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
      { ...ticket, family: "generic", taskId: TASK_ID, reason: REASON },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    )).rejects.toMatchObject({ code: "task_admin_unresolved_intent", status: 409 });
    expect(fake.itemUpdateCalls.size).toBe(0);
  });

  it("safely replays the same committed request id (generic: resolves back to the SAME sibling task, never creates a second one) and rejects a changed replay binding", async () => {
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
    const replay = await retryFailedTask(input, dependencies);
    expect(first.wrote).toBe(true);
    expect(replay).toMatchObject({
      wrote: false,
      auditId: first.auditId,
      taskId: first.taskId,
      originTaskId: TASK_ID,
      retriedItemCount: 2,
    });
    // Still exactly one sibling task -- the replay must not create a second.
    expect(fake.createdGenericTasks).toHaveLength(1);
    expect(fake.audits).toHaveLength(1);

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
      { ...ticket, family: "channel_sync", taskId: TASK_ID, reason: REASON },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    )).rejects.toBeInstanceOf(TaskAdminError);
    expect(fake.itemUpdateCalls.size).toBe(0);
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
