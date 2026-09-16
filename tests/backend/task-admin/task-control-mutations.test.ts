import { describe, expect, it } from "vitest";

import {
  abortTask,
  pauseTask,
  resumeTask,
  TASK_ABORT_AUDIT_ACTION,
  TASK_ABORT_TERMINATION_REASON,
  TASK_PAUSE_AUDIT_ACTION,
  TASK_RESUME_AUDIT_ACTION,
  TaskAdminError,
} from "@/server/task-admin";
import { mergeTaskControlResult, type TaskControlMarker } from "@/lib/tasks/task-control";
import { PROMO_LINK_CLAIM_TASK_TYPE } from "@/lib/tasks/promo-link-claim-limits";

import {
  issueTaskAuthorization,
  newStores,
  NOW,
  seedTaskAdmin,
  TASK_ID,
  TaskAdminFakeDb,
} from "./test-support";

const REASON = "operator paused for maintenance";

function pausedMarker(actorId: string): TaskControlMarker {
  return { kind: "paused", source: "manual", at: NOW.toISOString(), actorId, reason: null };
}

function pendingItem(id: string) {
  return {
    id,
    taskId: TASK_ID,
    status: "pending",
    attemptCount: 0,
    leaseEpoch: 0n,
    executionToken: null,
    lockedBy: null,
    lockedUntil: null,
    heartbeatAt: null,
    result: null,
    error: null,
    finishedAt: null,
  };
}

describe("X10 task control — pause", () => {
  it.each(["channel_sync", "generic"] as const)(
    "pauses an active %s task without touching any item, and records who/when",
    async (family) => {
      const stores = newStores();
      const admin = seedTaskAdmin(stores);
      const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/pause" });
      const fake = new TaskAdminFakeDb();
      fake.parents.get(family)!.status = "processing";
      const itemsBefore = fake.items.get(family)!.map((row) => ({ ...row }));

      const result = await pauseTask(
        { ...ticket, family, taskId: TASK_ID, reason: REASON },
        { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
      );

      expect(result).toMatchObject({ family, taskId: TASK_ID, status: "disabled", wrote: true });
      expect(fake.parents.get(family)).toMatchObject({ status: "disabled" });
      expect(fake.itemUpdateCalls.size).toBe(0);
      expect(fake.items.get(family)).toEqual(itemsBefore); // pending items left exactly as pending — none touched at all
      expect(fake.audits[0]).toMatchObject({
        action: TASK_PAUSE_AUDIT_ACTION,
        actorId: admin.identity.id,
        entityId: TASK_ID,
        reason: REASON,
      });
    },
  );

  it("refuses to pause a task that is not pending/processing", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/pause" });
    const fake = new TaskAdminFakeDb(); // default status: completed_with_errors
    await expect(pauseTask(
      { ...ticket, family: "generic", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    )).rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
    expect(fake.parentUpdateCalls.size).toBe(0);
  });

  it("safely replays the same committed request id instead of pausing twice", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/pause" });
    const fake = new TaskAdminFakeDb();
    fake.parents.get("generic")!.status = "pending";
    const dependencies = { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
    const input = { ...ticket, family: "generic" as const, taskId: TASK_ID, reason: REASON };

    const first = await pauseTask(input, dependencies);
    const replay = await pauseTask(input, dependencies);
    expect(first.wrote).toBe(true);
    expect(replay).toMatchObject({ wrote: false, auditId: first.auditId, status: "disabled" });
    expect(fake.parentUpdateCalls.get("generic")).toBe(1);
  });
});

describe("X10 task control — resume", () => {
  it("resumes a task with no known precondition (any taskType other than promo_link.claim.v1) unconditionally", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/resume" });
    const fake = new TaskAdminFakeDb();
    const parent = fake.parents.get("generic")!;
    parent.status = "disabled";
    parent.taskType = "catalog_scan";
    parent.result = mergeTaskControlResult(parent.result, pausedMarker(admin.identity.id));

    const result = await resumeTask(
      { ...ticket, family: "generic", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    );
    expect(result).toMatchObject({ family: "generic", taskId: TASK_ID, status: "pending", wrote: true });
    expect(fake.parents.get("generic")!.status).toBe("pending");
    expect(fake.audits[0]).toMatchObject({ action: TASK_RESUME_AUDIT_ACTION, actorId: admin.identity.id });
  });

  it("re-validates the promo_link.claim.v1 credential precondition and resumes once it is admissible", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/resume" });
    const fake = new TaskAdminFakeDb(); // default credentials array already has one admissible row
    const parent = fake.parents.get("generic")!;
    parent.status = "disabled";
    parent.taskType = PROMO_LINK_CLAIM_TASK_TYPE;
    parent.result = mergeTaskControlResult(parent.result, pausedMarker(admin.identity.id));

    const result = await resumeTask(
      { ...ticket, family: "generic", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    );
    expect(result).toMatchObject({ status: "pending", wrote: true });
    expect(fake.parents.get("generic")!.status).toBe("pending");
  });

  it("refuses to resume when the credential precondition still fails, and leaves the task paused", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/resume" });
    const fake = new TaskAdminFakeDb();
    fake.credentials.length = 0; // no usable credential
    const parent = fake.parents.get("generic")!;
    parent.status = "disabled";
    parent.taskType = PROMO_LINK_CLAIM_TASK_TYPE;
    parent.result = mergeTaskControlResult(parent.result, pausedMarker(admin.identity.id));

    await expect(resumeTask(
      { ...ticket, family: "generic", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    )).rejects.toMatchObject({ code: "task_admin_precondition_failed", status: 409 });
    expect(fake.parents.get("generic")!.status).toBe("disabled"); // never flipped
    expect(fake.parentUpdateCalls.size).toBe(0);
    expect(fake.audits).toHaveLength(0);
  });

  it("refuses to resume a disabled row that does not carry our own 'paused' marker (legacy/other disabled reasons)", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/resume" });
    const fake = new TaskAdminFakeDb();
    fake.parents.get("generic")!.status = "disabled"; // no taskControl marker at all — e.g. one of the 271 legacy rows
    await expect(resumeTask(
      { ...ticket, family: "generic", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    )).rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
  });
});

describe("X10 task control — abort", () => {
  it.each(["channel_sync", "generic"] as const)(
    "aborts an active %s task, terminates only the still-pending item, and never rewrites already-terminal history",
    async (family) => {
      const stores = newStores();
      const admin = seedTaskAdmin(stores);
      const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/abort" });
      const fake = new TaskAdminFakeDb();
      fake.parents.get(family)!.status = "processing";
      const items = fake.items.get(family)!;
      const [failedBefore, failed2Before, successBefore] = items.map((row) => ({ ...row }));
      items.push(pendingItem("60000000-0000-4000-8000-000000000099"));

      const result = await abortTask(
        { ...ticket, family, taskId: TASK_ID, reason: REASON },
        { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
      );

      expect(result).toMatchObject({ family, taskId: TASK_ID, status: "disabled", terminatedPendingItemCount: 1, wrote: true });
      expect(fake.parents.get(family)!.status).toBe("disabled");

      const after = fake.items.get(family)!;
      expect(after.find((row) => row.id === "60000000-0000-4000-8000-000000000099")).toMatchObject({
        status: "skipped",
        error: { code: TASK_ABORT_TERMINATION_REASON },
      });
      // History is never deleted or rewritten: the two pre-existing failed
      // rows and the one success row keep their exact prior shape.
      expect(after.find((row) => row.id === failedBefore.id)).toEqual(failedBefore);
      expect(after.find((row) => row.id === failed2Before.id)).toEqual(failed2Before);
      expect(after.find((row) => row.id === successBefore.id)).toEqual(successBefore);

      expect(fake.audits[0]).toMatchObject({
        action: TASK_ABORT_AUDIT_ACTION,
        actorId: admin.identity.id,
        reason: REASON,
      });
    },
  );

  it("is irreversible: a second, independent abort attempt on an already-aborted task is refused, not a silent no-op", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const dependencies = () => ({ db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW });
    const fake = new TaskAdminFakeDb();
    fake.parents.get("generic")!.status = "pending";

    const firstTicket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/abort" });
    await abortTask({ ...firstTicket, family: "generic", taskId: TASK_ID }, dependencies());
    expect(fake.parents.get("generic")!.status).toBe("disabled");

    const secondTicket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/abort" });
    await expect(abortTask({ ...secondTicket, family: "generic", taskId: TASK_ID }, dependencies()))
      .rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
  });

  it("safely replays the same committed request id instead of aborting twice", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/abort" });
    const fake = new TaskAdminFakeDb();
    fake.parents.get("generic")!.status = "pending";
    const dependencies = { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
    const input = { ...ticket, family: "generic" as const, taskId: TASK_ID, reason: REASON };

    const first = await abortTask(input, dependencies);
    const replay = await abortTask(input, dependencies);
    expect(first.wrote).toBe(true);
    expect(replay).toMatchObject({ wrote: false, auditId: first.auditId, terminatedPendingItemCount: first.terminatedPendingItemCount });
    expect(fake.audits).toHaveLength(1);
  });

  it("can abort a manually-paused task (disabled + paused marker), not only an active one", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/abort" });
    const fake = new TaskAdminFakeDb();
    const parent = fake.parents.get("generic")!;
    parent.status = "disabled";
    parent.result = mergeTaskControlResult(parent.result, pausedMarker(admin.identity.id));

    const result = await abortTask(
      { ...ticket, family: "generic", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    );
    expect(result).toMatchObject({ status: "disabled", wrote: true });
  });

  it("refuses to abort a task in a genuinely terminal state (nothing left to stop)", async () => {
    const stores = newStores();
    const admin = seedTaskAdmin(stores);
    const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname: "/api/admin/tasks/abort" });
    const fake = new TaskAdminFakeDb(); // default: completed_with_errors, no marker
    await expect(abortTask(
      { ...ticket, family: "generic", taskId: TASK_ID },
      { db: fake.asPrismaClient(), identities: stores, sessions: stores, now: NOW },
    )).rejects.toBeInstanceOf(TaskAdminError);
  });
});
