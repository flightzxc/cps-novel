/**
 * 领推广链接正式修复第 5 阶段·5-A（`设计_领推广按接口限速与预读集合化_
 * 阶段4-5_2026-09-24.md` §6.2 第 2/3 条、§9.2、§十 施工拆分表，Owner 裁决
 * E5/E8）：目录页位置登记之后，生命周期分片枚举（`worker/handlers/
 * catalog-batch.ts`）按页坐标排序、并给分片条目载荷打上 `catalogPageHint`/
 * `preReadMode` 两个提示键。
 *
 * 为什么单独一个文件、不并进 `promo-claim-lifecycle-shard-enumeration-
 * postgres.test.ts`：那个文件已经覆盖分片大小/请求令牌/放行下推等一大片
 * 与页坐标无关的既有断言；本文件只关心 5-A 这一步新增的行为，用它自己的
 * 8 万级规模旋钮独立跑，不拖慢那个文件的默认（更小规模）用例。
 *
 * `sortMembersByCatalogPosition`/`assignCatalogPageHints` 两个纯函数本身
 * 已经在 `tests/backend/catalog-batch/lifecycle-shard-enumeration.test.ts`
 * 做了穷尽的边界单测；这里只验证"真实 Postgres 上、真实 `novel_source_item`
 * 行、真实枚举事务"把它们正确接到分片条目上——纯函数单测测不出的是：
 * ①`ROW_SELECT` 真的把 `catalog_position` 列选出来了；②大规模（8 万行）下
 * 排序/分组不超时；③写进 `generic_task_item.payload` 的两个键与 DB 里的
 * `catalog_position` 一致。
 *
 * 验证手法（用于替代"逐条断言条目物理写入顺序"——`generic_task_item` 没有
 * 任何可读的组内序号列，`created_at` 在同一个枚举事务内对 Postgres 而言是
 * 同一个事务时间戳，不能当排序凭据）：
 *   1. 按 id 升序的"行秩"分配页坐标，且**刻意与 id 反向**（id 秩越小分到的
 *      pageIndex 越大）——如果排序退化为纯 id 升序（"排序回退为纯 id"这条
 *      变异），下面的"跨分片页码不下降"断言会被直接推翻，而不是碰巧通过。
 *   2. 断言按 shardIndex 升序，相邻分片之间"上一分片已登记成员的最大
 *      pageIndex ≤ 下一分片已登记成员的最小 pageIndex"——这是"整组按
 *      pageIndex 升序排序后再切片"在分片边界上唯一可从物理行直接验证的
 *      推论。
 *   3. 断言"一旦某分片出现未登记成员，其后的每个分片全部是未登记成员"——
 *      这是"无登记者排最后"在分片边界上的推论。
 *   4. 每个条目的 `preReadMode`/`catalogPageHint` 与该行 `catalog_position`
 *      的页组本数（阈值 2）独立重算的期望值精确比对。
 *   5. 混入一批"坐标签名不匹配"（`pageSize=20`，C-13 之前的历史值）的行，
 *      期望它们被当作未登记处理——覆盖"坐标签名不匹配仍被采信"这条变异。
 *
 * 运行（8 万条规模，一次性 `postgres:16.14` 容器，照 `scripts/
 * run-catalog-batch-postgres-verification.sh` 的角色/迁移/授权套路，直接用
 * migration_owner 连接跑枚举逻辑本身——与同目录
 * `promo-claim-lifecycle-shard-enumeration-postgres.test.ts` 同一连接纪律，
 * 该文件本来就不是角色权限验证套件，角色权限验证见 `tests/integration/
 * tasks/p2-05-postgres.test.ts` 里 `persistCatalogPage` 的 `worker_app` 用例）：
 *
 *   docker run --rm -d --name cb-pg-pos -e POSTGRES_PASSWORD=cb \
 *     -e POSTGRES_DB=cps_novel_catalog_batch_pos -p 55434:5432 postgres:16.14
 *   DATABASE_URL=postgresql://postgres:cb@localhost:55434/cps_novel_catalog_batch_pos \
 *     npx prisma migrate deploy
 *   PROMO_CLAIM_CATALOG_POSITION_SORT_DATABASE_TEST=1 \
 *   PROMO_CLAIM_CATALOG_POSITION_SORT_SCALE_COUNT=80000 \
 *   DATABASE_URL=postgresql://postgres:cb@localhost:55434/cps_novel_catalog_batch_pos \
 *     npx vitest run --project node tests/integration/catalog-batch/promo-claim-catalog-position-sort-postgres.test.ts
 *   docker stop cb-pg-pos
 *
 * 默认（未显式覆盖 SCALE_COUNT）跑 5,000 条，把默认套件的挂钟时间留给已有的
 * `promo-claim-lifecycle-shard-enumeration-postgres.test.ts`；8 万条是本轮
 * 验收单独跑一次并把 `enumerateMs` 记入报告。
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeCatalogSelection } from "@/domain/catalog-batch";
import { CATALOG_BATCH_TASK_TYPE, claimPendingItem, computeShardSize, enqueueCatalogBatch, finalizeTaskItem } from "@/lib/tasks";
import { PROMO_LINK_CLAIM_CAPABILITY_KEY } from "@/lib/tasks/promo-link-claim-limits";
import { PROMO_CLAIM_PAGE_GROUP_MIN_MEMBERS } from "@/lib/tasks/promo-claim-lifecycle";
import { createCatalogBatchHandler } from "../../../worker/handlers/catalog-batch";
import { assertDisposableCatalogDatabase, seedCatalogFoundation, truncateCatalogDatabase, type CatalogFoundation } from "./support";

const enabled = process.env.PROMO_CLAIM_CATALOG_POSITION_SORT_DATABASE_TEST === "1";
const prisma = new PrismaClient();
let foundation: CatalogFoundation;

const requestedScaleCount = Number.parseInt(process.env.PROMO_CLAIM_CATALOG_POSITION_SORT_SCALE_COUNT ?? "5000", 10);
const scaleCount = Number.isSafeInteger(requestedScaleCount) && requestedScaleCount > 0 ? requestedScaleCount : 5_000;

const LIFECYCLE_ON_ENV = { NODE_ENV: "test", PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "true" } as NodeJS.ProcessEnv;

function handlerContext(lease: NonNullable<Awaited<ReturnType<typeof claimPendingItem>>>) {
  return { lease, mode: lease.mode, signal: new AbortController().signal, heartbeat: async () => true };
}

/**
 * 造 `count` 条 `novel_source_item`，已 `linked` 且带 `catalog_position`——
 * 按 id 升序的行秩（1 起）分三段：
 *   - 前 `mismatchedCount` 条：坐标签名不匹配（`pageSize=20`，历史值），
 *     `pageIndex` 本身有值但必须被判定当作未登记；
 *   - 接下来 `registeredCount` 条：可信登记，`pageIndex` 与行秩**反向**
 *     （行秩越小 pageIndex 越大），每 `density` 条共享一个 `pageIndex`；
 *   - 剩余（`count - mismatchedCount - registeredCount`）条：`catalog_position`
 *     为 NULL（真正未登记）。
 * 三段的行秩边界都在 id 升序里连续，跟生产里"扫描过的书在前、还没扫描到的
 * 书在后"这种自然分布同构，但页码分配刻意反向，见文件头注释第 1 点。
 */
async function seedRowsWithCatalogPosition(
  db: PrismaClient,
  input: {
    channelAppId: string;
    count: number;
    mismatchedCount: number;
    registeredCount: number;
    density: number;
    scanTaskId: string;
    prefix: string;
  },
): Promise<string[]> {
  const { channelAppId, count, mismatchedCount, registeredCount, density, scanTaskId, prefix } = input;
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO novel_source_item (
      id, channel_app_id, external_book_id, source_language_code, source_locale,
      title, description, status, raw_payload, updated_at, catalog_position
    )
    SELECT
      gen_random_uuid(),
      ${channelAppId}::uuid,
      ${prefix} || '-' || n::text,
      'en', 'en',
      ${prefix} || ' title ' || lpad(n::text, 6, '0'),
      'catalog position sort fixture',
      'pending',
      jsonb_build_object('fixture', ${prefix}, 'ordinal', n),
      transaction_timestamp(),
      CASE
        WHEN n <= ${mismatchedCount} THEN jsonb_build_object(
          'pageIndex', ((n - 1) / ${density})::int + 1,
          'pageSize', 20, 'orderType', 0, 'nameEmpty', true,
          'observedAt', transaction_timestamp()::text, 'scanTaskId', ${scanTaskId}
        )
        WHEN n <= ${mismatchedCount} + ${registeredCount} THEN jsonb_build_object(
          'pageIndex', ((${registeredCount} - (n - ${mismatchedCount} - 1) - 1) / ${density})::int + 1,
          'pageSize', 100, 'orderType', 0, 'nameEmpty', true,
          'observedAt', transaction_timestamp()::text, 'scanTaskId', ${scanTaskId}
        )
        ELSE NULL
      END
    FROM generate_series(1, ${count}) AS n
    RETURNING id
  `);
  return rows.map((row) => row.id);
}

/**
 * 一条语句把这批全部 link 到各自新建的 Novel，供 `promo_claim` 枚举的
 * eligibility 判定通过。**没有**照搬 `promo-claim-lifecycle-shard-
 * enumeration-postgres.test.ts` 的 `bulkLinkAllSourceItems`（`source_rows`
 * 与 `inserted_novels` 两个 CTE 各自算出 `row_number()`/新建 id 后再按
 * `iv.business_id = 'x' || sr.rn` 二次 JOIN 到一起）——诊断发现那个写法在
 * 8 万行规模下会被规划器按 `rows≈1` 的（CTE 链上不可用真实统计信息）错误
 * 基数估计选中 Nested Loop（非 Hash Join）来执行这个 JOIN，实测在真实数据
 * 下退化为 O(n²)、单条语句跑到 10 分钟仍未结束（`EXPLAIN (ANALYZE, BUFFERS)`
 * 复现：`Nested Loop ... Join Filter: (sr.rn = ni.rn)`，两侧均 80,000 行）。
 * 本函数把"新 Novel 的 id"直接算进唯一一个 CTE（`source_rows` 自己带
 * `new_novel_id` 列），后续只剩 `nsi.id = sr.id` 这一个走主键索引的等值
 * JOIN——同一份数据、同一规模，`EXPLAIN ANALYZE` 实测总耗时从未结束收敛到
 * 约 1.5 秒。
 */
async function bulkLinkAllSourceItems(db: PrismaClient, channelAppId: string): Promise<number> {
  const affected = await db.$executeRaw(Prisma.sql`
    WITH source_rows AS (
      SELECT id, row_number() OVER (ORDER BY id) AS rn, gen_random_uuid() AS new_novel_id
      FROM novel_source_item
      WHERE channel_app_id = ${channelAppId}::uuid AND novel_id IS NULL
    ),
    inserted_novels AS (
      INSERT INTO novel (id, business_id, title, description, locale, slug, created_at, updated_at)
      SELECT new_novel_id, 'cp-sort-nv-' || rn, 'Catalog position sort fixture ' || rn, 'fixture', 'en',
             'cp-sort-nv-' || rn, transaction_timestamp(), transaction_timestamp()
      FROM source_rows
      RETURNING id
    )
    UPDATE novel_source_item nsi
    SET novel_id = sr.new_novel_id, status = 'linked'
    FROM source_rows sr
    WHERE nsi.id = sr.id
  `);
  return affected;
}

type ShardItemRow = { shardIndex: number; catalogPageHint: number | null; preReadMode: string };

describe.skipIf(!enabled).sequential("promo-claim lifecycle 5-A: 页位置登记后的枚举排序与载荷提示 (real Postgres)", () => {
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
    `sorts ${scaleCount.toLocaleString("en-US")} books by trusted page position, groups untrusted/mismatched-signature rows to the tail, and stamps catalogPageHint/preReadMode consistently`,
    async () => {
      const channel = foundation.channels[0]!;
      const scanTaskId = randomUUID();
      const density = 25;
      // 10% 坐标签名不匹配（历史 pageSize=20）、70% 可信登记、20% 未登记——
      // 三段都足够大，保证枚举后至少跨越好几个分片边界。
      const mismatchedCount = Math.floor(scaleCount * 0.1);
      const registeredCount = Math.floor(scaleCount * 0.7);
      const ids = await seedRowsWithCatalogPosition(prisma, {
        channelAppId: channel.channelAppId, count: scaleCount, mismatchedCount, registeredCount, density, scanTaskId, prefix: "cp-sort",
      });
      const linked = await bulkLinkAllSourceItems(prisma, channel.channelAppId);
      expect(linked).toBe(scaleCount);

      const enqueued = await enqueueCatalogBatch(prisma, {
        operation: "promo_claim",
        selection: normalizeCatalogSelection({ scope: "explicit_ids", ids }),
        actorId: foundation.actorId,
        requestId: randomUUID(),
        channelAccounts: { [channel.channelAppId]: channel.accountId },
      }, new Date(), true, undefined, LIFECYCLE_ON_ENV);

      const lease = await claimPendingItem(prisma, {
        family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "cp-sort-probe", leaseMs: 120_000,
      });
      expect(lease).not.toBeNull();

      const outcome = await createCatalogBatchHandler(prisma, { env: LIFECYCLE_ON_ENV })(handlerContext(lease!));
      const enumerateStartedAt = performance.now();
      await finalizeTaskItem(prisma, lease!, outcome);
      const enumerateElapsedMs = Math.round(performance.now() - enumerateStartedAt);
      console.info(`PROMO_CLAIM_CATALOG_POSITION_SORT_METRIC scaleCount=${scaleCount} enumerateMs=${enumerateElapsedMs}`);
      // 设计 §十 施工拆分表 5-A 行 + §9.2 验收第 2 条："8 万级枚举耗时仍在
      // 现有 120 秒事务超时（`transactionTimeoutMs: 120_000`）以内"。
      expect(enumerateElapsedMs).toBeLessThan(120_000);

      const expectedShardSize = computeShardSize({ p90ItemSeconds: null, windowMinutes: 90, min: 50, max: 1_000 });
      const shards = await prisma.genericTask.findMany({
        where: { parentTaskId: enqueued.taskId },
        include: { items: true },
        orderBy: [{ createdAt: "asc" }],
      });
      expect(shards).toHaveLength(Math.ceil(scaleCount / expectedShardSize));
      const totalItems = shards.reduce((sum, shard) => sum + shard.items.length, 0);
      expect(totalItems).toBe(scaleCount);

      // 展平成 (shardIndex, catalogPageHint, preReadMode) 行，按 shardIndex
      // 升序——这是下面两条跨分片断言的唯一依据（组内条目次序本身不可读取，
      // 见文件头注释）。
      const rows: ShardItemRow[] = [];
      for (const shard of shards) {
        const shardIndex = (shard.params as { shardIndex: number }).shardIndex;
        for (const item of shard.items) {
          const p = item.payload as { catalogPageHint: number | null; preReadMode: string };
          expect(p).toHaveProperty("catalogPageHint");
          expect(p).toHaveProperty("preReadMode");
          rows.push({ shardIndex, catalogPageHint: p.catalogPageHint, preReadMode: p.preReadMode });
        }
      }
      rows.sort((a, b) => a.shardIndex - b.shardIndex);

      // ---- 断言 1: preReadMode/catalogPageHint 与页组本数（阈值 2）精确一致 ----
      // 期望的页组本数：可信登记的 registeredCount 条被 `density` 分组，每组
      // 都 >= threshold（25 >= 2），所以全部应为 "page"；未登记与坐标签名
      // 不匹配的两段合计 `scaleCount - registeredCount` 条，全部应为 "title"
      // 且 catalogPageHint 为 null。
      const registeredRows = rows.filter((r) => r.catalogPageHint !== null);
      const untrustedRows = rows.filter((r) => r.catalogPageHint === null);
      expect(registeredRows).toHaveLength(registeredCount);
      expect(untrustedRows).toHaveLength(scaleCount - registeredCount);
      expect(registeredRows.every((r) => r.preReadMode === "page")).toBe(true);
      expect(untrustedRows.every((r) => r.preReadMode === "title")).toBe(true);
      expect(PROMO_CLAIM_PAGE_GROUP_MIN_MEMBERS).toBeLessThanOrEqual(density);

      // ---- 断言 2: 跨分片页码单调不降（证明排序真的按 pageIndex 生效，
      // 而不是退化为纯 id 升序——数据是反向构造的，见文件头注释第 1 点） ----
      const byShardIndex = new Map<number, ShardItemRow[]>();
      for (const row of rows) {
        const bucket = byShardIndex.get(row.shardIndex) ?? [];
        bucket.push(row);
        byShardIndex.set(row.shardIndex, bucket);
      }
      const shardIndexesAscending = [...byShardIndex.keys()].sort((a, b) => a - b);
      let previousMaxRegisteredPage = -Infinity;
      let sawUnregisteredShard = false;
      for (const shardIndex of shardIndexesAscending) {
        const bucket = byShardIndex.get(shardIndex)!;
        const registeredPages = bucket.map((r) => r.catalogPageHint).filter((p): p is number => p !== null);
        const hasUnregistered = bucket.some((r) => r.catalogPageHint === null);
        if (registeredPages.length > 0) {
          // ---- 断言 3: 一旦更早的分片出现过未登记成员，本分片不应再出现
          // 已登记成员（"无登记者排最后"在分片边界上的推论）。
          expect(sawUnregisteredShard).toBe(false);
          const minPageThisShard = Math.min(...registeredPages);
          const maxPageThisShard = Math.max(...registeredPages);
          expect(minPageThisShard).toBeGreaterThanOrEqual(previousMaxRegisteredPage);
          previousMaxRegisteredPage = Math.max(previousMaxRegisteredPage, maxPageThisShard);
        }
        if (hasUnregistered) sawUnregisteredShard = true;
      }
      // 断言 3 的正面版本：既然构造了 20%+10% 未登记/不匹配的行，必须真的
      // 观察到至少一个"全部未登记"的分片，否则上面的循环等于没测到东西。
      expect(sawUnregisteredShard).toBe(true);
    },
    600_000,
  );
});
