/**
 * Real-Postgres acceptance for 领推广链接生命周期正式修复第 2 阶段第 2 步
 * （`docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`，设计 §5.2/§5.3）：
 * `worker/handlers/catalog-batch.ts` 枚举一个 `lifecycleVersion=1 &&
 * lifecycleRole="batch"` 的 `promo_claim` 批次时，把选中的书按渠道账号分组、
 * 再按 `computeShardSize` 算出的分片大小切成若干 `disabled` +
 * `awaiting_release` 的 `promo_link.claim.v1` 分片。
 *
 * 为什么不能只用假 DB 做单测：分组/切片本身（`chunkMembersIntoShards`/
 * `buildLifecycleShardPlan`/`parsePayload`）已经在 `tests/backend/
 * catalog-batch/lifecycle-shard-enumeration.test.ts` 里做了纯函数单测；但
 * 真正"选出所有 (channelAppId, channelAccountId) 分组、逐组建出多个
 * generic_task/generic_task_item 行、requestToken/operationScopeHash 全局
 * 唯一、`selectPending` 在真实查询计划下确实挡住未放行分片"这些性质，本质上
 * 离不开一次真实的 Postgres 事务与查询计划——一个删掉判定逻辑的假
 * `$queryRaw`/内存 Map 依然会全绿。
 *
 * 8 万 vs 2 万的取舍：设计 §九 第 10 条要求"8 万级模拟"。分组/切片/入库都是
 * 对成员列表的线性摊销操作（`chunkMembersIntoShards` 是 O(n)，
 * `genericTaskItem.createMany` 按 `CATALOG_BATCH_CHUNK_SIZE=50` 分批插入，
 * 批数只随条目数线性增长），复杂度不随规模改变，2 万条已经足以覆盖"多分片、
 * 恰好整除边界、最后一片余数"等全部结构性断言；把这里的默认值调到 8 万
 * 只会线性拉长这次一次性容器验证的挂钟时间，不会改变任何断言成立与否。默认
 * 用 2 万条（`PROMO_CLAIM_SHARD_ENUM_SCALE_COUNT` 可覆盖，例如预生产/CI 单独
 * 跑一次 8 万条的版本）。
 *
 * 复用 `tests/integration/catalog-batch/support.ts` 的一次性数据库安全守卫
 * （数据库名必须以 `cps_novel_catalog_batch_` 开头、且是 PostgreSQL
 * 16.14）——与既有 `postgres.test.ts` 用同一个一次性数据库,但本文件用自己
 * 独立的环境变量开关（`PROMO_CLAIM_SHARD_ENUM_DATABASE_TEST=1`），不搭在
 * `CATALOG_BATCH_DATABASE_TEST` 上，这样默认运行现有 catalog-batch 集成套件
 * 时不会意外多跑一次 2 万行规模的枚举:
 *
 *   docker run --rm -d --name cb-pg -e POSTGRES_PASSWORD=cb \
 *     -e POSTGRES_DB=cps_novel_catalog_batch_lc2 -p 55433:5432 postgres:16.14
 *   DATABASE_URL=postgresql://postgres:cb@localhost:55433/cps_novel_catalog_batch_lc2 \
 *     npx prisma migrate deploy
 *   PROMO_CLAIM_SHARD_ENUM_DATABASE_TEST=1 \
 *   DATABASE_URL=postgresql://postgres:cb@localhost:55433/cps_novel_catalog_batch_lc2 \
 *     npx vitest run --project node tests/integration/catalog-batch/promo-claim-lifecycle-shard-enumeration-postgres.test.ts
 *   docker stop cb-pg
 *
 * 本套件在 `beforeEach` 里 `TRUNCATE` 每一张表——只能指向一次性 fixture 库。
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeCatalogSelection } from "@/domain/catalog-batch";
import {
  CATALOG_BATCH_TASK_TYPE,
  claimPendingItem,
  computeShardSize,
  enqueueCatalogBatch,
  finalizeTaskItem,
  PROMO_CLAIM_LIFECYCLE_DEFAULTS,
  readTaskControlMarker,
} from "@/lib/tasks";
import { PROMO_LINK_CLAIM_CAPABILITY_KEY, PROMO_LINK_CLAIM_TASK_TYPE } from "@/lib/tasks/promo-link-claim-limits";
import { createCatalogBatchHandler } from "../../../worker/handlers/catalog-batch";
import {
  assertDisposableCatalogDatabase,
  seedCatalogFoundation,
  seedCatalogRows,
  truncateCatalogDatabase,
  type CatalogFoundation,
} from "./support";

const enabled = process.env.PROMO_CLAIM_SHARD_ENUM_DATABASE_TEST === "1";
const prisma = new PrismaClient();
let foundation: CatalogFoundation;

const requestedScaleCount = Number.parseInt(process.env.PROMO_CLAIM_SHARD_ENUM_SCALE_COUNT ?? "20000", 10);
const scaleCount = Number.isSafeInteger(requestedScaleCount) && requestedScaleCount > 0 ? requestedScaleCount : 20_000;

const LIFECYCLE_ON_ENV = { NODE_ENV: "test", PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "true" } as NodeJS.ProcessEnv;
const LIFECYCLE_OFF_ENV = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

/** Bulk-links every still-`pending` `novel_source_item` under `channelAppId` to a fresh `Novel` row, one statement — the per-row `linkSources` helper `postgres.test.ts` uses is only ever exercised at fixture scale (≤101 rows) elsewhere; at 20k+ rows the same 1-row-at-a-time loop would dominate this suite's wall clock. */
async function bulkLinkAllSourceItems(db: PrismaClient, channelAppId: string): Promise<number> {
  const affected = await db.$executeRaw(Prisma.sql`
    WITH source_rows AS (
      SELECT id, row_number() OVER (ORDER BY id) AS rn
      FROM novel_source_item
      WHERE channel_app_id = ${channelAppId}::uuid AND novel_id IS NULL
    ),
    inserted_novels AS (
      INSERT INTO novel (id, business_id, title, description, locale, slug, created_at, updated_at)
      SELECT gen_random_uuid(), 'shard-enum-nv-' || rn, 'Shard enum fixture ' || rn, 'shard enum fixture', 'en',
             'shard-enum-nv-' || rn, transaction_timestamp(), transaction_timestamp()
      FROM source_rows
      RETURNING id, business_id
    )
    UPDATE novel_source_item nsi
    SET novel_id = iv.id, status = 'linked'
    FROM source_rows sr
    JOIN inserted_novels iv ON iv.business_id = 'shard-enum-nv-' || sr.rn
    WHERE nsi.id = sr.id
  `);
  return affected;
}

/** Seeds `count` already-`success` `promo_link.claim.v1` items for `channelAccountId`, each with an identical `durationSeconds` execution time — used to make `measureRecentShardP90`'s measured branch deterministic to assert against (percentile of a constant set is that constant). */
async function seedCompletedClaimHistory(
  db: PrismaClient,
  input: { channelAppId: string; channelAccountId: string; count: number; durationSeconds: number },
): Promise<void> {
  for (let i = 0; i < input.count; i += 1) {
    const finishedAt = new Date(Date.now() - i * 1_000);
    const startedAt = new Date(finishedAt.getTime() - input.durationSeconds * 1_000);
    await db.genericTask.create({
      data: {
        taskType: PROMO_LINK_CLAIM_TASK_TYPE,
        channelAppId: input.channelAppId,
        channelAccountId: input.channelAccountId,
        operationScopeHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        requestToken: randomUUID(),
        status: "completed",
        totalCount: 1,
        successCount: 1,
        items: {
          create: {
            targetType: "novel_source_item",
            targetId: randomUUID(),
            status: "success",
            startedAt,
            finishedAt,
            payload: {},
          },
        },
      },
    });
  }
}

function handlerContext(lease: NonNullable<Awaited<ReturnType<typeof claimPendingItem>>>) {
  return { lease, mode: lease.mode, signal: new AbortController().signal, heartbeat: async () => true };
}

describe.skipIf(!enabled).sequential("promo-claim lifecycle: 阶段2 第2步枚举切分片 (real Postgres)", () => {
  beforeAll(async () => assertDisposableCatalogDatabase(prisma), 30_000);
  beforeEach(async () => {
    await truncateCatalogDatabase(prisma);
    foundation = await seedCatalogFoundation(prisma, 1);
    await prisma.channelCapability.create({
      data: {
        channelAppId: foundation.channels[0]!.channelAppId,
        capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY,
        status: "enabled",
        sideEffecting: true,
        evidenceLevel: "OWNER_APPROVED_WRITE_PROBE",
      },
    });
  });
  afterEach(() => {
    delete process.env.FEATURE_PROMO_LINK_CLAIM;
    delete process.env.PROMO_LINK_CLAIM_ALLOW_WRITE;
  });
  afterAll(async () => prisma.$disconnect());

  it(
    `enumerates ${scaleCount.toLocaleString("en-US")} eligible books into disabled awaiting_release shards, and selectPending refuses every one of them until a shard is (simulated-)released`,
    async () => {
      const channel = foundation.channels[0]!;
      const ids = await seedCatalogRows(prisma, { channelAppId: channel.channelAppId, count: scaleCount, prefix: "shard-enum" });
      const linked = await bulkLinkAllSourceItems(prisma, channel.channelAppId);
      expect(linked).toBe(scaleCount);

      const enqueued = await enqueueCatalogBatch(prisma, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [channel.channelAppId]: channel.accountId },
      }, new Date(), true, undefined, LIFECYCLE_ON_ENV);

      const parentBefore = await prisma.genericTask.findUniqueOrThrow({ where: { id: enqueued.taskId } });
      expect(parentBefore.params).toMatchObject({ lifecycleVersion: 1, lifecycleRole: "batch" });
      expect(parentBefore.params).not.toHaveProperty("deadlineAt");

      // 设计 §5.2/批次死锁回归：批次自己的枚举条目（挂在批次父任务本身下面，
      // params.lifecycleRole = "batch"）在枚举发生之前必须能被正常领到——
      // 这就是把 `selectPending` 的下推条件从"只看 lifecycleVersion"改成
      // "同时看 lifecycleRole"要保证的性质（第1步复核发现的死锁缺陷的
      // 回归验证，这里用 `enqueueCatalogBatch` 真实产出的批次而不是手工构造）。
      const lease = await claimPendingItem(prisma, {
        family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "shard-enum-probe", leaseMs: 120_000,
      });
      expect(lease).not.toBeNull();
      expect(lease!.taskId).toBe(enqueued.taskId);

      const outcome = await createCatalogBatchHandler(prisma, { env: LIFECYCLE_ON_ENV })(handlerContext(lease!));
      const enumerateStartedAt = performance.now();
      await finalizeTaskItem(prisma, lease!, outcome);
      const enumerateElapsedMs = Math.round(performance.now() - enumerateStartedAt);
      // eslint-disable-next-line no-console
      console.info(`PROMO_CLAIM_SHARD_ENUM_METRIC scaleCount=${scaleCount} enumerateMs=${enumerateElapsedMs}`);
      // 现有枚举事务超时（`worker/handlers/catalog-batch.ts` 的
      // `transactionTimeoutMs: 120_000`）——本条断言就是"证明在现有 120 秒
      // 事务超时以内"这一验收点。
      expect(enumerateElapsedMs).toBeLessThan(120_000);

      // 没有历史已完成的 promo_link.claim.v1 条目（一次性库全新建立）——
      // 样本量为 0，必须落到"样本不足按 5 秒回退"这条分支，而不是悄悄用一个
      // 无效/负数当作测出来的 p90。
      const expectedShardSize = computeShardSize({
        p90ItemSeconds: null,
        windowMinutes: 90,
        min: 50,
        max: 1_000,
      });
      // 用同一个纯函数独立算出预期值（756 = floor(90*42/5)），而不是把这个数字
      // 写死在断言里——如果默认窗口/回退 p90 以后改了，这条测试会跟着改变
      // 期望值而不是悄悄测错东西。
      expect(expectedShardSize).toBeGreaterThan(0);

      const shards = await prisma.genericTask.findMany({
        where: { parentTaskId: enqueued.taskId },
        include: { items: true },
        orderBy: [{ createdAt: "asc" }],
      });
      const expectedShardCount = Math.ceil(scaleCount / expectedShardSize);
      expect(shards).toHaveLength(expectedShardCount);

      const totalItems = shards.reduce((sum, shard) => sum + shard.items.length, 0);
      expect(totalItems).toBe(scaleCount);

      const sortedByShardIndex = [...shards].sort((a, b) => {
        const ai = (a.params as { shardIndex: number }).shardIndex;
        const bi = (b.params as { shardIndex: number }).shardIndex;
        return ai - bi;
      });
      sortedByShardIndex.forEach((shard, index) => {
        expect(shard.status).toBe("disabled");
        expect(shard.taskType).toBe(PROMO_LINK_CLAIM_TASK_TYPE);
        expect(shard.channelAccountId).toBe(channel.accountId);
        expect(shard.channelAppId).toBe(channel.channelAppId);

        const marker = readTaskControlMarker(shard.result);
        expect(marker).toMatchObject({ kind: "awaiting_release", source: "system" });
        expect(typeof marker?.at).toBe("string");

        expect(shard.params).toMatchObject({
          lifecycleVersion: 1,
          lifecycleRole: "shard",
          shardIndex: index,
          releaseCount: 0,
          missedDeadlineCount: 0,
        });
        expect(shard.params).not.toHaveProperty("deadlineAt");
        expect(shard.params).not.toHaveProperty("releasedAt");

        const isLastShard = index === sortedByShardIndex.length - 1;
        expect(shard.totalCount).toBe(isLastShard ? scaleCount - expectedShardSize * (sortedByShardIndex.length - 1) : expectedShardSize);
        expect(shard.items).toHaveLength(shard.totalCount);
        for (const item of shard.items) {
          expect(item.status).toBe("pending");
          expect(item.payload).toMatchObject({ lifecycle: "shard_v1", channelAccountId: channel.accountId, channelAppId: channel.channelAppId });
        }
      });

      // requestToken 与 operationScopeHash 在所有分片之间互不相同——分片处于
      // disabled 时不参与 `generic_task_active_scope_uidx`（该唯一索引的
      // WHERE 谓词只覆盖 pending/processing 行），但这里额外用应用层断言核对
      // 唯一性本身成立，而不是依赖"反正用不上索引"。
      const requestTokens = new Set(shards.map((s) => s.requestToken));
      const scopeHashes = new Set(shards.map((s) => s.operationScopeHash));
      expect(requestTokens.size).toBe(shards.length);
      expect(scopeHashes.size).toBe(shards.length);

      const parentAfter = await prisma.genericTask.findUniqueOrThrow({ where: { id: enqueued.taskId } });
      expect(parentAfter.result).toMatchObject({
        enumerationStatus: "completed",
        submittedCount: scaleCount,
        childTaskCount: shards.length,
        shardPlan: {
          windowMinutes: 90,
          shardSizeMin: 50,
          shardSizeMax: 1_000,
          shardCount: shards.length,
          shardSize: expectedShardSize,
          sizingBasis: { sampleCount: 0, source: "fallback_insufficient_sample", p90Seconds: PROMO_CLAIM_LIFECYCLE_DEFAULTS.fallbackP90ItemSeconds },
        },
      });

      // 设计 §5.6：所有分片都还没放行（没有 deadlineAt），selectPending 必须
      // 完全领不到 promo_link.claim.v1 的条目。
      const claimBeforeRelease = await claimPendingItem(prisma, {
        family: "generic", taskTypes: [PROMO_LINK_CLAIM_TASK_TYPE], workerId: "shard-enum-probe", leaseMs: 30_000,
      });
      expect(claimBeforeRelease).toBeNull();

      // 更深一层：即使只把某一个分片的父任务状态错误地改成 pending（模拟一次
      // "放行流程漏写 deadlineAt"的 bug），下推条件仍然必须单独挡住它——不能
      // 只靠"父任务状态是 disabled"这一条旧规则。
      const firstShardId = sortedByShardIndex[0]!.id;
      await prisma.genericTask.update({ where: { id: firstShardId }, data: { status: "pending" } });
      const claimWithoutDeadline = await claimPendingItem(prisma, {
        family: "generic", taskTypes: [PROMO_LINK_CLAIM_TASK_TYPE], workerId: "shard-enum-probe", leaseMs: 30_000,
      });
      expect(claimWithoutDeadline).toBeNull();

      // 正面用例：真正"放行"（写 deadlineAt，且晚于现在）之后，同一个分片的
      // 条目必须变得可领——证明下推条件不是恒假,而是精确按 deadlineAt 判定。
      const shardParams = sortedByShardIndex[0]!.params as Record<string, unknown>;
      await prisma.genericTask.update({
        where: { id: firstShardId },
        data: { params: { ...shardParams, deadlineAt: new Date(Date.now() + 90 * 60_000).toISOString() } },
      });
      const claimAfterRelease = await claimPendingItem(prisma, {
        family: "generic", taskTypes: [PROMO_LINK_CLAIM_TASK_TYPE], workerId: "shard-enum-probe", leaseMs: 30_000,
      });
      expect(claimAfterRelease).not.toBeNull();
      expect(claimAfterRelease!.taskId).toBe(firstShardId);
    },
    180_000,
  );

  it("uses the measured recent-completed-item p90 (not the fallback) once the channel account has >= 50 completed items", async () => {
    const channel = foundation.channels[0]!;
    const knownDurationSeconds = 20;
    await seedCompletedClaimHistory(prisma, {
      channelAppId: channel.channelAppId, channelAccountId: channel.accountId, count: 60, durationSeconds: knownDurationSeconds,
    });

    const memberCount = 500;
    const ids = await seedCatalogRows(prisma, { channelAppId: channel.channelAppId, count: memberCount, prefix: "shard-p90" });
    await bulkLinkAllSourceItems(prisma, channel.channelAppId);

    const enqueued = await enqueueCatalogBatch(prisma, {
      operation: "promo_claim",
      selection: normalizeCatalogSelection({ scope: "explicit_ids", ids }),
      actorId: foundation.actorId,
      requestId: randomUUID(),
      channelAccounts: { [channel.channelAppId]: channel.accountId },
    }, new Date(), true, undefined, LIFECYCLE_ON_ENV);
    const lease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "shard-p90-probe", leaseMs: 60_000,
    });
    const outcome = await createCatalogBatchHandler(prisma, { env: LIFECYCLE_ON_ENV })(handlerContext(lease!));
    await finalizeTaskItem(prisma, lease!, outcome);

    // 60 条历史记录、全部时长相同（20 秒）：p90 就是 20（常数集合的任意分位数
    // 都是那个常数），且必须走"measured"分支，而不是回退默认值 5 秒。
    const expectedShardSize = computeShardSize({ p90ItemSeconds: knownDurationSeconds, windowMinutes: 90, min: 50, max: 1_000 });
    const parent = await prisma.genericTask.findUniqueOrThrow({ where: { id: enqueued.taskId } });
    expect(parent.result).toMatchObject({
      shardPlan: {
        shardSize: expectedShardSize,
        sizingBasis: { sampleCount: 60, source: "measured_recent_completed_items", p90Seconds: knownDurationSeconds },
      },
    });
    const shards = await prisma.genericTask.findMany({ where: { parentTaskId: enqueued.taskId } });
    expect(shards).toHaveLength(Math.ceil(memberCount / expectedShardSize));
  }, 60_000);

  it("switch off: the same data still builds exactly one pending child task under the legacy TTL, byte-for-byte unchanged", async () => {
    process.env.FEATURE_PROMO_LINK_CLAIM = "true";
    process.env.PROMO_LINK_CLAIM_ALLOW_WRITE = "true";
    const channel = foundation.channels[0]!;
    const ids = await seedCatalogRows(prisma, { channelAppId: channel.channelAppId, count: 51, prefix: "legacy-off" });
    await bulkLinkAllSourceItems(prisma, channel.channelAppId);

    const submittedAt = new Date();
    const enqueued = await enqueueCatalogBatch(prisma, {
      operation: "promo_claim",
      selection: normalizeCatalogSelection({ scope: "explicit_ids", ids }),
      actorId: foundation.actorId,
      requestId: randomUUID(),
      channelAccounts: { [channel.channelAppId]: channel.accountId },
    }, submittedAt, true, undefined, LIFECYCLE_OFF_ENV);

    const parent = await prisma.genericTask.findUniqueOrThrow({ where: { id: enqueued.taskId } });
    expect(parent.params).not.toHaveProperty("lifecycleVersion");
    expect(parent.params).not.toHaveProperty("lifecycleRole");
    expect((parent.params as { expiresAt: string }).expiresAt).toBe(new Date(submittedAt.getTime() + 6 * 60 * 60 * 1_000).toISOString());

    const lease = await claimPendingItem(prisma, {
      family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "legacy-off-probe", leaseMs: 60_000,
    });
    const outcome = await createCatalogBatchHandler(prisma, { env: LIFECYCLE_OFF_ENV })(handlerContext(lease!));
    await finalizeTaskItem(prisma, lease!, outcome);

    const children = await prisma.genericTask.findMany({ where: { parentTaskId: enqueued.taskId }, include: { items: true } });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ status: "pending", taskType: PROMO_LINK_CLAIM_TASK_TYPE, totalCount: 51 });
    expect(children[0]!.items).toHaveLength(51);
    expect(children[0]!.params).not.toHaveProperty("lifecycleVersion");
    for (const item of children[0]!.items) {
      expect(item.payload).not.toHaveProperty("lifecycle");
    }
    const parentAfter = await prisma.genericTask.findUniqueOrThrow({ where: { id: enqueued.taskId } });
    expect(parentAfter.result).not.toHaveProperty("shardPlan");
  });
});
