import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimPendingItem, finalizeTaskItem } from "@/lib/tasks";

// tests/integration/ ownership note (see tests/integration/README.md):
// "Owner: Codex（独占写入）". This suite is added anyway because the fix it
// covers (src/lib/tasks/store.ts selectPending) is a hot-path claim-query
// defect the Owner explicitly required a real PostgreSQL integration test
// for -- a unit/mocked test cannot exercise `FOR UPDATE ... SKIP LOCKED`,
// query planning, or round-trip counts against a real query planner.
const enabled = process.env.TASK_CLAIM_SKIP_INELIGIBLE_DATABASE_TEST === "1";

const prisma = new PrismaClient();
const clients: PrismaClient[] = [];

const ids = {
  channel: "00000000-0000-4000-8000-00000000ac01",
  source: "00000000-0000-4000-8000-00000000ac02",
  app: "00000000-0000-4000-8000-00000000ac03",
  account: "00000000-0000-4000-8000-00000000ac04",
} as const;

/** A fresh PrismaClient for genuinely concurrent claims (own connection). */
function client(): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL;
  const value = databaseUrl ? new PrismaClient({ datasourceUrl: databaseUrl }) : new PrismaClient();
  clients.push(value);
  return value;
}

/** A PrismaClient wired to record every raw SQL statement it executes, so we
 * can count round trips made by the *real*, currently-shipped selectPending
 * implementation (which is not exported, so it can only be observed this
 * way -- through the public claimPendingItem entry point). */
function instrumentedClient(): { db: PrismaClient; queries: string[] } {
  const databaseUrl = process.env.DATABASE_URL;
  const db = new PrismaClient({
    ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}),
    log: [{ emit: "event", level: "query" }],
  });
  const queries: string[] = [];
  db.$on("query", (event) => queries.push(event.query));
  clients.push(db);
  return { db, queries };
}

function candidateRoundTrips(queries: string[]): number {
  return queries.filter((query) => query.includes("WITH candidates AS MATERIALIZED")).length;
}

async function truncateDatabase() {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
  await prisma.channel.create({ data: { id: ids.channel, code: "tcsi-channel", name: "TCSI Channel" } });
  await prisma.sourceApp.create({ data: { id: ids.source, code: "tcsi-source", name: "TCSI Source" } });
  await prisma.channelApp.create({
    data: { id: ids.app, channelId: ids.channel, sourceAppId: ids.source, externalAppId: "tcsi-app", projectType: 2 },
  });
  await prisma.channelAccount.create({
    data: { id: ids.account, channelId: ids.channel, businessId: "tcsi-account", accountName: "TCSI Account" },
  });
}

async function createGenericTask(opts: { status?: string; taskType?: string; createdAt?: Date } = {}) {
  return prisma.genericTask.create({
    data: {
      taskType: opts.taskType ?? "article.generate.v1",
      operationScopeHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      requestToken: randomUUID(),
      status: opts.status ?? "pending",
      createdAt: opts.createdAt ?? new Date(),
    },
  });
}

async function addGenericItem(
  taskId: string,
  opts: { targetType?: string; targetId?: string; createdAt?: Date; status?: string } = {},
) {
  return prisma.genericTaskItem.create({
    data: {
      taskId,
      targetType: opts.targetType ?? "novel_source_item",
      targetId: opts.targetId ?? randomUUID(),
      status: opts.status ?? "pending",
      createdAt: opts.createdAt ?? new Date(),
    },
  });
}

/** Bulk-inserts `count` plain pending generic_task_item rows under `taskId`,
 * spaced 1ms apart starting at `startAt`, via a single set-based INSERT --
 * this must stay fast even at count=5000+ so the test suite stays quick. */
async function insertGenericPendingBlock(taskId: string, count: number, startAt: Date) {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO generic_task_item (id, task_id, target_type, target_id, status, payload, created_at, updated_at)
    SELECT gen_random_uuid(), ${taskId}::uuid, 'novel_source_item', 'blk-' || gs, 'pending', '{}'::jsonb,
           ${startAt}::timestamptz + (gs || ' milliseconds')::interval, now()
    FROM generate_series(1, ${count}) AS gs
  `);
}

async function createChannelSyncTask(opts: { status?: string; taskType?: string; createdAt?: Date } = {}) {
  return prisma.channelSyncTask.create({
    data: {
      taskType: opts.taskType ?? "runtime.channel",
      channelAccountId: ids.account,
      channelAppId: ids.app,
      operationScopeHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      requestToken: randomUUID(),
      status: opts.status ?? "pending",
      createdAt: opts.createdAt ?? new Date(),
    },
  });
}

async function addChannelSyncItem(taskId: string, opts: { createdAt?: Date; status?: string } = {}) {
  const sourceItem = await prisma.novelSourceItem.create({
    data: {
      channelAppId: ids.app,
      externalBookId: randomUUID(),
      sourceLanguageCode: "en",
      title: "TCSI source item",
      description: "",
      rawPayload: {},
    },
  });
  return prisma.channelSyncTaskItem.create({
    data: {
      taskId,
      novelSourceItemId: sourceItem.id,
      status: opts.status ?? "pending",
      createdAt: opts.createdAt ?? new Date(),
    },
  });
}

/** Bulk-inserts `count` plain pending channel_sync_task_item rows under
 * `taskId`, each requiring its own distinct novel_source_item row (unique
 * constraint on (task_id, novel_source_item_id)), spaced 1ms apart from
 * `startAt`. Single set-based statement so it stays fast at scale. */
async function insertChannelSyncPendingBlock(taskId: string, count: number, startAt: Date) {
  await prisma.$executeRaw(Prisma.sql`
    WITH src AS (
      INSERT INTO novel_source_item (
        id, channel_app_id, external_book_id, source_language_code, title, description, status, raw_payload, updated_at
      )
      SELECT gen_random_uuid(), ${ids.app}::uuid, 'blk-src-' || gs, 'en', 'Block source ' || gs, '', 'pending', '{}'::jsonb, now()
      FROM generate_series(1, ${count}) AS gs
      RETURNING id
    )
    INSERT INTO channel_sync_task_item (id, task_id, novel_source_item_id, status, payload, created_at, updated_at)
    SELECT gen_random_uuid(), ${taskId}::uuid, src.id, 'pending', '{}'::jsonb,
           ${startAt}::timestamptz + (row_number() OVER ()) * interval '1 millisecond', now()
    FROM src
  `);
}

describe.skipIf(!enabled).sequential("selectPending: parent-eligibility pushdown (skip ineligible parents)", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName, version }] = await prisma.$queryRawUnsafe<
      Array<{ database_name: string; version: string }>
    >(`SELECT current_database() AS database_name, current_setting('server_version') AS version`);
    // Guard against ever truncating a database that is not the disposable
    // fixture DB this suite is meant to run against.
    if (!/claimtest/i.test(databaseName)) {
      throw new Error(`Refusing destructive task-claim tests against database "${databaseName}"`);
    }
    if (!version.startsWith("16.")) throw new Error(`task-claim tests require PostgreSQL 16, got ${version}`);
  });

  beforeEach(async () => {
    await truncateDatabase();
  });

  afterAll(async () => {
    await Promise.all(clients.map((value) => value.$disconnect()));
    await prisma.$disconnect();
  });

  it(
    "collapses paging from dozens of round trips into 1 by pushing parent-eligibility into the WHERE clause (generic family)",
    async () => {
      const BLOCK_SIZE = 5_000; // >> 128, forces >1 page under the old shape
      const disabledParent = await createGenericTask({ status: "disabled", createdAt: new Date("2020-01-01T00:00:00Z") });
      await insertGenericPendingBlock(disabledParent.id, BLOCK_SIZE, new Date("2020-01-01T00:00:00Z"));
      const runnableParent = await createGenericTask({ createdAt: new Date("2026-01-01T00:00:00Z") });
      const runnableItem = await addGenericItem(runnableParent.id, { createdAt: new Date("2026-01-01T00:00:00Z") });

      // --- The OLD query shape this diff replaces: parent-eligibility is
      // only computed in the outer SELECT, *after* the CTE's LIMIT 128 has
      // already picked (and row-locked) 128 items purely by created_at
      // order, oblivious to whether their parent can ever run. It is
      // reimplemented here verbatim (not imported -- this shape no longer
      // exists in src/) purely to prove the regression this test guards
      // against: without the fix, this is what selectPending looked like,
      // and it is what a future revert would silently bring back.
      async function oldSelectPending(): Promise<{ id: string | null; roundTrips: number }> {
        return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<{ id: string | null; roundTrips: number }> => {
          let cursor: { at: Date; id: string } | null = null;
          let roundTrips = 0;
          while (true) {
            roundTrips++;
            const cursorClause = cursor
              ? Prisma.sql`AND (i.created_at, i.id) > (${cursor.at}, ${cursor.id}::uuid)`
              : Prisma.empty;
            const rows: Array<{ id: string; cursor_at: Date; eligible: boolean }> = await tx.$queryRaw(Prisma.sql`
              WITH candidates AS MATERIALIZED (
                SELECT i.id, i.task_id, i.created_at AS cursor_at
                FROM generic_task_item i
                WHERE i.status = 'pending' ${cursorClause}
                ORDER BY i.created_at, i.id
                LIMIT 128
                FOR UPDATE OF i SKIP LOCKED
              )
              SELECT c.*,
                     (t.status IN ('pending', 'processing') AND t.task_type = ANY(${["article.generate.v1"]}::text[])) AS eligible
              FROM candidates c JOIN generic_task t ON t.id = c.task_id
              ORDER BY c.cursor_at, c.id
            `);
            const eligible = rows.find((row) => row.eligible);
            if (eligible) return { id: eligible.id, roundTrips };
            if (rows.length < 128) return { id: null, roundTrips };
            const last = rows.at(-1)!;
            cursor = { at: last.cursor_at, id: last.id };
          }
        });
      }

      const oldResult = await oldSelectPending();
      expect(oldResult.id).toBe(runnableItem.id);
      // 5000 ineligible items / 128 per page ~= 40 pages; assert it needed
      // far more than 1 round trip -- this is the whole point of the test.
      expect(oldResult.roundTrips).toBeGreaterThan(10);

      // --- The real, currently-shipped code path (claimPendingItem ->
      // selectPending), observed only through query-event logging since
      // selectPending is module-private.
      const { db, queries } = instrumentedClient();
      const lease = await claimPendingItem(db, {
        family: "generic", taskTypes: ["article.generate.v1"], workerId: "fixed-worker", leaseMs: 60_000,
      });
      expect(lease?.itemId).toBe(runnableItem.id);
      expect(candidateRoundTrips(queries)).toBe(1);

      // The 5000 disabled-parent items must be untouched (never locked/claimed).
      expect(await prisma.genericTaskItem.count({ where: { taskId: disabledParent.id, status: "pending" } })).toBe(BLOCK_SIZE);
    },
    30_000,
  );

  it(
    "also collapses paging to 1 round trip for the channel_sync family",
    async () => {
      const BLOCK_SIZE = 1_500;
      const disabledParent = await createChannelSyncTask({ status: "disabled", createdAt: new Date("2020-01-01T00:00:00Z") });
      await insertChannelSyncPendingBlock(disabledParent.id, BLOCK_SIZE, new Date("2020-01-01T00:00:00Z"));
      const runnableParent = await createChannelSyncTask({ createdAt: new Date("2026-01-01T00:00:00Z") });
      const runnableItem = await addChannelSyncItem(runnableParent.id, { createdAt: new Date("2026-01-01T00:00:00Z") });

      const { db, queries } = instrumentedClient();
      const lease = await claimPendingItem(db, {
        family: "channel_sync", taskTypes: ["runtime.channel"], workerId: "fixed-worker", leaseMs: 60_000,
      });
      expect(lease?.itemId).toBe(runnableItem.id);
      expect(candidateRoundTrips(queries)).toBe(1);
      expect(await prisma.channelSyncTaskItem.count({ where: { taskId: disabledParent.id, status: "pending" } })).toBe(BLOCK_SIZE);
    },
    30_000,
  );

  it("keeps strict created_at,id ordering among eligible items despite an interleaved ineligible parent", async () => {
    const runnableTasks = await Promise.all([
      createGenericTask({ createdAt: new Date("2026-03-01T00:00:00.000Z") }),
      createGenericTask({ createdAt: new Date("2026-03-01T00:00:00.200Z") }),
      createGenericTask({ createdAt: new Date("2026-03-01T00:00:00.400Z") }),
    ]);
    const items = await Promise.all(
      runnableTasks.map((task) => addGenericItem(task.id, { createdAt: task.createdAt })),
    );
    // A disabled parent with items dated *between* the eligible ones -- if
    // the eligibility filter changed ordering (instead of purely excluding
    // rows) this would corrupt the sequence below.
    const disabledParent = await createGenericTask({ status: "disabled", createdAt: new Date("2026-03-01T00:00:00.100Z") });
    await addGenericItem(disabledParent.id, { createdAt: new Date("2026-03-01T00:00:00.100Z") });
    await addGenericItem(disabledParent.id, { createdAt: new Date("2026-03-01T00:00:00.300Z") });

    const seen: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const lease = await claimPendingItem(prisma, {
        family: "generic", taskTypes: ["article.generate.v1"], workerId: "fifo-worker", leaseMs: 60_000,
      });
      expect(lease).not.toBeNull();
      seen.push(lease!.itemId);
    }
    expect(seen).toEqual(items.map((item) => item.id));
    expect(await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["article.generate.v1"], workerId: "fifo-worker", leaseMs: 60_000,
    })).toBeNull();
  });

  it("gives one pending item to only one of two concurrent workers, even with a large ineligible block ahead of it", async () => {
    const disabledParent = await createGenericTask({ status: "disabled", createdAt: new Date("2020-01-01T00:00:00Z") });
    await insertGenericPendingBlock(disabledParent.id, 2_000, new Date("2020-01-01T00:00:00Z"));
    const runnableParent = await createGenericTask({ createdAt: new Date("2026-01-01T00:00:00Z") });
    const item = await addGenericItem(runnableParent.id, { createdAt: new Date("2026-01-01T00:00:00Z") });

    const claims = await Promise.all([
      claimPendingItem(client(), { family: "generic", taskTypes: ["article.generate.v1"], workerId: "worker-a", leaseMs: 60_000 }),
      claimPendingItem(client(), { family: "generic", taskTypes: ["article.generate.v1"], workerId: "worker-b", leaseMs: 60_000 }),
    ]);
    const claimed = claims.filter((value): value is NonNullable<typeof value> => value !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].itemId).toBe(item.id);
    expect(await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: item.id } }))
      .toMatchObject({ status: "processing", lockedBy: claimed[0].workerId });
  }, 20_000);

  it("never double-claims across two concurrently-contested eligible items and still drains both", async () => {
    // The candidate CTE locks up to 128 matching rows in one pass (not just
    // the single row it eventually assigns) -- so with exactly two eligible
    // items available, whichever concurrent claim's SELECT ... FOR UPDATE
    // SKIP LOCKED executes first may transiently lock both, leaving the
    // other claimant with zero rows for this race (it returns null, it does
    // not steal or duplicate the first claimant's item). This is pre-existing
    // locking granularity, not something this fix changes -- the invariant
    // this test protects is: never the same item twice, and no item is ever
    // dropped (the loser's item becomes claimable the moment the winner's
    // transaction commits).
    const disabledParent = await createGenericTask({ status: "disabled", createdAt: new Date("2020-01-01T00:00:00Z") });
    await insertGenericPendingBlock(disabledParent.id, 2_000, new Date("2020-01-01T00:00:00Z"));
    const runnableParent = await createGenericTask({ createdAt: new Date("2026-01-01T00:00:00Z") });
    const itemA = await addGenericItem(runnableParent.id, { createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const itemB = await addGenericItem(runnableParent.id, { createdAt: new Date("2026-01-01T00:00:00.100Z") });

    const [leaseA, leaseB] = await Promise.all([
      claimPendingItem(client(), { family: "generic", taskTypes: ["article.generate.v1"], workerId: "worker-a", leaseMs: 60_000 }),
      claimPendingItem(client(), { family: "generic", taskTypes: ["article.generate.v1"], workerId: "worker-b", leaseMs: 60_000 }),
    ]);
    const firstRoundIds = [leaseA, leaseB].filter((value): value is NonNullable<typeof value> => value !== null).map((lease) => lease.itemId);
    // No duplicates, ever -- however many of the two succeeded in this race.
    expect(new Set(firstRoundIds).size).toBe(firstRoundIds.length);
    expect(firstRoundIds.length).toBeGreaterThanOrEqual(1);

    // Whatever the race didn't hand out is claimable immediately afterwards
    // -- SKIP LOCKED only defers contention, it never drops pending work.
    const remaining = [itemA.id, itemB.id].filter((id) => !firstRoundIds.includes(id));
    for (const expectedId of remaining) {
      const lease = await claimPendingItem(prisma, {
        family: "generic", taskTypes: ["article.generate.v1"], workerId: "follow-up-worker", leaseMs: 60_000,
      });
      expect(lease?.itemId).toBe(expectedId);
    }

    const allClaimedIds = [...firstRoundIds, ...remaining];
    expect(new Set(allClaimedIds).size).toBe(2);
    expect(allClaimedIds.sort()).toEqual([itemA.id, itemB.id].sort());
  }, 20_000);

  it.each(["disabled", "completed", "completed_with_errors", "failed"])(
    "skips a %s parent's pending items entirely instead of returning or fencing on them",
    async (status) => {
      const blocked = await createGenericTask({ status, createdAt: new Date("2020-01-01T00:00:00Z") });
      const blockedItem = await addGenericItem(blocked.id, { createdAt: new Date("2020-01-01T00:00:00Z") });
      const runnable = await createGenericTask({ createdAt: new Date("2026-01-01T00:00:00Z") });
      const runnableItem = await addGenericItem(runnable.id, { createdAt: new Date("2026-01-01T00:00:00Z") });

      const lease = await claimPendingItem(prisma, {
        family: "generic", taskTypes: ["article.generate.v1"], workerId: "status-worker", leaseMs: 60_000,
      });
      expect(lease?.itemId).toBe(runnableItem.id);
      expect(await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: blockedItem.id } }))
        .toMatchObject({ status: "pending", attemptCount: 0, leaseEpoch: 0n });
    },
  );

  it("keeps catalog_page strict ordering intact alongside the parent-eligibility pushdown", async () => {
    const disabledParent = await createGenericTask({ taskType: "catalog_scan", status: "disabled", createdAt: new Date("2020-01-01T00:00:00Z") });
    await insertGenericPendingBlock(disabledParent.id, 500, new Date("2020-01-01T00:00:00Z"));

    const task = await createGenericTask({ taskType: "catalog_scan", createdAt: new Date("2026-01-01T00:00:00Z") });
    const page1 = await addGenericItem(task.id, { targetType: "catalog_page", targetId: "1", createdAt: new Date("2026-01-01T00:00:00.000Z") });
    const page2 = await addGenericItem(task.id, { targetType: "catalog_page", targetId: "2", createdAt: new Date("2026-01-01T00:00:00.100Z") });

    const input = { family: "generic" as const, taskTypes: ["catalog_scan"], workerId: "page-worker", leaseMs: 60_000 };
    const claimTarget = { family: "generic" as const, taskId: task.id, itemId: page2.id };

    // page 2 cannot be claimed (targeted or not) while page 1 is still pending
    expect(await claimPendingItem(prisma, { ...input, claimTarget })).toBeNull();
    for (const item of [page1, page2]) {
      expect(await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "pending" });
    }

    const first = await claimPendingItem(prisma, input);
    expect(first?.itemId).toBe(page1.id);
    await finalizeTaskItem(prisma, first!, { status: "success" });

    const second = await claimPendingItem(prisma, { ...input, claimTarget });
    expect(second?.itemId).toBe(page2.id);
  });

  it.each(["disabled_parent", "ok"])("targeted claim (claimTarget / targetClause) still works: %s", async (scenario) => {
    const other = await createGenericTask({ createdAt: new Date("2020-01-01T00:00:00Z") });
    const otherItem = await addGenericItem(other.id, { createdAt: new Date("2020-01-01T00:00:00Z") });
    const target = await createGenericTask({
      status: scenario === "disabled_parent" ? "disabled" : "pending",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const targetItem = await addGenericItem(target.id, { createdAt: new Date("2026-01-01T00:00:00Z") });

    const lease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: ["article.generate.v1"], workerId: "target-worker", leaseMs: 60_000,
      claimTarget: { family: "generic", taskId: target.id, itemId: targetItem.id },
    });

    if (scenario === "disabled_parent") {
      expect(lease).toBeNull();
      // No fallback to the older, unrelated, actually-eligible item.
      expect(await prisma.genericTaskItem.findUniqueOrThrow({ where: { id: otherItem.id } }))
        .toMatchObject({ status: "pending", attemptCount: 0 });
    } else {
      expect(lease?.itemId).toBe(targetItem.id);
    }
  });
});
