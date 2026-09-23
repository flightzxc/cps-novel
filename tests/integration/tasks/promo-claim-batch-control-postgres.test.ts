/**
 * 领推广链接生命周期正式修复第 2 阶段第 4 步：批次级暂停 / 恢复 / 中止
 * （施工任务 3.1）、重新批准（3.3）、以及"同一本书挂在另一个批次排队分片下"
 * 的枚举时阻断（3.4）的真实 PostgreSQL 验收。
 *
 * 为什么不能只用假 tx 做单测：级联判定的正确性依赖真实的父子行锁顺序
 * （`FOR UPDATE` 逐个批次/分片）、`recomputeParentTask` 的真实 SQL 聚合、
 * `terminatePendingTaskItems` 的真实批量更新，以及——最关键的——D7 硬要求的
 * "web_app 角色实际能完成批次操作、worker_app 角色实际能完成枚举时阻断"这两
 * 条，必须用真实数据库角色而不是假客户端来验证权限边界。
 *
 * 运行方式：
 *   bash scripts/run-promo-claim-batch-control-postgres-verification.sh
 * 该脚本起一个全新一次性 postgres:16.14 容器、建六个最小权限角色、迁移、
 * 重放 grants.sql，再用 `PROMO_CLAIM_BATCH_CONTROL_OWNER_DATABASE_URL`
 * （migration_owner，仅用于造数据/断言）、`..._WEB_DATABASE_URL`（web_app，
 * 驱动批次级暂停/恢复/中止/重新批准）、`..._WORKER_DATABASE_URL`
 * （worker_app，驱动枚举）、`..._SCHEDULER_DATABASE_URL`（scheduler_app，
 * 验证"恢复后的分片能被真实 scheduler 角色重新放行"这条端到端链路）四个
 * 连接串跑本文件，最后删除容器。
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizeCatalogSelection } from "@/domain/catalog-batch";
import {
  CATALOG_BATCH_TASK_TYPE,
  claimPendingItem,
  enqueueCatalogBatch,
  finalizeTaskItem,
  readTaskControlMarker,
  runPromoClaimReleaseTick,
} from "@/lib/tasks";
import {
  PROMO_LINK_CLAIM_CAPABILITY_KEY,
  PROMO_LINK_CLAIM_TASK_TYPE,
} from "@/lib/tasks/promo-link-claim-limits";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import {
  abortPromoClaimBatch,
  getAdminTaskDetail,
  pausePromoClaimBatch,
  reapprovePromoClaimBatch,
  resumePromoClaimBatch,
  TaskAdminError,
} from "@/server/task-admin";
import { createCatalogBatchHandler } from "../../../worker/handlers/catalog-batch";
import {
  issueTaskAuthorization,
  newStores,
  NOW,
  seedTaskAdmin,
} from "../../backend/task-admin/test-support";

const enabled = process.env.PROMO_CLAIM_BATCH_CONTROL_DATABASE_TEST === "1";
const requiredUrl = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};

const owner = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_BATCH_CONTROL_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_BATCH_CONTROL_WEB_DATABASE_URL") });
const worker = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_BATCH_CONTROL_WORKER_DATABASE_URL") });
const scheduler = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_BATCH_CONTROL_SCHEDULER_DATABASE_URL") });

const LIFECYCLE_ON_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "true",
  FEATURE_PROMO_LINK_CLAIM: "true",
  PROMO_LINK_CLAIM_ALLOW_WRITE: "true",
  PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES: "1440",
  PROMO_CLAIM_SHARD_WINDOW_MINUTES: "90",
  PROMO_CLAIM_SHARD_SIZE_MIN: "1",
  PROMO_CLAIM_SHARD_SIZE_MAX: "1",
  PROMO_CLAIM_CREDENTIAL_SAFETY_MARGIN_MINUTES: "30",
};

interface Foundation {
  actorId: string;
  channelAppId: string;
  accountId: string;
}

async function assertDisposablePromoClaimBatchControlDatabase(db: PrismaClient): Promise<void> {
  const [database] = await db.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version
  `;
  if (!database.name.startsWith("cps_novel_promo_claim_batch_control_")) {
    throw new Error(`Refusing promo-claim-batch-control setup against ${database.name}`);
  }
  if (!database.version.startsWith("16.14")) {
    throw new Error(`PostgreSQL 16.14 required, got ${database.version}`);
  }
}

async function truncateDatabase(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

async function seedFoundation(db: PrismaClient): Promise<Foundation> {
  const actorId = `promo-claim-batch-control-pg-${randomUUID()}`;
  const channelId = randomUUID();
  const sourceAppId = randomUUID();
  const channelAppId = randomUUID();
  const accountId = randomUUID();
  const code = `pcbc-${randomUUID()}`;
  await db.channel.create({ data: { id: channelId, code, name: "Promo Claim Batch Control PG" } });
  await db.sourceApp.create({ data: { id: sourceAppId, code: `${code}-source`, name: "Promo Claim Batch Control Source" } });
  await db.channelApp.create({ data: { id: channelAppId, channelId, sourceAppId, externalAppId: `${code}-app`, projectType: 1 } });
  await db.channelAccount.create({ data: { id: accountId, channelId, businessId: `${code}-account`, accountName: "Promo Claim Batch Control Account" } });
  await db.channelCapability.create({
    data: {
      channelAppId, capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY, status: "enabled",
      sideEffecting: true, evidenceLevel: "OWNER_APPROVED_WRITE_PROBE",
    },
  });
  await db.channelAccountCredential.create({
    data: {
      channelAccountId: accountId,
      encryptedSecret: Buffer.from(`pcbc-secret-${randomUUID()}`),
      keyVersion: 1,
      secretFingerprint: randomUUID().replaceAll("-", ""),
      fingerprintPrefix: randomUUID().replaceAll("-", "").slice(0, 12),
      status: "active",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      lastValidatedAt: new Date("2026-09-22T00:00:00.000Z"),
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    },
  });
  return { actorId, channelAppId, accountId };
}

/** 同 `promo-claim-release-postgres.test.ts` 的 `seedBooks`——一次性把新建的 `novel_source_item` 全部链到各自新建的 `Novel` 行。 */
async function seedBooks(db: PrismaClient, channelAppId: string, count: number, prefix: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO novel_source_item (
      id, channel_app_id, external_book_id, source_language_code, source_locale,
      title, description, status, raw_payload, updated_at
    )
    SELECT gen_random_uuid(), ${channelAppId}::uuid, ${prefix} || '-' || n::text, 'en', 'en',
           ${prefix} || ' title ' || n::text, 'promo claim batch control fixture', 'pending',
           jsonb_build_object('fixture', ${prefix}), transaction_timestamp()
    FROM generate_series(1, ${count}) AS n
    RETURNING id
  `);
  const ids = rows.map((row) => row.id);
  for (const id of ids) {
    const novelId = randomUUID();
    const slug = `pcbc-${randomUUID()}`;
    await db.$executeRaw(Prisma.sql`
      INSERT INTO novel (id, business_id, title, description, locale, slug, created_at, updated_at)
      VALUES (${novelId}::uuid, ${slug}, ${`${prefix} novel`}, 'promo claim batch control fixture', 'en', ${slug}, transaction_timestamp(), transaction_timestamp())
    `);
    await db.$executeRaw(Prisma.sql`
      UPDATE novel_source_item SET novel_id = ${novelId}::uuid, status = 'linked' WHERE id = ${id}::uuid
    `);
  }
  return ids;
}

function handlerContext(lease: NonNullable<Awaited<ReturnType<typeof claimPendingItem>>>) {
  return { lease, mode: lease.mode, signal: new AbortController().signal, heartbeat: async () => true };
}

/** 提交一个生命周期批次并跑完枚举（用 worker 角色真实执行），返回按 shardIndex 排好序的分片 id（每片刚好 1 本书）。 */
async function buildLifecycleShards(
  foundation: Foundation,
  bookCount: number,
  prefix: string,
): Promise<{ batchId: string; shardIds: string[] }> {
  const bookIds = await seedBooks(owner, foundation.channelAppId, bookCount, prefix);
  const enqueued = await enqueueCatalogBatch(owner, {
    operation: "promo_claim",
    selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: bookIds }),
    actorId: foundation.actorId,
    requestId: randomUUID(),
    channelAccounts: { [foundation.channelAppId]: foundation.accountId },
  }, new Date(), true, undefined, LIFECYCLE_ON_ENV);
  // 用真实 worker_app 角色跑枚举——D7 的一部分：worker 角色实际能完成枚举
  // （含 3.4 新增的 queuedElsewhere 查询）。
  const lease = await claimPendingItem(worker, {
    family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "promo-claim-batch-control-pg", leaseMs: 60_000,
  });
  const outcome = await createCatalogBatchHandler(worker, { env: LIFECYCLE_ON_ENV })(handlerContext(lease!));
  await finalizeTaskItem(worker, lease!, outcome);
  const shards = await owner.genericTask.findMany({ where: { parentTaskId: enqueued.taskId }, orderBy: [{ createdAt: "asc" }] });
  const sorted = [...shards].sort((a, b) => (a.params as { shardIndex: number }).shardIndex - (b.params as { shardIndex: number }).shardIndex);
  return { batchId: enqueued.taskId, shardIds: sorted.map((s) => s.id) };
}

/** 一张批次级控制动作的票——身份/会话是内存假存储，真正接触数据库的只有 `dependencies.db`（web_app 角色）。 */
async function batchControlTicket(pathname:
  | "/api/admin/tasks/promo-claim-batch/pause"
  | "/api/admin/tasks/promo-claim-batch/resume"
  | "/api/admin/tasks/promo-claim-batch/abort"
  | "/api/admin/tasks/promo-claim-batch/reapprove") {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  const ticket = await issueTaskAuthorization(stores, { token: admin.token, pathname });
  return { ...ticket, admin, dependencies: { db: web, identities: stores, sessions: stores, now: NOW } };
}

/** 一个只读的 `AdminAuthContext`——同 `tests/integration/catalog-batch/postgres.test.ts` 的 `adminContext` 同一手法。 */
async function readContext() {
  const stores = newStores();
  const admin = seedTaskAdmin(stores);
  return (await requireAdminRouteAccess(
    { pathname: "/api/admin/tasks/detail", method: "GET", sessionToken: admin.token },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW },
  )).context;
}

describe.skipIf(!enabled).sequential("promo-claim lifecycle: 阶段2 第4步 批次级操作 (real Postgres)", () => {
  let foundation: Foundation;

  beforeAll(async () => assertDisposablePromoClaimBatchControlDatabase(owner), 30_000);
  beforeEach(async () => {
    await truncateDatabase(owner);
    foundation = await seedFoundation(owner);
  });
  afterAll(async () => {
    await owner.$disconnect();
    await web.$disconnect();
    await worker.$disconnect();
    await scheduler.$disconnect();
  });

  describe("3.1 暂停", () => {
    it("暂停已放行的分片（真实 web_app 角色），仍在排队的分片原样不动", async () => {
      const { batchId, shardIds } = await buildLifecycleShards(foundation, 2, "pause-basic");
      // 先放行第一片（第二片仍是 disabled + awaiting_release，排队中）。
      await runPromoClaimReleaseTick(scheduler, { now: NOW, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } })).status).toBe("pending");
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[1] } })).status).toBe("disabled");

      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/pause");
      const result = await pausePromoClaimBatch({ authorization, requestId, taskId: batchId, reason: "维护窗口" }, dependencies);
      expect(result).toMatchObject({ batchId, status: "paused", pausedShardCount: 1, wrote: true });

      const batch = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
      expect(batch.status).toBe("paused");
      expect(readTaskControlMarker(batch.result)).toMatchObject({ kind: "paused", reason: "维护窗口" });

      const releasedShard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(releasedShard.status).toBe("paused");
      const queuedShard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[1] } });
      expect(queuedShard.status).toBe("disabled");
      expect(readTaskControlMarker(queuedShard.result)).toMatchObject({ kind: "awaiting_release" }); // 未被暂停触碰。

      const audit = await owner.operationAudit.findFirstOrThrow({ where: { action: "promo_claim_batch.pause", entityId: batchId } });
      expect(audit.actorType).toBe("admin");
    });

    /**
     * Opus 复核（2026-09-24 F3）测试缺口：把 `pausePromoClaimBatchTx` 里级联
     * 挑选"当前已放行"分片的状态集合从 `["pending", "processing"]` 改成只剩
     * `["pending"]`，此前的 15 例集成测试全部仍然通过——说明缺一个"分片本身
     * 处于 processing（而不是 pending）时同样会被暂停级联覆盖"的场景。这里
     * 真实用 claimPendingItem 拿到租约，让分片状态经 recomputeParentTask
     * 变成 processing，再验证批次暂停仍然把它级联为 paused，且正在处理中
     * 的条目本身（租约字段）完全不受触碰。
     */
    it("已放行分片里的条目处于 processing（分片自身状态也是 processing）时，批次暂停仍然级联覆盖到它，且不触碰处理中的条目", async () => {
      const { batchId, shardIds } = await buildLifecycleShards(foundation, 1, "pause-processing");
      // 这里必须用真实当前时刻（不是本文件其它场景常用的固定 NOW 常量
      // 2026-08-26）——claimPendingItem 的 selectPending 下推条件比较的是
      // 数据库真实的 transaction_timestamp()，如果 deadlineAt 是按一个早已
      // 过去的固定 now 算出来的，真实 claim 会因为"deadlineAt 已过"被
      // selectPending 正确挡住（零写入，符合设计），但这条用例恰恰需要真的
      // claim 到这个条目才能测到"processing"这个状态，所以这里改用
      // new Date()（一次性容器上真实撞过这个坑：lease 为 null）。
      const releasedAt = new Date();
      await runPromoClaimReleaseTick(scheduler, { now: releasedAt, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } })).status).toBe("pending");

      const lease = await claimPendingItem(worker, {
        family: "generic", taskTypes: [PROMO_LINK_CLAIM_TASK_TYPE], workerId: "pcbc-processing-guard", leaseMs: 120_000,
      });
      expect(lease).not.toBeNull();
      const shardBeforePause = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(shardBeforePause.status).toBe("processing"); // recomputeParentTask：有条目 processing 时分片本身也是 processing。
      const itemBeforePause = await owner.genericTaskItem.findUniqueOrThrow({ where: { id: lease!.itemId } });
      expect(itemBeforePause.status).toBe("processing");

      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/pause");
      const result = await pausePromoClaimBatch({ authorization, requestId, taskId: batchId }, dependencies);
      expect(result).toMatchObject({ status: "paused", pausedShardCount: 1, wrote: true });

      const shardAfterPause = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(shardAfterPause.status).toBe("paused");
      // 正在处理中的条目本身——状态、租约字段（execution_token/locked_by/
      // lease_epoch）全部原样不动，暂停只改 generic_task，从不改
      // generic_task_item（同设计 §5.4 第 6 条 "只改 generic_task 这一张
      // 任务表，不改条目表" 的既有纪律，批次级暂停复用同一条纪律）。
      const itemAfterPause = await owner.genericTaskItem.findUniqueOrThrow({ where: { id: lease!.itemId } });
      expect(itemAfterPause).toMatchObject({
        status: "processing",
        executionToken: itemBeforePause.executionToken,
        lockedBy: itemBeforePause.lockedBy,
        leaseEpoch: itemBeforePause.leaseEpoch,
      });
    });

    it("拒绝暂停一个已经中止（cancelled）的批次", async () => {
      const { batchId } = await buildLifecycleShards(foundation, 1, "pause-cancelled");
      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/abort");
      await abortPromoClaimBatch({ authorization, requestId, taskId: batchId }, dependencies);

      const pauseTicket = await batchControlTicket("/api/admin/tasks/promo-claim-batch/pause");
      await expect(pausePromoClaimBatch(
        { authorization: pauseTicket.authorization, requestId: pauseTicket.requestId, taskId: batchId },
        pauseTicket.dependencies,
      )).rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
    });

    it("拒绝对非生命周期批次（旧路径 novel_materialize）调用批次级暂停", async () => {
      const bookIds = await seedBooks(owner, foundation.channelAppId, 1, "pause-non-lifecycle");
      await owner.$executeRaw(Prisma.sql`UPDATE novel_source_item SET status = 'pending', novel_id = NULL WHERE id = ${bookIds[0]}::uuid`);
      const enqueued = await enqueueCatalogBatch(owner, {
        operation: "novel_materialize",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: bookIds }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
      }, new Date(), true, undefined, LIFECYCLE_ON_ENV);

      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/pause");
      await expect(pausePromoClaimBatch(
        { authorization, requestId, taskId: enqueued.taskId }, dependencies,
      )).rejects.toMatchObject({ code: "task_admin_invalid_request", status: 400 });
    });
  });

  describe("3.1 恢复", () => {
    it("恢复：被暂停的已放行分片交还成 disabled + awaiting_release（保留 releaseCount），批次按现有方式重新计算状态；恢复后真实 scheduler_app 角色能重新放行", async () => {
      const { batchId, shardIds } = await buildLifecycleShards(foundation, 1, "resume-basic");
      const released = await runPromoClaimReleaseTick(scheduler, { now: NOW, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(released[0]).toMatchObject({ action: "released" });
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } })).params).toMatchObject({ releaseCount: 1 });

      const pauseTicket = await batchControlTicket("/api/admin/tasks/promo-claim-batch/pause");
      await pausePromoClaimBatch({ authorization: pauseTicket.authorization, requestId: pauseTicket.requestId, taskId: batchId }, pauseTicket.dependencies);

      const resumeTicket = await batchControlTicket("/api/admin/tasks/promo-claim-batch/resume");
      const result = await resumePromoClaimBatch(
        { authorization: resumeTicket.authorization, requestId: resumeTicket.requestId, taskId: batchId },
        resumeTicket.dependencies,
      );
      expect(result).toMatchObject({ batchId, status: "pending", releasedShardCount: 1, wrote: true });

      const shard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(shard.status).toBe("disabled"); // 绝不直接改回 pending。
      expect(readTaskControlMarker(shard.result)).toMatchObject({ kind: "awaiting_release" });
      expect(shard.params).toMatchObject({ releaseCount: 1 }); // 原样保留，不清零。

      const batch = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
      expect(batch.status).not.toBe("paused");
      expect(readTaskControlMarker(batch.result)).toBeUndefined();

      // 端到端：恢复后真实 scheduler_app 角色能重新放行（releaseCount+1）。
      const rerelease = await runPromoClaimReleaseTick(scheduler, { now: new Date(NOW.getTime() + 60_000), env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(rerelease[0]).toMatchObject({ action: "released", shardId: shardIds[0] });
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } })).params).toMatchObject({ releaseCount: 2 });
    });

    it("拒绝恢复一个不是 paused 状态的批次（例如从未暂停过）", async () => {
      const { batchId } = await buildLifecycleShards(foundation, 1, "resume-not-paused");
      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/resume");
      await expect(resumePromoClaimBatch(
        { authorization, requestId, taskId: batchId }, dependencies,
      )).rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
    });
  });

  describe("3.1 中止", () => {
    it("中止：级联终止所有未完成分片（含仍在排队的 disabled 分片），未尝试条目统一终止，不触发任何 getcode", async () => {
      const { batchId, shardIds } = await buildLifecycleShards(foundation, 2, "abort-basic");
      await runPromoClaimReleaseTick(scheduler, { now: NOW, env: LIFECYCLE_ON_ENV, logger: () => {} }); // 放行第一片。
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } })).status).toBe("pending");
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[1] } })).status).toBe("disabled");

      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/abort");
      const result = await abortPromoClaimBatch({ authorization, requestId, taskId: batchId, reason: "运营中止" }, dependencies);
      expect(result).toMatchObject({ batchId, status: "cancelled", terminatedShardCount: 2, terminatedItemCount: 2, wrote: true });

      const batch = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
      expect(batch.status).toBe("cancelled");
      for (const shardId of shardIds) {
        const shard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardId } });
        expect(shard.status).toBe("cancelled");
        const items = await owner.genericTaskItem.findMany({ where: { taskId: shardId } });
        expect(items.every((item) => item.status === "skipped")).toBe(true);
        expect(items.every((item) => item.error && (item.error as { code: string }).code === "task_manually_aborted")).toBe(true);
      }
      // 没有任何 promo_link 行被创建——零 getcode 调用。
      expect(await owner.promoLink.count()).toBe(0);

      // 中止是终态：再次中止被拒绝。
      const secondTicket = await batchControlTicket("/api/admin/tasks/promo-claim-batch/abort");
      await expect(abortPromoClaimBatch(
        { authorization: secondTicket.authorization, requestId: secondTicket.requestId, taskId: batchId }, secondTicket.dependencies,
      )).rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
    });

    it("中止一个从未放行过任何分片的批次（全部分片都还在 disabled 排队）同样级联终止", async () => {
      const { batchId, shardIds } = await buildLifecycleShards(foundation, 3, "abort-never-released");
      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/abort");
      const result = await abortPromoClaimBatch({ authorization, requestId, taskId: batchId }, dependencies);
      expect(result).toMatchObject({ status: "cancelled", terminatedShardCount: 3, terminatedItemCount: 3 });
      for (const shardId of shardIds) {
        expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardId } })).status).toBe("cancelled");
      }
    });
  });

  describe("3.3 重新批准", () => {
    it("批次停在 system_hold:approval_expired 且从未放行过任何分片时，真实 web_app 角色可以重新批准；恢复后 scheduler 能正常放行", async () => {
      const shortTtlEnv: NodeJS.ProcessEnv = { ...LIFECYCLE_ON_ENV, PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES: "60" };
      const bookIds = await seedBooks(owner, foundation.channelAppId, 1, "reapprove-basic");
      const enqueued = await enqueueCatalogBatch(owner, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: bookIds }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [foundation.channelAppId]: foundation.accountId },
      }, new Date(), true, undefined, shortTtlEnv);
      const lease = await claimPendingItem(worker, { family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "pcbc-reapprove", leaseMs: 60_000 });
      const outcome = await createCatalogBatchHandler(worker, { env: shortTtlEnv })(handlerContext(lease!));
      await finalizeTaskItem(worker, lease!, outcome);
      const batchId = enqueued.taskId;

      const approvedAt = (await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } })).params as { approvedAt: string };
      const wayPastApproval = new Date(new Date(approvedAt.approvedAt).getTime() + 2 * 60 * 60_000);
      const expired = await runPromoClaimReleaseTick(scheduler, { now: wayPastApproval, env: shortTtlEnv, logger: () => {} });
      expect(expired[0]).toMatchObject({ action: "approval_expired", batchId });
      const held = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
      expect(held.status).toBe("disabled");
      expect(readTaskControlMarker(held.result)).toMatchObject({ kind: "system_hold", reasonCode: "approval_expired" });

      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/reapprove");
      const result = await reapprovePromoClaimBatch({ authorization, requestId, taskId: batchId }, dependencies);
      expect(result.status).toBe("pending");
      expect(result.wrote).toBe(true);
      expect(new Date(result.approvalValidUntil).getTime()).toBeGreaterThan(new Date(result.approvedAt).getTime());

      const restored = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
      expect(restored.status).not.toBe("disabled");
      expect(readTaskControlMarker(restored.result)).toBeUndefined();

      const rereleased = await runPromoClaimReleaseTick(scheduler, { now: new Date(result.approvedAt), env: shortTtlEnv, logger: () => {} });
      expect(rereleased[0]).toMatchObject({ action: "released", batchId });
    });

    it("拒绝重新批准一个不是 approval_expired 的批次", async () => {
      const { batchId } = await buildLifecycleShards(foundation, 1, "reapprove-not-expired");
      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/reapprove");
      await expect(reapprovePromoClaimBatch(
        { authorization, requestId, taskId: batchId }, dependencies,
      )).rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
    });

    /**
     * 防御性用例（变异验证专用）：`reapprovePromoClaimBatchTx` 显式独立校验
     * "从未放行过任何分片"（`firstReleasedAt` 为空），不只看 `reasonCode`——
     * 见该函数自己的 doc comment。这里直接在数据库里构造一个理论上不应该
     * 出现、但如果上游判定出 bug 就可能出现的状态：`reasonCode` 已经是
     * `approval_expired`，但 `firstReleasedAt` 已经非空（分片其实已经放行
     * 过）。如果去掉这条独立校验，重新批准会被错误地放行，把一个执行期批次
     * 的批准时钟悄悄重置——这正是设计明确排除的"做成全批次 TTL"。
     */
    it("即使 reasonCode 已经是 approval_expired，只要 firstReleasedAt 非空（分片其实已经放行过），也拒绝重新批准", async () => {
      const { batchId } = await buildLifecycleShards(foundation, 1, "reapprove-inconsistent");
      const batch = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
      await owner.genericTask.update({
        where: { id: batchId },
        data: {
          status: "disabled",
          params: { ...(batch.params as Record<string, unknown>), firstReleasedAt: NOW.toISOString() },
          result: { taskControl: { kind: "system_hold", source: "system", at: NOW.toISOString(), reasonCode: "approval_expired" } },
        },
      });
      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/reapprove");
      await expect(reapprovePromoClaimBatch(
        { authorization, requestId, taskId: batchId }, dependencies,
      )).rejects.toMatchObject({ code: "task_admin_state_conflict", status: 409 });
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("disabled"); // 未被改写。
    });
  });

  describe("3.4 枚举盲区：同一本书挂在另一个批次排队分片下", () => {
    it("批次 A 枚举出排队分片；批次 B 选中重叠书被 queued_in_other_batch 挡住，不重叠部分正常入片；中止 A 后重叠书可以入片", async () => {
      const overlapping = await seedBooks(owner, foundation.channelAppId, 1, "overlap");
      const uniqueToB = await seedBooks(owner, foundation.channelAppId, 1, "unique-b");

      const enqueuedA = await enqueueCatalogBatch(owner, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: overlapping }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [foundation.channelAppId]: foundation.accountId },
      }, new Date(), true, undefined, LIFECYCLE_ON_ENV);
      const leaseA = await claimPendingItem(worker, { family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "pcbc-queued-a", leaseMs: 60_000 });
      const outcomeA = await createCatalogBatchHandler(worker, { env: LIFECYCLE_ON_ENV })(handlerContext(leaseA!));
      await finalizeTaskItem(worker, leaseA!, outcomeA);
      const shardsA = await owner.genericTask.findMany({ where: { parentTaskId: enqueuedA.taskId } });
      expect(shardsA).toHaveLength(1);
      expect(shardsA[0]!.status).toBe("disabled"); // 仍在排队，从未放行过。

      const enqueuedB = await enqueueCatalogBatch(owner, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: [...overlapping, ...uniqueToB] }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [foundation.channelAppId]: foundation.accountId },
      }, new Date(), true, undefined, LIFECYCLE_ON_ENV);
      const leaseB = await claimPendingItem(worker, { family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "pcbc-queued-b", leaseMs: 60_000 });
      const outcomeB = await createCatalogBatchHandler(worker, { env: LIFECYCLE_ON_ENV })(handlerContext(leaseB!));
      await finalizeTaskItem(worker, leaseB!, outcomeB);

      const batchB = await owner.genericTask.findUniqueOrThrow({ where: { id: enqueuedB.taskId } });
      expect(batchB.result).toMatchObject({ blockedReasonCounts: { queued_in_other_batch: 1 }, submittedCount: 1 });
      const shardsB = await owner.genericTask.findMany({ where: { parentTaskId: enqueuedB.taskId } });
      expect(shardsB).toHaveLength(1); // 只有不重叠的那本书入片。
      const shardBItems = await owner.genericTaskItem.findMany({ where: { taskId: shardsB[0]!.id } });
      expect(shardBItems.map((item) => item.targetId)).toEqual(uniqueToB);

      // 中止 A 后，重叠书不再"排队中"，同一本书可以进入新批次。
      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/abort");
      await abortPromoClaimBatch({ authorization, requestId, taskId: enqueuedA.taskId }, dependencies);

      const enqueuedC = await enqueueCatalogBatch(owner, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: overlapping }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [foundation.channelAppId]: foundation.accountId },
      }, new Date(), true, undefined, LIFECYCLE_ON_ENV);
      const leaseC = await claimPendingItem(worker, { family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "pcbc-queued-c", leaseMs: 60_000 });
      const outcomeC = await createCatalogBatchHandler(worker, { env: LIFECYCLE_ON_ENV })(handlerContext(leaseC!));
      await finalizeTaskItem(worker, leaseC!, outcomeC);
      const batchC = await owner.genericTask.findUniqueOrThrow({ where: { id: enqueuedC.taskId } });
      expect(batchC.result).toMatchObject({ submittedCount: 1 });
      expect((batchC.result as { blockedReasonCounts?: Record<string, number> }).blockedReasonCounts?.queued_in_other_batch ?? 0).toBe(0);
    });

    /**
     * Opus 复核（2026-09-24 F4）测试缺口：把 worker/handlers/catalog-batch.ts
     * 里 `queuedElsewhere` 查询的 `t.status IN ('disabled', 'paused')` 改成
     * 只剩 `'disabled'`，此前的 15 例集成测试全部仍然通过——说明缺一个"分片
     * 因为批次级暂停而处于 paused（不是从未放行过的 disabled）时，同一本书
     * 仍然会被 queued_in_other_batch 挡住"的场景。
     */
    it("批次 A 的分片因批次级暂停而处于 paused 时，批次 B 的重叠书同样被 queued_in_other_batch 挡住", async () => {
      const overlapping = await seedBooks(owner, foundation.channelAppId, 1, "overlap-paused");
      const enqueuedA = await enqueueCatalogBatch(owner, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: overlapping }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [foundation.channelAppId]: foundation.accountId },
      }, new Date(), true, undefined, LIFECYCLE_ON_ENV);
      const leaseA = await claimPendingItem(worker, { family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "pcbc-queued-paused-a", leaseMs: 60_000 });
      const outcomeA = await createCatalogBatchHandler(worker, { env: LIFECYCLE_ON_ENV })(handlerContext(leaseA!));
      await finalizeTaskItem(worker, leaseA!, outcomeA);
      // 放行后再批次级暂停：分片从 disabled(awaiting_release) 变成 pending，
      // 再变成 paused——不是"从未放行过的排队 disabled"这条既有覆盖路径。
      await runPromoClaimReleaseTick(scheduler, { now: NOW, env: LIFECYCLE_ON_ENV, logger: () => {} });
      const shardA = await owner.genericTask.findFirstOrThrow({ where: { parentTaskId: enqueuedA.taskId } });
      expect(shardA.status).toBe("pending");
      const pauseTicket = await batchControlTicket("/api/admin/tasks/promo-claim-batch/pause");
      await pausePromoClaimBatch({ authorization: pauseTicket.authorization, requestId: pauseTicket.requestId, taskId: enqueuedA.taskId }, pauseTicket.dependencies);
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardA.id } })).status).toBe("paused");

      const enqueuedB = await enqueueCatalogBatch(owner, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: overlapping }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [foundation.channelAppId]: foundation.accountId },
      }, new Date(), true, undefined, LIFECYCLE_ON_ENV);
      const leaseB = await claimPendingItem(worker, { family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "pcbc-queued-paused-b", leaseMs: 60_000 });
      const outcomeB = await createCatalogBatchHandler(worker, { env: LIFECYCLE_ON_ENV })(handlerContext(leaseB!));
      await finalizeTaskItem(worker, leaseB!, outcomeB);

      const batchB = await owner.genericTask.findUniqueOrThrow({ where: { id: enqueuedB.taskId } });
      expect(batchB.result).toMatchObject({ blockedReasonCounts: { queued_in_other_batch: 1 }, submittedCount: 0 });
      const shardsB = await owner.genericTask.findMany({ where: { parentTaskId: enqueuedB.taskId } });
      expect(shardsB).toHaveLength(0); // 唯一一本书被挡住，批次 B 一片都没建。
    });

    it("开关关闭（旧路径）时不查 queuedElsewhere，判定逐字不变", async () => {
      const overlapping = await seedBooks(owner, foundation.channelAppId, 1, "legacy-overlap");
      const offEnv: NodeJS.ProcessEnv = { ...LIFECYCLE_ON_ENV, PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "false" };
      // 旧路径下先建一个 disabled 的领取子任务（双闸关闭时会这样建）——这本身
      // 就是既有盲区（旧路径本步不改),这里只需确认"开关关闭时不因为新代码
      // 多出一个 queued_in_other_batch 阻断"。
      const enqueued = await enqueueCatalogBatch(owner, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: overlapping }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [foundation.channelAppId]: foundation.accountId },
      }, new Date(), true, undefined, offEnv);
      const lease = await claimPendingItem(worker, { family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "pcbc-legacy", leaseMs: 60_000 });
      const outcome = await createCatalogBatchHandler(worker, { env: offEnv })(handlerContext(lease!));
      await finalizeTaskItem(worker, lease!, outcome);
      const batch = await owner.genericTask.findUniqueOrThrow({ where: { id: enqueued.taskId } });
      expect((batch.result as { blockedReasonCounts?: Record<string, number> }).blockedReasonCounts?.queued_in_other_batch ?? 0).toBe(0);
      expect(batch.result).toMatchObject({ submittedCount: 1 });
    });
  });

  describe("3.5 批次详情 DTO：分片列表 / 领取统计 / 预计完成时间 / parentRawStatus", () => {
    it("生命周期批次：getAdminTaskDetail 返回 promoClaimLifecycle（分片列表+统计+ETA）与 parentRawStatus（用于旧路径按钮可点性判定）", async () => {
      const { batchId, shardIds } = await buildLifecycleShards(foundation, 2, "detail-dto");
      // 放行第一片并让它成功完成（真正跑一遍 handler，制造真实的
      // success/manual_review 条目，而不是手写伪造行）。
      const released = await runPromoClaimReleaseTick(scheduler, { now: NOW, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(released[0]).toMatchObject({ action: "released", shardId: shardIds[0] });

      const context = await readContext();
      const detail = await getAdminTaskDetail(owner, context, { family: "generic", taskId: batchId });

      // 批次自己的枚举条目已经处理完，raw status 几乎总是很快变成终态
      // （通常是 completed），即使分片仍在运行——这正是旧路径缺陷的根因。
      expect(detail.parentRawStatus).toBe("completed");
      // 派生后展示状态则正确反映"仍有分片在跑" -> processing。
      expect(detail.status).toBe("processing");

      expect(detail.catalogBatch?.promoClaimLifecycle).toBeDefined();
      const lifecycle = detail.catalogBatch!.promoClaimLifecycle!;
      expect(lifecycle.shards).toHaveLength(2);
      expect(lifecycle.shards[0]).toMatchObject({ taskId: shardIds[0], shardIndex: 0, status: "pending", releaseCount: 1 });
      expect(lifecycle.shards[1]).toMatchObject({ taskId: shardIds[1], shardIndex: 1, status: "disabled", releaseCount: 0, holdKind: "awaiting_release" });
      expect(lifecycle.counts.total).toBe(2);
      expect(lifecycle.counts.remaining).toBe(2); // 都还没真正处理完（items 仍 pending，只是分片本身已放行）。
      expect(lifecycle.shardPlan).toMatchObject({ windowMinutes: 90, shardCount: 2 });
      expect(typeof lifecycle.etaMinutes).toBe("number");
      expect(lifecycle.etaMinutes).toBeGreaterThan(0);
    });

    /**
     * Opus 复核（2026-09-24 F1）要求的六分类真实数据验收：直接把
     * generic_task_item 的 (status, result) 写成 worker/handlers/
     * promo-link-claim.ts 各个真实分支会落库的形状（claimed/
     * readback_recovered/already_available/already_fetched 的 success 与
     * skipped 两种形态/manual_review_required/capability_disabled/failed/
     * 人工中止级联的 skipped/pending/processing），而不是重新驱动一遍完整
     * 的 claimPromo 适配器模拟——这里要验收的是 loadPromoClaimBatchLifecycle
     * 那条聚合 SQL 的 CASE 分类是否正确，只依赖最终持久化的
     * (status, result.decision) 形状，与"这个形状是怎么被 worker 写出来的"
     * 无关；claimPromo 适配器本身的分支覆盖是 worker 那条测试线自己的职责。
     */
    it("六分类口径：混合 decision 的真实条目聚合出正确的六桶计数，互斥且加总等于总数", async () => {
      const mixedEnv: NodeJS.ProcessEnv = { ...LIFECYCLE_ON_ENV, PROMO_CLAIM_SHARD_SIZE_MIN: "50", PROMO_CLAIM_SHARD_SIZE_MAX: "1000" };
      const bookIds = await seedBooks(owner, foundation.channelAppId, 11, "mixed-decision");
      const enqueued = await enqueueCatalogBatch(owner, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: bookIds }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [foundation.channelAppId]: foundation.accountId },
      }, new Date(), true, undefined, mixedEnv);
      const lease = await claimPendingItem(worker, { family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "pcbc-mixed-decision", leaseMs: 60_000 });
      const outcome = await createCatalogBatchHandler(worker, { env: mixedEnv })(handlerContext(lease!));
      await finalizeTaskItem(worker, lease!, outcome);
      const shards = await owner.genericTask.findMany({ where: { parentTaskId: enqueued.taskId } });
      expect(shards).toHaveLength(1); // 11 本全部落进同一片（shardSizeMax=1000 远大于 11）。
      const shardId = shards[0]!.id;
      await runPromoClaimReleaseTick(scheduler, { now: NOW, env: mixedEnv, logger: () => {} }); // 放行，让分片进入真实的 pending 状态。

      const items = await owner.genericTaskItem.findMany({ where: { taskId: shardId }, orderBy: { targetId: "asc" } });
      expect(items).toHaveLength(11);
      const finishedAt = new Date();
      const writes: Array<{ status: string; result: Record<string, unknown> | typeof Prisma.JsonNull; error?: Record<string, unknown> }> = [
        { status: "success", result: { decision: "claimed" } },
        { status: "success", result: { decision: "readback_recovered" } },
        { status: "success", result: { decision: "already_available" } },
        { status: "skipped", result: { decision: "already_fetched" } }, // dry-run 形态（理论上生命周期分片不会出现，仍需分类正确）。
        { status: "success", result: { decision: "already_fetched" } }, // apply 模式下真实会出现的形态。
        { status: "success", result: { decision: "manual_review_required" } },
        { status: "success", result: { decision: "capability_disabled" } },
        { status: "failed", result: Prisma.JsonNull, error: { code: "claim_failed", message: "upstream error" } },
        { status: "skipped", result: Prisma.JsonNull, error: { code: "task_manually_aborted", message: "aborted before attempt" } },
        { status: "pending", result: Prisma.JsonNull },
        { status: "processing", result: Prisma.JsonNull },
      ];
      for (const [index, item] of items.entries()) {
        const write = writes[index]!;
        await owner.genericTaskItem.update({
          where: { id: item.id },
          data: {
            status: write.status,
            result: write.result as Prisma.InputJsonValue,
            error: (write.error ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            ...(write.status === "success" || write.status === "failed" || write.status === "skipped" ? { finishedAt } : {}),
            // generic_task_item_lease_shape_check：processing 行要求
            // execution_token/locked_by/locked_until 均非空——直接写
            // status='processing' 而不带租约字段会被真实约束拒绝（一次性
            // 容器上真实撞过一次）。
            ...(write.status === "processing"
              ? { executionToken: randomUUID(), lockedBy: "pcbc-mixed-decision-fixture", lockedUntil: new Date(finishedAt.getTime() + 60_000), heartbeatAt: finishedAt }
              : {}),
          },
        });
      }

      const context = await readContext();
      const detail = await getAdminTaskDetail(owner, context, { family: "generic", taskId: enqueued.taskId });
      const lifecycle = detail.catalogBatch!.promoClaimLifecycle!;
      expect(lifecycle.counts).toEqual({
        total: 11,
        claimed: 2, // claimed, readback_recovered
        withCode: 3, // already_available, skipped+already_fetched, success+already_fetched
        manualReview: 1, // manual_review_required
        failed: 2, // failed(status), capability_disabled（Opus 第二轮复核修正：不进人工核对列表，按失败计）
        skipped: 1, // 只有人工中止级联（无 decision）落在这里，already_fetched 那条已分流到 withCode
        remaining: 2, // pending, processing
      });
      expect(lifecycle.counts.claimed + lifecycle.counts.withCode + lifecycle.counts.manualReview
        + lifecycle.counts.failed + lifecycle.counts.skipped + lifecycle.counts.remaining).toBe(lifecycle.counts.total);
      // 分片自己的六个字段同样正确（批次汇总只有一个分片，两者应该相等）。
      expect(lifecycle.shards[0]).toMatchObject({
        totalCount: 11, claimedCount: 2, withCodeCount: 3, manualReviewCount: 1, failedCount: 2, skippedCount: 1, remainingCount: 2,
      });
    });

    it("非生命周期批次（旧路径 novel_materialize）：promoClaimLifecycle 缺失，parentRawStatus 仍然填充", async () => {
      const bookIds = await seedBooks(owner, foundation.channelAppId, 1, "detail-dto-legacy");
      await owner.$executeRaw(Prisma.sql`UPDATE novel_source_item SET status = 'pending', novel_id = NULL WHERE id = ${bookIds[0]}::uuid`);
      const enqueued = await enqueueCatalogBatch(owner, {
        operation: "novel_materialize",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: bookIds }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
      }, new Date(), true, undefined, LIFECYCLE_ON_ENV);

      const context = await readContext();
      const detail = await getAdminTaskDetail(owner, context, { family: "generic", taskId: enqueued.taskId });
      expect(detail.catalogBatch?.promoClaimLifecycle).toBeUndefined();
      expect(detail.parentRawStatus).toBeDefined();
    });
  });

  describe("真实角色边界（D7）", () => {
    it("web_app 角色能完成批次级暂停/恢复/中止；同一角色仍然读不到凭据密文列", async () => {
      const { batchId } = await buildLifecycleShards(foundation, 1, "role-check");
      const [{ current_user: currentUser }] = await web.$queryRawUnsafe<Array<{ current_user: string }>>("SELECT current_user");
      expect(currentUser).toBe("web_app");

      const { authorization, requestId, dependencies } = await batchControlTicket("/api/admin/tasks/promo-claim-batch/pause");
      const result = await pausePromoClaimBatch({ authorization, requestId, taskId: batchId }, dependencies);
      expect(result.wrote).toBe(true);

      await expect(
        web.$queryRawUnsafe("SELECT encrypted_secret FROM channel_account_credential LIMIT 1"),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
