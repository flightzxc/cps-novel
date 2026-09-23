/**
 * Real-Postgres acceptance for the promo-claim lifecycle's claim-time
 * pushdown (阶段2 第 1 步, `docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`):
 * `selectPending`'s generic-family parent-eligibility `EXISTS` (`src/lib/
 * tasks/store.ts`) refuses a lifecycle shard's items whenever the parent's
 * `params.deadlineAt` is absent or has already passed, with **zero writes**
 * to the refused item (no lease, no attempt_count bump, no error, no
 * touched `updated_at`) — exactly the same claim-time-pushdown shape as the
 * account-hold brake this suite's sibling
 * (`preview-account-hold-postgres.test.ts`) and the parent-eligibility fix
 * (`task-claim-skip-ineligible-parents-postgres.test.ts`) both cover.
 *
 * Why this cannot be a unit test: the whole guarantee is one SQL predicate
 * pushed into `selectPending`'s inner `WHERE`, evaluated by a real query
 * planner against `transaction_timestamp()`. A fake `$queryRaw` would stay
 * green with the predicate deleted.
 *
 * Gated the same way `task-claim-skip-ineligible-parents-postgres.test.ts`
 * is: set `PROMO_CLAIM_LIFECYCLE_DATABASE_TEST=1` and point `DATABASE_URL`
 * at a throwaway, already-migrated PostgreSQL 16 database whose name
 * contains "lifecycletest" (the same disposable-database safety guard that
 * suite uses, see `beforeAll` below) — e.g. a one-off container:
 *
 *   docker run --rm -d --name lc1-pg -e POSTGRES_PASSWORD=lc1 \
 *     -e POSTGRES_DB=lifecycletest -p 55432:5432 postgres:16.14
 *   DATABASE_URL=postgresql://postgres:lc1@localhost:55432/lifecycletest \
 *     npx prisma migrate deploy
 *   PROMO_CLAIM_LIFECYCLE_DATABASE_TEST=1 \
 *   DATABASE_URL=postgresql://postgres:lc1@localhost:55432/lifecycletest \
 *     npx vitest run --project node tests/integration/tasks/promo-claim-lifecycle-shard-deadline-postgres.test.ts
 *   docker stop lc1-pg
 *
 * This suite `TRUNCATE`s every table in `beforeEach` — never point it at
 * anything but a disposable fixture database.
 *
 * 2026-09-23 复核追加：批次死锁缺陷的回归用例。批次父任务
 * （`batch.materialize.v1`，设计 §5.2）与分片父任务（`promo_link.claim.v1`）
 * 都可能带 `lifecycleVersion: 1`，但只有分片有 `deadlineAt`——下推条件必须
 * 同时判定 `lifecycleRole`，否则批次自己的枚举条目（`catalog_filter_
 * snapshot`）会被"要求 deadlineAt"这条规则永远挡住。见 `src/lib/tasks/
 * promo-claim-lifecycle.ts` 的 `PROMO_CLAIM_LIFECYCLE_ROLES` 文档注释。
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { claimPendingItem } from "@/lib/tasks/store";
import { PROMO_LINK_CLAIM_TARGET_TYPE, PROMO_LINK_CLAIM_TASK_TYPE } from "@/lib/tasks/promo-link-claim-limits";
import { CATALOG_BATCH_TARGET_TYPE, CATALOG_BATCH_TASK_TYPE } from "@/lib/tasks/catalog-batch";

const enabled = process.env.PROMO_CLAIM_LIFECYCLE_DATABASE_TEST === "1";
const prisma = new PrismaClient();

async function truncateDatabase() {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

type SeededShard = { readonly taskId: string; readonly itemId: string };

/**
 * Creates a GenericTask plus one pending item under it. `lifecycleParams`
 * becomes `GenericTask.params` verbatim — pass `{ lifecycleVersion: 1,
 * lifecycleRole: "shard", deadlineAt: "<iso>" }` (or omit `deadlineAt`) for a
 * lifecycle shard, or `{}` for a plain pre-lifecycle task, to prove the
 * pushdown is a no-op for it. Defaults to the `promo_link.claim.v1`/
 * `novel_source_item` shape; `seedBatchTask` below is the
 * `batch.materialize.v1`/`catalog_filter_snapshot` counterpart used to prove
 * the pushdown does not deadlock a *batch* parent that also happens to carry
 * `lifecycleVersion: 1`.
 */
async function seedShard(
  lifecycleParams: Record<string, unknown>,
  taskShape: { taskType: string; targetType: string } = { taskType: PROMO_LINK_CLAIM_TASK_TYPE, targetType: PROMO_LINK_CLAIM_TARGET_TYPE },
): Promise<SeededShard> {
  const taskId = randomUUID();
  const itemId = randomUUID();
  await prisma.genericTask.create({
    data: {
      id: taskId,
      taskType: taskShape.taskType,
      operationScopeHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      requestToken: randomUUID(),
      status: "pending",
      params: lifecycleParams as Prisma.InputJsonValue,
    },
  });
  await prisma.genericTaskItem.create({
    data: {
      id: itemId,
      taskId,
      targetType: taskShape.targetType,
      targetId: `lc1-${itemId}`,
      status: "pending",
      payload: {},
    },
  });
  return { taskId, itemId };
}

/**
 * `batch.materialize.v1` counterpart of `seedShard` — a **batch** parent
 * (设计 §5.2), not a shard. Used by the regression case below: a batch
 * carrying `lifecycleVersion: 1, lifecycleRole: "batch"` and no `deadlineAt`
 * at all must remain claimable, unlike a `lifecycleRole: "shard"` parent in
 * the same state.
 */
function seedBatchTask(lifecycleParams: Record<string, unknown>): Promise<SeededShard> {
  return seedShard(lifecycleParams, { taskType: CATALOG_BATCH_TASK_TYPE, targetType: CATALOG_BATCH_TARGET_TYPE });
}

/** Full mutable-state snapshot of one item — used to prove a refused claim writes nothing at all. */
async function itemFingerprint(itemId: string): Promise<string> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT status, attempt_count, lease_epoch, execution_token, locked_by, locked_until, updated_at
    FROM generic_task_item WHERE id = ${itemId}::uuid`);
  return JSON.stringify(rows[0], (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

function claim(taskTypes: readonly string[] = [PROMO_LINK_CLAIM_TASK_TYPE]) {
  return claimPendingItem(prisma, {
    family: "generic",
    taskTypes: [...taskTypes],
    workerId: "lc1-probe",
    leaseMs: 30_000,
  });
}

function claimBatch() {
  return claim([CATALOG_BATCH_TASK_TYPE]);
}

describe.skipIf(!enabled).sequential("promo-claim lifecycle: selectPending deadline pushdown (real Postgres)", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName, version }] = await prisma.$queryRawUnsafe<
      Array<{ database_name: string; version: string }>
    >(`SELECT current_database() AS database_name, current_setting('server_version') AS version`);
    if (!/lifecycletest/i.test(databaseName)) {
      throw new Error(`Refusing destructive promo-claim-lifecycle tests against database "${databaseName}"`);
    }
    if (!version.startsWith("16.")) throw new Error(`promo-claim-lifecycle tests require PostgreSQL 16, got ${version}`);
  });

  beforeEach(async () => {
    await truncateDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("is not claimable, and writes nothing at all, when the lifecycle shard's deadlineAt has already passed", async () => {
    const shard = await seedShard({
      lifecycleVersion: 1,
      lifecycleRole: "shard",
      deadlineAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const before = await itemFingerprint(shard.itemId);

    const lease = await claim();

    expect(lease).toBeNull();
    expect(await itemFingerprint(shard.itemId)).toBe(before);
  });

  it("is not claimable, and writes nothing at all, when the lifecycle shard has no deadlineAt yet (not released)", async () => {
    const shard = await seedShard({ lifecycleVersion: 1, lifecycleRole: "shard" });
    const before = await itemFingerprint(shard.itemId);

    const lease = await claim();

    expect(lease).toBeNull();
    expect(await itemFingerprint(shard.itemId)).toBe(before);
  });

  it("is claimable once the lifecycle shard's deadlineAt is in the future", async () => {
    const shard = await seedShard({
      lifecycleVersion: 1,
      lifecycleRole: "shard",
      deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    const lease = await claim();

    expect(lease?.taskId).toBe(shard.taskId);
    expect(lease?.itemId).toBe(shard.itemId);
  });

  it("leaves a non-lifecycle task's items completely unaffected by the pushdown", async () => {
    // No `lifecycleVersion` key at all -- the pre-existing shape every task
    // created before this feature has, and the shape every task created
    // while the feature flag stays off (default) will continue to have.
    const shard = await seedShard({});

    const lease = await claim();

    expect(lease?.taskId).toBe(shard.taskId);
    expect(lease?.itemId).toBe(shard.itemId);
  });

  it("a task tagged lifecycleVersion 1 but past its deadline never blocks a *different*, non-lifecycle task's claim", async () => {
    const blocked = await seedShard({ lifecycleVersion: 1, lifecycleRole: "shard", deadlineAt: new Date(Date.now() - 60_000).toISOString() });
    // Younger createdAt would normally sort after `blocked` in cursor order;
    // insert a tiny delay-free second row to prove selectPending pages past
    // the blocked (and zero-write) row to find this one instead of stopping.
    const runnable = await seedShard({});

    const lease = await claim();

    expect(lease?.taskId).toBe(runnable.taskId);
    expect(await itemFingerprint(blocked.itemId)).toContain('"status":"pending"');
  });

  /**
   * 2026-09-23 复核追加：批次死锁回归用例。批次父任务（`batch.materialize.
   * v1`）同样带 `lifecycleVersion: 1`（设计 §5.2），但角色是 "batch" 且从来
   * 没有 `deadlineAt` —— 这条下推必须完全不影响它，否则批次自己的枚举
   * 条目永远领不到，整个批次死锁（本条用例就是复核发现这个缺陷时用来
   * 复现问题的真实场景：不带 `lifecycleRole` 判定的旧谓词会让下面这次
   * `claimBatch()` 返回 null）。
   */
  it("a batch parent (lifecycleVersion=1, lifecycleRole='batch', no deadlineAt) is still claimable -- proves no batch deadlock", async () => {
    const batch = await seedBatchTask({
      lifecycleVersion: 1,
      lifecycleRole: "batch",
      approvedAt: new Date().toISOString(),
    });

    const lease = await claimBatch();

    expect(lease?.taskId).toBe(batch.taskId);
    expect(lease?.itemId).toBe(batch.itemId);
  });
});
