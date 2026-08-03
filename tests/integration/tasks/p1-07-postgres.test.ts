import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LeaseLostError,
  PERSISTED_TASK_ERROR_MESSAGE_MAX_LENGTH,
  buildWorkerAllowlist,
  claimPendingItem,
  createHandlerRegistry,
  enqueueScheduledTask,
  finalizeTaskItem,
  heartbeatTaskItem,
  markSideEffectUnknown,
  prepareSideEffectIntent,
  recoverExpiredItem,
  transitionSideEffectIntent,
  type TaskLease,
} from "@/lib/tasks";
import { processOneWorkerCycle } from "../../../worker/runtime";

const enabled = process.env.P1_07_DATABASE_TEST === "1";
const prisma = new PrismaClient();
const clients: PrismaClient[] = [];

const ids = {
  channel: "00000000-0000-4000-8000-000000000701",
  source: "10000000-0000-4000-8000-000000000701",
  app: "20000000-0000-4000-8000-000000000701",
  account: "30000000-0000-4000-8000-000000000701",
  sourceItem: "50000000-0000-4000-8000-000000000701",
} as const;

function client(applicationName?: string): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL;
  const value = applicationName && databaseUrl
    ? new PrismaClient({
      datasourceUrl: `${databaseUrl}&application_name=${encodeURIComponent(applicationName)}`,
    })
    : new PrismaClient();
  clients.push(value);
  return value;
}

async function truncateDatabase() {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
  await executeBatch(`
    INSERT INTO channel (id, code, name, updated_at)
    VALUES ('${ids.channel}', 'p107-channel', 'P1-07 Channel', now());
    INSERT INTO source_app (id, code, name, updated_at)
    VALUES ('${ids.source}', 'p107-source', 'P1-07 Source', now());
    INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, updated_at)
    VALUES ('${ids.app}', '${ids.channel}', '${ids.source}', 'p107-app', 2, now());
    INSERT INTO channel_account (id, channel_id, business_id, account_name, updated_at)
    VALUES ('${ids.account}', '${ids.channel}', 'p107-account', 'P1-07 Account', now());
    INSERT INTO novel_source_item (
      id, channel_app_id, external_book_id, source_language_code,
      title, description, status, raw_payload, updated_at
    ) VALUES (
      '${ids.sourceItem}', '${ids.app}', 'p107-book', 'en',
      'P1-07 Book', '', 'pending', '{}', now()
    )
  `);
}

async function executeBatch(sql: string) {
  for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function createGenericTask(targetId = randomUUID()) {
  return prisma.genericTask.create({
    data: {
      taskType: "runtime.test",
      operationScopeHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      requestToken: randomUUID(),
      totalCount: 1,
      items: { create: [{ targetType: "test", targetId, payload: { targetId } }] },
    },
    include: { items: true },
  });
}

async function createGenericTaskWithItems(count: number) {
  const prefix = randomUUID();
  return prisma.genericTask.create({
    data: {
      taskType: "runtime.test",
      operationScopeHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      requestToken: randomUUID(),
      totalCount: count,
      items: {
        create: Array.from({ length: count }, (_, index) => ({
          targetType: "test",
          targetId: `${prefix}-${index}`,
          payload: { index },
        })),
      },
    },
    include: { items: true },
  });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for PostgreSQL barrier");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForLockWaiters(applicationNames: string[]): Promise<void> {
  await waitFor(async () => {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM pg_stat_activity
      WHERE application_name IN (${Prisma.join(applicationNames)})
        AND wait_event_type = 'Lock'
    `);
    return Number(rows[0]?.count ?? 0n) === applicationNames.length;
  });
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function expireGenericItem(itemId: string) {
  await prisma.$executeRawUnsafe(
    `UPDATE generic_task_item SET locked_until = transaction_timestamp() - interval '1 second' WHERE id = $1::uuid`,
    itemId,
  );
}

function collectIndexNames(node: unknown, output = new Set<string>()) {
  if (Array.isArray(node)) {
    for (const value of node) collectIndexNames(value, output);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "Index Name" && typeof value === "string") output.add(value);
      collectIndexNames(value, output);
    }
  }
  return output;
}

async function explainIndex(sql: string, expected: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
  );
  const names = collectIndexNames(rows[0]["QUERY PLAN"]);
  expect([...names], `Expected ${expected} in plan`).toContain(expected);
  return [...names];
}

describe.skipIf(!enabled).sequential("P1-07 PostgreSQL 16 runtime", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName, version }] = await prisma.$queryRawUnsafe<
      Array<{ database_name: string; version: string }>
    >(`SELECT current_database() AS database_name, current_setting('server_version') AS version`);
    if (!databaseName.includes("p1_07")) {
      throw new Error(`Refusing destructive P1-07 tests against ${databaseName}`);
    }
    if (!version.startsWith("16.")) throw new Error(`P1-07 requires PostgreSQL 16, got ${version}`);
  });

  beforeEach(async () => {
    await truncateDatabase();
  });

  afterAll(async () => {
    await Promise.all(clients.map((value) => value.$disconnect()));
    await prisma.$disconnect();
  });

  it("gives one pending item to only one of two concurrent workers", async () => {
    const task = await createGenericTask();
    const workerA = client();
    const workerB = client();
    const claims = await Promise.all([
      claimPendingItem(workerA, {
        family: "generic", taskTypes: ["runtime.test"], workerId: "worker-a", leaseMs: 60_000,
      }),
      claimPendingItem(workerB, {
        family: "generic", taskTypes: ["runtime.test"], workerId: "worker-b", leaseMs: 60_000,
      }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const item = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } });
    expect(item.status).toBe("processing");
    expect(item.attemptCount).toBe(1);
    expect(item.leaseEpoch).toBe(1n);
    expect(item.lockedBy).toBe(claims.find(Boolean)?.workerId);
  });

  it("does zero consumption with an empty allowlist", async () => {
    const task = await createGenericTask();
    const claim = await claimPendingItem(prisma, {
      family: "generic", taskTypes: [], workerId: "worker-a", leaseMs: 60_000,
    });
    expect(claim).toBeNull();
    const item = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } });
    expect(item).toMatchObject({ status: "pending", attemptCount: 0, leaseEpoch: 0n });
  });

  it("executes the fixed claim SQL for all three task families", async () => {
    await executeBatch(`
      INSERT INTO catalog_scan_task (
        id, channel_account_id, channel_app_id, project_type, request_token,
        page_start, page_end, page_size, updated_at
      ) VALUES (
        'a7100000-0000-4000-8000-000000000001', '${ids.account}', '${ids.app}', 8,
        'p107-claim-catalog', 1, 1, 20, now()
      );
      INSERT INTO catalog_scan_task_item (
        id, task_id, page_index, request_fingerprint, updated_at
      ) VALUES (
        'b7100000-0000-4000-8000-000000000001',
        'a7100000-0000-4000-8000-000000000001', 1, repeat('a', 64), now()
      );
      INSERT INTO channel_sync_task (
        id, task_type, channel_account_id, channel_app_id, operation_scope_hash,
        request_token, updated_at
      ) VALUES (
        'a7100000-0000-4000-8000-000000000002', 'runtime.channel',
        '${ids.account}', '${ids.app}', repeat('b', 64), 'p107-claim-channel', now()
      );
      INSERT INTO channel_sync_task_item (
        id, task_id, novel_source_item_id, updated_at
      ) VALUES (
        'b7100000-0000-4000-8000-000000000002',
        'a7100000-0000-4000-8000-000000000002', '${ids.sourceItem}', now()
      )
    `);
    await createGenericTask();
    const catalog = await claimPendingItem(prisma, {
      family: "catalog_scan", taskTypes: ["catalog_scan"], workerId: "worker-catalog", leaseMs: 60_000,
    });
    const channel = await claimPendingItem(prisma, {
      family: "channel_sync", taskTypes: ["runtime.channel"], workerId: "worker-channel", leaseMs: 60_000,
    });
    const generic = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], workerId: "worker-generic", leaseMs: 60_000,
    });
    expect(catalog).toMatchObject({ family: "catalog_scan", taskType: "catalog_scan", attemptCount: 1 });
    expect(channel).toMatchObject({ family: "channel_sync", taskType: "runtime.channel", attemptCount: 1 });
    expect(generic).toMatchObject({ family: "generic", taskType: "runtime.test", attemptCount: 1 });
  });

  it("keeps lease_epoch stable across heartbeat", async () => {
    await createGenericTask();
    const lease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], workerId: "worker-a", leaseMs: 2_000,
    });
    expect(lease).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await heartbeatTaskItem(prisma, lease!, 10_000)).toBe(true);
    const item = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: lease!.itemId } });
    expect(item.leaseEpoch).toBe(lease!.leaseEpoch);
    expect(item.lockedUntil!.getTime()).toBeGreaterThan(lease!.lockedUntil.getTime());
  });

  it("recovers expired lease through pending and fences the old owner", async () => {
    await createGenericTask();
    const oldLease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], workerId: "worker-old", leaseMs: 60_000,
    });
    await expireGenericItem(oldLease!.itemId);
    const recovery = await recoverExpiredItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], maxAttemptsByType: { "runtime.test": 3 },
    });
    expect(recovery).toMatchObject({ action: "requeued", attemptCount: 1, leaseEpoch: 1n });
    const newLease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], workerId: "worker-new", leaseMs: 60_000,
    });
    expect(newLease).toMatchObject({ attemptCount: 2, leaseEpoch: 2n });
    expect(newLease!.executionToken).not.toBe(oldLease!.executionToken);

    let protectedWriteRan = false;
    await expect(
      finalizeTaskItem(prisma, oldLease!, {
        status: "success",
        protectedWrite: async () => {
          protectedWriteRan = true;
        },
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(protectedWriteRan).toBe(false);
    await finalizeTaskItem(prisma, newLease!, { status: "success", result: { owner: "new" } });
    const item = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: newLease!.itemId } });
    const parent = await prisma.genericTask.findUniqueOrThrow({ where: { id: newLease!.taskId } });
    expect(item.status).toBe("success");
    expect(parent).toMatchObject({ status: "completed", successCount: 1, failedCount: 0 });
  });

  it("serializes same-parent recompute before taking a fresh aggregate snapshot", async () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const task = await createGenericTaskWithItems(2);
      const appA = `p107-parent-a-${iteration}`;
      const appB = `p107-parent-b-${iteration}`;
      const workerA = client(appA);
      const workerB = client(appB);
      const gate = client();
      const leaseA = await claimPendingItem(workerA, {
        family: "generic", taskTypes: ["runtime.test"], workerId: appA, leaseMs: 60_000,
      });
      const leaseB = await claimPendingItem(workerB, {
        family: "generic", taskTypes: ["runtime.test"], workerId: appB, leaseMs: 60_000,
      });
      expect(leaseA?.taskId).toBe(task.id);
      expect(leaseB?.taskId).toBe(task.id);

      let announceLocked!: () => void;
      let releaseGate!: () => void;
      const locked = new Promise<void>((resolve) => { announceLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseGate = resolve; });
      const gatePromise = gate.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM generic_task WHERE id = ${task.id}::uuid FOR UPDATE
        `);
        announceLocked();
        await release;
      }, { timeout: 10_000 });
      await locked;

      const finalizeA = finalizeTaskItem(workerA, leaseA!, { status: "success" });
      const finalizeB = finalizeTaskItem(workerB, leaseB!, { status: "success" });
      try {
        await waitForLockWaiters([appA, appB]);
      } finally {
        releaseGate();
      }
      await gatePromise;
      await Promise.all([finalizeA, finalizeB]);

      const items = await prisma.genericTaskItem.groupBy({
        by: ["status"], where: { taskId: task.id }, _count: true,
      });
      const parent = await prisma.genericTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(items).toEqual([{ status: "success", _count: 2 }]);
      expect(parent).toMatchObject({
        status: "completed", totalCount: 2, successCount: 2, failedCount: 0,
      });
    }
  }, 30_000);

  it("does not serialize recompute for different parents", async () => {
    const taskA = await createGenericTask();
    const taskB = await createGenericTask();
    const appA = "p107-independent-parent-a";
    const workerA = client(appA);
    const workerB = client("p107-independent-parent-b");
    const gate = client();
    const leaseA = await claimPendingItem(workerA, {
      family: "generic", taskTypes: ["runtime.test"], workerId: appA, leaseMs: 60_000,
    });
    const leaseB = await claimPendingItem(workerB, {
      family: "generic", taskTypes: ["runtime.test"], workerId: "independent-b", leaseMs: 60_000,
    });
    expect(new Set([leaseA?.taskId, leaseB?.taskId])).toEqual(new Set([taskA.id, taskB.id]));
    expect(leaseA?.taskId).not.toBe(leaseB?.taskId);

    let announceLocked!: () => void;
    let releaseGate!: () => void;
    const locked = new Promise<void>((resolve) => { announceLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseGate = resolve; });
    const gatePromise = gate.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM generic_task WHERE id = ${leaseA!.taskId}::uuid FOR UPDATE
      `);
      announceLocked();
      await release;
    }, { timeout: 10_000 });
    await locked;

    const blockedFinalize = finalizeTaskItem(workerA, leaseA!, { status: "success" });
    try {
      await waitForLockWaiters([appA]);
      await within(finalizeTaskItem(workerB, leaseB!, { status: "success" }), 2_000);
      expect(await prisma.genericTask.findUniqueOrThrow({ where: { id: leaseB!.taskId } }))
        .toMatchObject({ status: "completed", successCount: 1 });
    } finally {
      releaseGate();
    }
    await gatePromise;
    await blockedFinalize;
  }, 15_000);

  it("persists only bounded and redacted task error fields", async () => {
    await createGenericTask();
    const lease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], workerId: "worker-error", leaseMs: 60_000,
    });
    await finalizeTaskItem(prisma, lease!, {
      status: "failed",
      error: {
        code: "UPSTREAM_FAILURE",
        message: `Authorization: Bearer abc-secret api_key=abc-secret password=abc-secret ${"x".repeat(4_096)}`,
        stack: "private stack abc-secret",
        cause: { responseBody: "abc-secret" },
      },
    });
    const item = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: lease!.itemId } });
    const error = item.error as { code: string; message: string; stack?: unknown };
    expect(Object.keys(error).sort()).toEqual(["code", "message"]);
    expect(error.code).toBe("upstream_failure");
    expect(error.message.length).toBeLessThanOrEqual(PERSISTED_TASK_ERROR_MESSAGE_MAX_LENGTH);
    expect(JSON.stringify(error)).not.toContain("abc-secret");
    expect(error).not.toHaveProperty("stack");
  });

  it("terminalizes poison items when the claim budget is exhausted", async () => {
    const task = await createGenericTask();
    await prisma.genericTaskItem.update({
      where: { id: task.items[0].id },
      data: {
        status: "processing", attemptCount: 3, leaseEpoch: 3n,
        executionToken: randomUUID(), lockedBy: "poison-worker",
        lockedUntil: new Date(Date.now() - 1_000),
      },
    });
    const recovery = await recoverExpiredItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], maxAttemptsByType: { "runtime.test": 3 },
    });
    expect(recovery?.action).toBe("failed");
    const item = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } });
    const parent = await prisma.genericTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(item.status).toBe("failed");
    expect(parent.status).toBe("failed");
  });

  it("recovers after a real worker child process is killed and restarted", async () => {
    const task = await createGenericTask();
    const executable = path.join(process.cwd(), "node_modules/.bin/vite-node");
    const fixture = path.join(process.cwd(), "tests/integration/tasks/fixtures/claim-and-hang.ts");
    const child = spawn(executable, [fixture], {
      cwd: process.cwd(),
      env: { ...process.env, P1_07_CHILD_WORKER_ID: "killed-worker", P1_07_CHILD_LEASE_MS: "60000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Child claim timeout: ${stderr}`)), 15_000);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("P1_07_CHILD_CLAIMED=")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Child exited before claim (${code}): ${stderr}`));
      });
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await expireGenericItem(task.items[0].id);
    await recoverExpiredItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], maxAttemptsByType: { "runtime.test": 3 },
    });
    const restarted = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], workerId: "restarted-worker", leaseMs: 60_000,
    });
    expect(restarted).toMatchObject({ workerId: "restarted-worker", attemptCount: 2, leaseEpoch: 2n });
  }, 25_000);

  it("drains an abort-aware handler inside the shutdown deadline", async () => {
    const task = await createGenericTask();
    const controller = new AbortController();
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const handlers = createHandlerRegistry({
      "runtime.test": {
        family: "generic",
        handler: async ({ signal }) => {
          announceStarted();
          if (!signal.aborted) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          }
          return { status: "success", result: { shutdown: "cooperative" } };
        },
      },
    });
    const running = processOneWorkerCycle({
      prisma,
      workerId: "worker-cooperative-shutdown",
      handlers,
      allowlist: buildWorkerAllowlist("runtime.test", handlers),
      signal: controller.signal,
      leaseMs: 500,
      shutdownDrainTimeoutMs: 250,
    });
    await started;
    controller.abort();
    expect(await within(running, 1_000)).toBe(true);
    expect(await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } }))
      .toMatchObject({ status: "success", result: { shutdown: "cooperative" } });
  });

  it("bounds an abort-ignoring handler and fences its late result", async () => {
    const task = await createGenericTask();
    const controller = new AbortController();
    let announceStarted!: () => void;
    let releaseLate!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const late = new Promise<void>((resolve) => { releaseLate = resolve; });
    let oldLease: TaskLease | undefined;
    const handlers = createHandlerRegistry({
      "runtime.test": {
        family: "generic",
        handler: async ({ lease }) => {
          oldLease = lease;
          announceStarted();
          await late;
          return { status: "success", result: { owner: "late-old" } };
        },
      },
    });
    const running = processOneWorkerCycle({
      prisma,
      workerId: "worker-ignores-abort",
      handlers,
      allowlist: buildWorkerAllowlist("runtime.test", handlers),
      signal: controller.signal,
      leaseMs: 150,
      shutdownDrainTimeoutMs: 40,
    });
    await started;
    controller.abort();
    expect(await within(running, 1_000)).toBe(true);

    const stopped = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } });
    await waitFor(async () => {
      const rows = await prisma.$queryRaw<Array<{ expired: boolean }>>(Prisma.sql`
        SELECT locked_until < transaction_timestamp() AS expired
        FROM generic_task_item WHERE id = ${task.items[0].id}::uuid
      `);
      return rows[0]?.expired === true;
    }, 2_000);
    const expired = await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } });
    expect(expired.heartbeatAt?.getTime()).toBe(stopped.heartbeatAt?.getTime());

    expect(await recoverExpiredItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], maxAttemptsByType: { "runtime.test": 3 },
    })).toMatchObject({ action: "requeued", leaseEpoch: 1n });
    const newLease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["runtime.test"], workerId: "worker-after-timeout", leaseMs: 60_000,
    });
    expect(newLease).toMatchObject({ attemptCount: 2, leaseEpoch: 2n });
    expect(newLease!.executionToken).not.toBe(oldLease!.executionToken);
    await finalizeTaskItem(prisma, newLease!, { status: "success", result: { owner: "new" } });

    releaseLate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(finalizeTaskItem(prisma, oldLease!, {
      status: "success", result: { owner: "late-old" },
    })).rejects.toBeInstanceOf(LeaseLostError);
    expect(await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } }))
      .toMatchObject({ status: "success", result: { owner: "new" } });
  }, 10_000);

  it("allows exactly one of ten concurrent schedulers to enqueue", async () => {
    const registry = createHandlerRegistry({
      "runtime.test": { family: "generic", handler: async () => ({ status: "success" }) },
    });
    const scheduledFor = new Date("2026-08-03T00:00:00.000Z");
    const schedulers = Array.from({ length: 10 }, () => client());
    const results = await Promise.all(
      schedulers.map((db) => enqueueScheduledTask(db, registry, {
        scheduleKey: "p1-07-concurrency", scheduleRevision: 1, scheduledFor,
        timezone: "UTC", taskType: "runtime.test",
        items: [{ targetType: "test", targetId: "scheduled-target" }],
      })),
    );
    expect(results.filter((result) => result.status === "enqueued")).toHaveLength(1);
    expect(results.filter((result) => result.status === "duplicate")).toHaveLength(9);
    expect(await prisma.scheduleRun.count()).toBe(1);
    expect(await prisma.cronRun.count()).toBe(1);
    expect(await prisma.genericTask.count()).toBe(1);
    expect(await prisma.genericTaskItem.count()).toBe(1);
  });

  it("rolls CronRun and Task back together on an injected failure", async () => {
    const registry = createHandlerRegistry({
      "runtime.test": { family: "generic", handler: async () => ({ status: "success" }) },
    });
    await expect(enqueueScheduledTask(prisma, registry, {
      scheduleKey: "p1-07-rollback", scheduleRevision: 1,
      scheduledFor: new Date("2026-08-03T01:00:00.000Z"), timezone: "UTC",
      taskType: "runtime.test", items: [{ targetType: "test", targetId: "rollback" }],
    }, {
      afterTaskCreated: () => { throw new Error("manufactured scheduler failure"); },
    })).rejects.toThrow("manufactured scheduler failure");
    expect(await prisma.scheduleRun.count()).toBe(0);
    expect(await prisma.cronRun.count()).toBe(0);
    expect(await prisma.genericTask.count()).toBe(0);
    expect(await prisma.genericTaskItem.count()).toBe(0);
  });

  it("commits side-effect intent independently and blocks unknown retry", async () => {
    const input = {
      effectKey: "a".repeat(64), idempotencyKey: "b".repeat(64),
      operationType: "test.effect", targetType: "test", targetId: "target-1",
    };
    const contenders = Array.from({ length: 10 }, () => client());
    const results = await Promise.all(contenders.map((db) => prepareSideEffectIntent(db, input)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const observer = client();
    expect(await observer.sideEffectIntent.findUnique({ where: { effectKey: input.effectKey } }))
      .toMatchObject({ status: "prepared" });
    await markSideEffectUnknown(prisma, input.effectKey, { outcome: "unknown" });
    await expect(transitionSideEffectIntent(prisma, {
      effectKey: input.effectKey, status: "confirmed",
    })).rejects.toThrow("Illegal side-effect transition");
    expect(await prisma.sideEffectIntent.findUniqueOrThrow({ where: { effectKey: input.effectKey } }))
      .toMatchObject({ status: "claim_retry_blocked" });
  });

  it("uses all six independent pending and expired indexes", async () => {
    await executeBatch(`
      INSERT INTO catalog_scan_task (
        id, channel_account_id, channel_app_id, project_type, request_token,
        page_start, page_end, page_size, status, updated_at
      ) VALUES (
        'a7000000-0000-4000-8000-000000000001', '${ids.account}', '${ids.app}', 7,
        'p107-explain-catalog', 1, 6000, 20, 'processing', now()
      );
      INSERT INTO channel_sync_task (
        id, task_type, channel_account_id, channel_app_id, operation_scope_hash,
        request_token, status, updated_at
      ) VALUES (
        'a7000000-0000-4000-8000-000000000002', 'runtime.test', '${ids.account}', '${ids.app}',
        repeat('c', 64), 'p107-explain-channel', 'processing', now()
      );
      INSERT INTO generic_task (
        id, task_type, operation_scope_hash, request_token, status, updated_at
      ) VALUES (
        'a7000000-0000-4000-8000-000000000003', 'runtime.test', repeat('g', 64),
        'p107-explain-generic', 'processing', now()
      );
      INSERT INTO novel_source_item (
        id, channel_app_id, external_book_id, source_language_code,
        title, description, status, raw_payload, updated_at
      ) SELECT
        ('e7000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        '${ids.app}', 'p107-explain-' || gs, 'en', 'Explain ' || gs,
        '', 'pending', '{}', now()
      FROM generate_series(1, 6000) gs;
      INSERT INTO catalog_scan_task_item (
        id, task_id, page_index, request_fingerprint, status, attempt_count,
        execution_token, lease_epoch, locked_by, locked_until, updated_at
      ) SELECT
        ('b7000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        'a7000000-0000-4000-8000-000000000001', gs, repeat(md5(gs::text), 2),
        CASE WHEN gs <= 20 THEN 'pending' WHEN gs <= 40 THEN 'processing' ELSE 'success' END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN ('c7000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 'worker' END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN now() - interval '1 hour' END, now()
      FROM generate_series(1, 6000) gs;
      INSERT INTO channel_sync_task_item (
        id, task_id, novel_source_item_id, status, attempt_count, execution_token,
        lease_epoch, locked_by, locked_until, updated_at
      ) SELECT
        ('d7000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        'a7000000-0000-4000-8000-000000000002',
        ('e7000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        CASE WHEN gs <= 20 THEN 'pending' WHEN gs <= 40 THEN 'processing' ELSE 'success' END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN ('f7000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 'worker' END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN now() - interval '1 hour' END, now()
      FROM generate_series(1, 6000) gs;
      INSERT INTO generic_task_item (
        id, task_id, target_type, target_id, status, attempt_count, execution_token,
        lease_epoch, locked_by, locked_until, updated_at
      ) SELECT
        ('17000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        'a7000000-0000-4000-8000-000000000003', 'test', gs::text,
        CASE WHEN gs <= 20 THEN 'pending' WHEN gs <= 40 THEN 'processing' ELSE 'success' END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN ('27000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 'worker' END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN now() - interval '1 hour' END, now()
      FROM generate_series(1, 6000) gs;
      ANALYZE catalog_scan_task_item;
      ANALYZE channel_sync_task_item;
      ANALYZE generic_task_item
    `);
    const plans: Record<string, { pending: string[]; expired: string[] }> = {
      catalog_scan_task_item: {
        pending: await explainIndex(`
          WITH candidates AS MATERIALIZED (
            SELECT i.id, i.task_id, i.created_at AS cursor_at
            FROM catalog_scan_task_item i WHERE i.status = 'pending'
            ORDER BY i.created_at, i.id LIMIT 128 FOR UPDATE OF i SKIP LOCKED
          )
          SELECT c.id FROM candidates c JOIN catalog_scan_task t ON t.id = c.task_id
          WHERE t.status IN ('pending', 'processing') ORDER BY c.cursor_at, c.id LIMIT 1
        `, "catalog_scan_task_item_pending_global_idx"),
        expired: await explainIndex(`
          WITH candidates AS MATERIALIZED (
            SELECT i.id, i.locked_until AS cursor_at FROM catalog_scan_task_item i
            WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
            ORDER BY i.locked_until, i.id LIMIT 128 FOR UPDATE OF i SKIP LOCKED
          ) SELECT id FROM candidates ORDER BY cursor_at, id LIMIT 1
        `, "catalog_scan_task_item_expired_lease_idx"),
      },
      channel_sync_task_item: {
        pending: await explainIndex(`
          WITH candidates AS MATERIALIZED (
            SELECT i.id, i.task_id, i.created_at AS cursor_at
            FROM channel_sync_task_item i WHERE i.status = 'pending'
            ORDER BY i.created_at, i.id LIMIT 128 FOR UPDATE OF i SKIP LOCKED
          )
          SELECT c.id FROM candidates c JOIN channel_sync_task t ON t.id = c.task_id
          WHERE t.status IN ('pending', 'processing')
            AND t.task_type = ANY(ARRAY['runtime.test']::text[])
          ORDER BY c.cursor_at, c.id LIMIT 1
        `, "channel_sync_task_item_pending_global_idx"),
        expired: await explainIndex(`
          WITH candidates AS MATERIALIZED (
            SELECT i.id, i.task_id, i.locked_until AS cursor_at
            FROM channel_sync_task_item i
            WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
            ORDER BY i.locked_until, i.id LIMIT 128 FOR UPDATE OF i SKIP LOCKED
          )
          SELECT c.id FROM candidates c JOIN channel_sync_task t ON t.id = c.task_id
          WHERE t.task_type = ANY(ARRAY['runtime.test']::text[])
          ORDER BY c.cursor_at, c.id LIMIT 1
        `, "channel_sync_task_item_expired_lease_idx"),
      },
      generic_task_item: {
        pending: await explainIndex(`
          WITH candidates AS MATERIALIZED (
            SELECT i.id, i.task_id, i.created_at AS cursor_at
            FROM generic_task_item i WHERE i.status = 'pending'
            ORDER BY i.created_at, i.id LIMIT 128 FOR UPDATE OF i SKIP LOCKED
          )
          SELECT c.id FROM candidates c JOIN generic_task t ON t.id = c.task_id
          WHERE t.status IN ('pending', 'processing')
            AND t.task_type = ANY(ARRAY['runtime.test']::text[])
          ORDER BY c.cursor_at, c.id LIMIT 1
        `, "generic_task_item_pending_global_idx"),
        expired: await explainIndex(`
          WITH candidates AS MATERIALIZED (
            SELECT i.id, i.task_id, i.locked_until AS cursor_at
            FROM generic_task_item i
            WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()
            ORDER BY i.locked_until, i.id LIMIT 128 FOR UPDATE OF i SKIP LOCKED
          )
          SELECT c.id FROM candidates c JOIN generic_task t ON t.id = c.task_id
          WHERE t.task_type = ANY(ARRAY['runtime.test']::text[])
          ORDER BY c.cursor_at, c.id LIMIT 1
        `, "generic_task_item_expired_lease_idx"),
      },
    };
    process.stdout.write(`P1_07_INDEX_PLANS=${JSON.stringify(plans)}\n`);
  }, 60_000);
});
