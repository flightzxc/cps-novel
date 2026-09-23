/**
 * 领推广链接生命周期正式修复第 2 阶段第 3 步：scheduler 放行 / 暂停
 * （`src/lib/tasks/promo-claim-release.ts`）的真实 PostgreSQL 验收。
 *
 * 为什么不能只用假 tx 做单测：`releasePromoClaimShardsForAccount` 的正确性
 * 核心依赖真实查询计划与并发语义——按渠道账号的事务级咨询锁
 * （`pg_advisory_xact_lock`）、分片选择的 `ORDER BY ... FOR UPDATE SKIP
 * LOCKED`、`generic_task_active_scope_uidx` 部分唯一索引——这些离不开一次
 * 真实事务；`tests/backend/tasks/promo-claim-release-branches.test.ts` 已经
 * 用手写假 `Prisma.TransactionClient` 覆盖了 D4/凭据/批准时钟/promo 双闸这
 * 四段纯判定逻辑分支，本文件只覆盖"离不开真实数据库"的那部分：完整放行
 * 事务、真实 `scheduler_app` 角色的权限、100 次并发触发放行。
 *
 * 一次性库安全守卫：数据库名必须以 `cps_novel_promo_claim_release_` 开头
 * （`scripts/run-promo-claim-release-postgres-verification.sh` 生成的名字）
 * 且是 PostgreSQL 16.14——同 `tests/integration/catalog-batch/support.ts`
 * 的 `assertDisposableCatalogDatabase` 同一纪律，本文件自己实现一份（数据库
 * 名前缀不同，不能直接复用那个函数）。
 *
 * 运行方式：
 *   bash scripts/run-promo-claim-release-postgres-verification.sh
 * 该脚本会起一个全新一次性 postgres:16.14 容器（独立端口，绝不触碰任何既有
 * 容器/数据库）、建六个最小权限角色、迁移、重放 grants.sql，再用
 * `PROMO_CLAIM_RELEASE_OWNER_DATABASE_URL`（migration_owner，仅用于造数据/
 * 断言）与 `PROMO_CLAIM_RELEASE_SCHEDULER_DATABASE_URL`（scheduler_app，真正
 * 驱动每一次放行）两个连接串跑本文件，最后删除容器。
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
import { createCatalogBatchHandler } from "../../../worker/handlers/catalog-batch";

const enabled = process.env.PROMO_CLAIM_RELEASE_DATABASE_TEST === "1";
const requiredUrl = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};

const owner = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_RELEASE_OWNER_DATABASE_URL") });
const scheduler = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_RELEASE_SCHEDULER_DATABASE_URL") });

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

async function expectDenied(action: () => Promise<unknown>) {
  await expect(action()).rejects.toThrow();
}

interface Foundation {
  actorId: string;
  channelId: string;
  sourceAppId: string;
  channelAppId: string;
  accountId: string;
  credentialId: string;
}

async function assertDisposablePromoClaimReleaseDatabase(db: PrismaClient): Promise<void> {
  const [database] = await db.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version
  `;
  if (!database.name.startsWith("cps_novel_promo_claim_release_")) {
    throw new Error(`Refusing promo-claim-release setup against ${database.name}`);
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

/** 一个渠道 + 一个已启用 claimPromo 能力的渠道应用 + 一个渠道账号 + 一条"就绪"凭据。 */
async function seedFoundation(db: PrismaClient): Promise<Foundation> {
  const actorId = `promo-claim-release-pg-${randomUUID()}`;
  const channelId = randomUUID();
  const sourceAppId = randomUUID();
  const channelAppId = randomUUID();
  const accountId = randomUUID();
  const code = `pcr-${randomUUID()}`;
  await db.channel.create({ data: { id: channelId, code, name: "Promo Claim Release PG" } });
  await db.sourceApp.create({ data: { id: sourceAppId, code: `${code}-source`, name: "Promo Claim Release Source" } });
  await db.channelApp.create({ data: { id: channelAppId, channelId, sourceAppId, externalAppId: `${code}-app`, projectType: 1 } });
  await db.channelAccount.create({ data: { id: accountId, channelId, businessId: `${code}-account`, accountName: "Promo Claim Release Account" } });
  await db.channelCapability.create({
    data: {
      channelAppId, capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY, status: "enabled",
      sideEffecting: true, evidenceLevel: "OWNER_APPROVED_WRITE_PROBE",
    },
  });
  const credential = await db.channelAccountCredential.create({
    data: {
      channelAccountId: accountId,
      encryptedSecret: Buffer.from(`pcr-secret-${randomUUID()}`),
      keyVersion: 1,
      secretFingerprint: randomUUID().replaceAll("-", ""),
      fingerprintPrefix: randomUUID().replaceAll("-", "").slice(0, 12),
      status: "active",
      // createdAt 显式定死在过去（而不是让它落到真实 now()）——这样下面的
      // lastValidatedAt 固定写 2026-09-22 才能稳定早于本行测试写的"提交时刻"
      // 2026-09-23，不受跑测试那一刻真实系统时钟影响（曾经因为宿主机真实
      // 时间已经到了 2026-09-23 当天，createdAt 落在 lastValidatedAt 之后，
      // 触发 evaluateCredentialReadiness 的 validated_before_creation，
      // 在一次性容器上真实复现过）。
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      lastValidatedAt: new Date("2026-09-22T00:00:00.000Z"),
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    },
  });
  return { actorId, channelId, sourceAppId, channelAppId, accountId, credentialId: credential.id };
}

/**
 * `promo_claim` 枚举的资格判定（`worker/handlers/catalog-batch.ts`）要求
 * `row.status === "linked" && row.novelId !== null`——一本书必须先"材料化"成
 * 一个 Novel 才谈得上领推广链接。这里一次性把新建的 `novel_source_item` 全部
 * 链到各自新建的 `Novel` 行，同 `tests/integration/catalog-batch/
 * promo-claim-lifecycle-shard-enumeration-postgres.test.ts` 的
 * `bulkLinkAllSourceItems` 同一做法（本文件规模小，改用简单的逐行写法而不是
 * 那边的批量窗口函数版本）。
 */
async function seedBooks(db: PrismaClient, channelAppId: string, count: number, prefix: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO novel_source_item (
      id, channel_app_id, external_book_id, source_language_code, source_locale,
      title, description, status, raw_payload, updated_at
    )
    SELECT gen_random_uuid(), ${channelAppId}::uuid, ${prefix} || '-' || n::text, 'en', 'en',
           ${prefix} || ' title ' || n::text, 'promo claim release fixture', 'pending',
           jsonb_build_object('fixture', ${prefix}), transaction_timestamp()
    FROM generate_series(1, ${count}) AS n
    RETURNING id
  `);
  const ids = rows.map((row) => row.id);
  for (const id of ids) {
    const novelId = randomUUID();
    const slug = `pcr-${randomUUID()}`;
    await db.$executeRaw(Prisma.sql`
      INSERT INTO novel (id, business_id, title, description, locale, slug, created_at, updated_at)
      VALUES (${novelId}::uuid, ${slug}, ${`${prefix} novel`}, 'promo claim release fixture', 'en', ${slug}, transaction_timestamp(), transaction_timestamp())
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

/** 提交一个生命周期批次并跑完枚举，返回按 shardIndex 排好序的分片 id（每片刚好 1 本书，因为 env 里 shardSizeMin=shardSizeMax=1）。 */
async function buildLifecycleShards(
  db: PrismaClient,
  foundation: Foundation,
  bookCount: number,
  prefix: string,
  env: NodeJS.ProcessEnv = LIFECYCLE_ON_ENV,
): Promise<{ batchId: string; shardIds: string[] }> {
  const bookIds = await seedBooks(db, foundation.channelAppId, bookCount, prefix);
  const enqueued = await enqueueCatalogBatch(db, {
    operation: "promo_claim",
    selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: bookIds }),
    actorId: foundation.actorId,
    requestId: randomUUID(),
    channelAccounts: { [foundation.channelAppId]: foundation.accountId },
  }, new Date(), true, undefined, env);
  const lease = await claimPendingItem(db, {
    family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "promo-claim-release-pg", leaseMs: 60_000,
  });
  const outcome = await createCatalogBatchHandler(db, { env })(handlerContext(lease!));
  await finalizeTaskItem(db, lease!, outcome);
  if (process.env.PROMO_CLAIM_RELEASE_DEBUG === "1") {
    const debugBatch = await db.genericTask.findUniqueOrThrow({ where: { id: enqueued.taskId } });
    // eslint-disable-next-line no-console
    console.error("PROMO_CLAIM_RELEASE_DEBUG batch", JSON.stringify({ status: debugBatch.status, params: debugBatch.params, result: debugBatch.result, error: debugBatch.error }, null, 2));
  }

  const shards = await db.genericTask.findMany({
    where: { parentTaskId: enqueued.taskId },
    orderBy: [{ createdAt: "asc" }],
  });
  const sorted = [...shards].sort((a, b) => (a.params as { shardIndex: number }).shardIndex - (b.params as { shardIndex: number }).shardIndex);
  return { batchId: enqueued.taskId, shardIds: sorted.map((s) => s.id) };
}

async function markCredential(
  db: PrismaClient,
  credentialId: string,
  patch: Partial<{ status: string; lastValidatedAt: Date | null; expiresAt: Date | null }>,
): Promise<void> {
  await db.channelAccountCredential.update({ where: { id: credentialId }, data: patch });
}

describe.skipIf(!enabled).sequential("promo-claim lifecycle: 阶段2 第3步 scheduler 放行/暂停 (real Postgres)", () => {
  let foundation: Foundation;

  beforeAll(async () => assertDisposablePromoClaimReleaseDatabase(owner), 30_000);
  beforeEach(async () => {
    await truncateDatabase(owner);
    foundation = await seedFoundation(owner);
  });
  afterAll(async () => {
    await owner.$disconnect();
    await scheduler.$disconnect();
  });

  it("首次放行：awaiting_release 分片被放行为 pending，写 deadlineAt/releaseCount/firstReleasedAt，并留下一条审计", async () => {
    const { batchId, shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-basic");
    const now = new Date("2026-09-23T12:00:00.000Z");
    const outcomes = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(outcomes).toEqual([{
      channelAccountId: foundation.accountId, action: "released", batchId, shardId: shardIds[0],
      detail: { deadlineAt: new Date(now.getTime() + 90 * 60_000).toISOString() },
    }]);

    const shard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
    expect(shard.status).toBe("pending");
    expect(shard.params).toMatchObject({ releaseCount: 1, releasedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + 90 * 60_000).toISOString() });
    expect(readTaskControlMarker(shard.result)).toBeUndefined();

    const batch = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.params).toMatchObject({ firstReleasedAt: now.toISOString() });

    const audit = await owner.operationAudit.findFirstOrThrow({ where: { action: "promo_claim_shard.released", entityId: shardIds[0] } });
    expect(audit.actorType).toBe("system");
    expect(audit.afterSnapshot).toMatchObject({ batchId, releaseCount: 1 });

    // D6：同一账号只有一个 pending/processing 分片时，第二轮不放行任何新分片（这里也没有第二片，直接验证 no_eligible_shard）。
    const second = await runPromoClaimReleaseTick(scheduler, { now: new Date(now.getTime() + 60_000), env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(second).toEqual([{ channelAccountId: foundation.accountId, action: "admission_blocked" }]);
  });

  it("D6 准入：同一账号已有旧路径（非生命周期）领取任务处于 pending 时不放行；旧任务收尾后下一轮正常放行", async () => {
    const { shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-legacy");
    const legacyItemId = randomUUID();
    const legacyTaskId = randomUUID();
    await owner.genericTask.create({
      data: {
        id: legacyTaskId, taskType: PROMO_LINK_CLAIM_TASK_TYPE, channelAppId: foundation.channelAppId, channelAccountId: foundation.accountId,
        operationScopeHash: randomUUID().replaceAll("-", "").padEnd(64, "0"), requestToken: randomUUID(), status: "pending", totalCount: 1,
        items: { create: { id: legacyItemId, targetType: "novel_source_item", targetId: randomUUID(), status: "pending", payload: {} } },
      },
    });

    const now = new Date("2026-09-23T12:00:00.000Z");
    const blocked = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(blocked).toEqual([{ channelAccountId: foundation.accountId, action: "admission_blocked" }]);
    expect((await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } })).status).toBe("disabled");

    await owner.genericTask.update({ where: { id: legacyTaskId }, data: { status: "completed" } });
    const released = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(released[0]).toMatchObject({ action: "released", shardId: shardIds[0] });
  });

  it("回退开关：关闭时批次进入 lifecycle_disabled（分片不动、零条目写入）；重新开启后自动恢复并放行", async () => {
    const { batchId, shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-switch");
    const now = new Date("2026-09-23T12:00:00.000Z");
    const offEnv: NodeJS.ProcessEnv = { ...LIFECYCLE_ON_ENV, PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "false" };

    const off = await runPromoClaimReleaseTick(scheduler, { now, env: offEnv, logger: () => {} });
    expect(off).toEqual([{ channelAccountId: foundation.accountId, action: "lifecycle_disabled", detail: { heldBatchIds: [batchId] } }]);

    const batchHeld = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
    expect(batchHeld.status).toBe("disabled");
    expect(readTaskControlMarker(batchHeld.result)).toMatchObject({ kind: "system_hold", reasonCode: "lifecycle_disabled" });
    const shardUntouched = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
    expect(shardUntouched.status).toBe("disabled");
    expect(readTaskControlMarker(shardUntouched.result)).toMatchObject({ kind: "awaiting_release" });
    expect(await owner.genericTaskItem.count({ where: { taskId: shardIds[0], status: { not: "pending" } } })).toBe(0);

    const on = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(on[0]).toMatchObject({ action: "released", batchId, shardId: shardIds[0] });
    const batchRestored = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
    expect(batchRestored.status).not.toBe("disabled");
    expect(readTaskControlMarker(batchRestored.result)).toBeUndefined();
  });

  it("promo 功能双闸未开：不放行也不写任何系统暂停；双闸都打开后下一轮正常放行", async () => {
    const { shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-promo-flag");
    const now = new Date("2026-09-23T12:00:00.000Z");
    const offEnv: NodeJS.ProcessEnv = { ...LIFECYCLE_ON_ENV, FEATURE_PROMO_LINK_CLAIM: "false" };

    const off = await runPromoClaimReleaseTick(scheduler, { now, env: offEnv, logger: () => {} });
    expect(off).toEqual([{ channelAccountId: foundation.accountId, action: "promo_feature_disabled" }]);
    const untouched = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
    expect(untouched.status).toBe("disabled");
    expect(readTaskControlMarker(untouched.result)).toMatchObject({ kind: "awaiting_release" });

    const on = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(on[0]).toMatchObject({ action: "released", shardId: shardIds[0] });
  });

  it("D1 批准时钟：从未放行过的批次超过批准有效期后停在 approval_expired；首个分片放行后即使总执行超过有效期也不再要求重新批准", async () => {
    const shortTtlEnv: NodeJS.ProcessEnv = { ...LIFECYCLE_ON_ENV, PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES: "60" };
    const { batchId, shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-approval", shortTtlEnv);

    const approvedAt = (await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } })).params as { approvedAt: string };
    const wayPastApproval = new Date(new Date(approvedAt.approvedAt).getTime() + 2 * 60 * 60_000);

    const expired = await runPromoClaimReleaseTick(scheduler, { now: wayPastApproval, env: shortTtlEnv, logger: () => {} });
    expect(expired).toEqual([{ channelAccountId: foundation.accountId, action: "approval_expired", batchId, shardId: shardIds[0] }]);
    const batchHeld = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
    expect(batchHeld.status).toBe("disabled");
    expect(readTaskControlMarker(batchHeld.result)).toMatchObject({ kind: "system_hold", reasonCode: "approval_expired" });

    // 运营重新批准（本步范围外的界面/接口尚未实现——这里直接模拟其效果：清掉
    // 系统暂停、批次恢复正常，approvedAt/approvalValidUntil 保持不变）。
    await owner.genericTask.update({ where: { id: batchId }, data: { status: "pending", result: {} } });
    const releasedAt = new Date(approvedAt.approvedAt.replace(/\d{2}:\d{2}:\d{2}/, "01:00:00"));
    const firstRelease = await runPromoClaimReleaseTick(scheduler, { now: releasedAt, env: shortTtlEnv, logger: () => {} });
    expect(firstRelease[0]).toMatchObject({ action: "released", shardId: shardIds[0] });

    // 现在批次已经有 firstReleasedAt；即便再往后走远超批准有效期的时间，
    // 只要分片还在窗口内就不会被要求重新批准（这里直接断言批次没有再次
    // 被判 approval_expired——用同一个分片错过截止时间来触发下一轮判定）。
    const wayPastAgain = new Date(releasedAt.getTime() + 5 * 60 * 60_000 + 90 * 60_000 + 60_000);
    const missed = await runPromoClaimReleaseTick(scheduler, { now: wayPastAgain, env: shortTtlEnv, logger: () => {} });
    expect(missed[0]!.action).toBe("deadline_missed");
    expect(missed[0]!.action).not.toBe("approval_expired");
  });

  describe("D5 凭据三条件", () => {
    it("缺少有效凭据（无 active 行）→ credential_not_ready；补上就绪凭据后自动恢复并放行", async () => {
      const { batchId, shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-cred-missing");
      await markCredential(owner, foundation.credentialId, { status: "superseded" });
      const now = new Date("2026-09-23T12:00:00.000Z");

      const blocked = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(blocked).toEqual([{ channelAccountId: foundation.accountId, action: "credential_not_ready", batchId, shardId: shardIds[0], detail: { reasons: ["credential_missing"] } }]);
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("disabled");

      await markCredential(owner, foundation.credentialId, { status: "active" });
      const recovered = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(recovered[0]).toMatchObject({ action: "released", shardId: shardIds[0] });
    });

    it("凭据存在但从未校验（last_validated_at 为空）→ not_validated；校验后自动恢复", async () => {
      const { shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-cred-unvalidated");
      await markCredential(owner, foundation.credentialId, { lastValidatedAt: null });
      const now = new Date("2026-09-23T12:00:00.000Z");

      const blocked = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(blocked[0]).toMatchObject({ action: "credential_not_ready", detail: { reasons: ["not_validated"] } });

      await markCredential(owner, foundation.credentialId, { lastValidatedAt: new Date("2026-09-22T00:00:00.000Z") });
      const recovered = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(recovered[0]).toMatchObject({ action: "released", shardId: shardIds[0] });
    });

    it("剩余有效期不足一个窗口+安全余量 → expires_too_soon；续期后自动恢复", async () => {
      const { shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-cred-expiring");
      const now = new Date("2026-09-23T12:00:00.000Z");
      // 窗口 90 分钟 + 安全余量 30 分钟 = 120 分钟；这里只留 10 分钟。
      await markCredential(owner, foundation.credentialId, { expiresAt: new Date(now.getTime() + 10 * 60_000) });

      const blocked = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(blocked[0]).toMatchObject({ action: "credential_not_ready", detail: { reasons: ["expires_too_soon"] } });

      await markCredential(owner, foundation.credentialId, { expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60_000) });
      const recovered = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(recovered[0]).toMatchObject({ action: "released", shardId: shardIds[0] });
    });
  });

  describe("§5.6 处理中条目不判超时（Opus 复核 2026-09-23 补测）", () => {
    /**
     * 设计 §5.6 最后一句："处于 processing 的条目不受截止时间影响，正常
     * 收尾；只要该分片仍有 processing 条目就先跳过本轮"——
     * `releasePromoClaimShardsForAccount` 里 `if (counts.processing > 0)
     * continue;` 就是这一条的落地。这里用 2 本书的分片（覆盖默认的
     * shardSizeMax=1）验证：即使 deadlineAt 已过，只要还有一个条目在
     * processing，本轮既不能把分片判成 deadline_missed（不能增加
     * missedDeadlineCount、不能写系统暂停标记、不能动分片状态），也不能
     * 因为"看起来已经过期"就去动那个 pending 条目——分片仍然占着账号的
     * 准入名额，本轮只能是 admission_blocked。等 processing 条目真正收尾
     * （成功/失败）之后，下一轮才应该正常判定为 deadline_missed。
     */
    it("分片仍有 processing 条目时，即使已过 deadlineAt 也只是 admission_blocked——零改写；等该条目收尾后才判 deadline_missed", async () => {
      const twoPerShardEnv: NodeJS.ProcessEnv = { ...LIFECYCLE_ON_ENV, PROMO_CLAIM_SHARD_SIZE_MAX: "2" };
      const { shardIds } = await buildLifecycleShards(owner, foundation, 2, "release-processing-guard", twoPerShardEnv);
      expect(shardIds).toHaveLength(1); // 2 本书、shardSizeMax=2，落在同一片。

      const releasedAt = new Date("2026-09-23T09:00:00.000Z");
      const first = await runPromoClaimReleaseTick(scheduler, { now: releasedAt, env: twoPerShardEnv, logger: () => {} });
      expect(first[0]).toMatchObject({ action: "released", shardId: shardIds[0] });

      const items = await owner.genericTaskItem.findMany({ where: { taskId: shardIds[0] }, orderBy: { createdAt: "asc" } });
      expect(items).toHaveLength(2);
      const [processingItem, pendingItem] = items;
      // 模拟 worker 正持有其中一个条目的租约（尚未收尾）。
      await owner.genericTaskItem.update({
        where: { id: processingItem!.id },
        data: {
          status: "processing", attemptCount: 1, executionToken: randomUUID(), lockedBy: "opus-gap-fake-worker",
          lockedUntil: new Date(releasedAt.getTime() + 5 * 60_000), heartbeatAt: releasedAt, startedAt: releasedAt,
        },
      });
      const shardParamsBeforeGuard = (await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } })).params;

      const pastDeadline = new Date(releasedAt.getTime() + 91 * 60_000);
      const guarded = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline, env: twoPerShardEnv, logger: () => {} });
      expect(guarded).toEqual([{ channelAccountId: foundation.accountId, action: "admission_blocked" }]);

      const shardAfterGuard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(shardAfterGuard.status).toBe("pending"); // 未被判 deadline_missed、未被 disabled。
      expect(readTaskControlMarker(shardAfterGuard.result)).toBeUndefined(); // 没有写任何系统暂停标记。
      expect(shardAfterGuard.params).toEqual(shardParamsBeforeGuard); // missedDeadlineCount 等参数一个字节都没变。

      const itemsAfterGuard = await owner.genericTaskItem.findMany({ where: { taskId: shardIds[0] } });
      const stillProcessing = itemsAfterGuard.find((item) => item.id === processingItem!.id)!;
      const stillPending = itemsAfterGuard.find((item) => item.id === pendingItem!.id)!;
      expect(stillProcessing.status).toBe("processing");
      expect(stillProcessing.attemptCount).toBe(1); // 零改写——scheduler 完全没碰这个条目。
      expect(stillPending.status).toBe("pending");
      expect(stillPending.attemptCount).toBe(0);

      // processing 条目正常收尾（成功），另一个条目继续保持 pending。
      await owner.genericTaskItem.update({
        where: { id: processingItem!.id },
        data: { status: "success", executionToken: null, lockedBy: null, lockedUntil: null, heartbeatAt: null, finishedAt: pastDeadline },
      });

      const missedNow = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline, env: twoPerShardEnv, logger: () => {} });
      expect(missedNow[0]).toMatchObject({ action: "deadline_missed", shardId: shardIds[0], detail: { missedDeadlineCount: 1 } });
    });
  });

  describe("D4/§5.7 错过截止时间", () => {
    it("第 1 次错过：条目保持 pending、分片进 deadline_missed，零条目写成失败；满足 D4 前置条件后下一轮自动重新放行", async () => {
      const { shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-missed-once");
      const releasedAt = new Date("2026-09-23T09:00:00.000Z");
      const first = await runPromoClaimReleaseTick(scheduler, { now: releasedAt, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(first[0]).toMatchObject({ action: "released" });

      const pastDeadline = new Date(releasedAt.getTime() + 91 * 60_000);
      const missed = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(missed[0]).toMatchObject({ action: "deadline_missed", shardId: shardIds[0], detail: { missedDeadlineCount: 1 } });

      const shardHeld = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(shardHeld.status).toBe("disabled");
      expect(readTaskControlMarker(shardHeld.result)).toMatchObject({ kind: "system_hold", reasonCode: "deadline_missed" });
      expect(shardHeld.params).toMatchObject({ missedDeadlineCount: 1 });
      const items = await owner.genericTaskItem.findMany({ where: { taskId: shardIds[0] } });
      expect(items.every((item) => item.status === "pending" && item.attemptCount === 0)).toBe(true);

      const retry = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(retry[0]).toMatchObject({ action: "released", shardId: shardIds[0] });
      const shardReleasedAgain = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(shardReleasedAgain.params).toMatchObject({ releaseCount: 2, missedDeadlineCount: 1 });
    });

    it("D4 前置检查：pending 条目已存在意图记录时拒绝自动重新放行，转 deadline_missed_twice（reason=unsafe_to_auto_retry）", async () => {
      const { shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-missed-unsafe");
      const items = await owner.genericTaskItem.findMany({ where: { taskId: shardIds[0] } });
      const bookId = items[0]!.targetId;

      const releasedAt = new Date("2026-09-23T09:00:00.000Z");
      await runPromoClaimReleaseTick(scheduler, { now: releasedAt, env: LIFECYCLE_ON_ENV, logger: () => {} });

      // 模拟"曾经准备过 getcode 调用"：写一条 side_effect_intent，
      // request_summary.novelSourceItemId 指回这本书。
      await owner.$executeRaw(Prisma.sql`
        INSERT INTO side_effect_intent (
          id, effect_key, operation_type, idempotency_key, target_type, target_id,
          channel_account_id, status, request_summary
        ) VALUES (
          ${randomUUID()}::uuid, ${randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'promo_link.claim_promo',
          ${randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'promo_link', ${randomUUID()},
          ${foundation.accountId}::uuid, 'confirmed', ${JSON.stringify({ novelSourceItemId: bookId, offerType: "existing_promo" })}::jsonb
        )
      `);

      const pastDeadline = new Date(releasedAt.getTime() + 91 * 60_000);
      await runPromoClaimReleaseTick(scheduler, { now: pastDeadline, env: LIFECYCLE_ON_ENV, logger: () => {} }); // 第 1 次错过 -> deadline_missed
      const retry = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(retry[0]).toMatchObject({ action: "deadline_missed_twice", shardId: shardIds[0], detail: { reason: "unsafe_to_auto_retry" } });

      const shard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(shard.status).toBe("disabled");
      expect(readTaskControlMarker(shard.result)).toMatchObject({ reasonCode: "deadline_missed_twice" });
      // D4 拒绝重放的条目本身仍然 pending、零写入——只有分片被暂停。
      const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: shardIds[0] } });
      expect(item.status).toBe("pending");
      expect(item.attemptCount).toBe(0);
    });

    /**
     * Opus 复核（2026-09-23）补测：D4 前置检查的"从未尝试过"这一半条件是
     * `attempt_count = 0`，与"没有意图记录"是两个独立的判据（设计 §5.7 第 2
     * 条原文就是"必须都满足"）。上面那条用例只覆盖了"有意图记录、
     * attempt_count 仍是 0"；这里反过来覆盖"attempt_count != 0、但没有任何
     * 意图记录"——模拟"worker 曾经拿到过这个条目的租约（比如租约到期被
     * `recoverExpiredItem` 收回、退回 pending），但从未真正走到准备 getcode
     * 调用那一步"。这种条目同样不安全，不能自动重新放行。
     */
    it("D4 前置检查：pending 条目 attempt_count != 0（曾经被拿到过租约）但没有任何意图记录时，同样拒绝自动重新放行", async () => {
      const { shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-missed-attempted");
      const releasedAt = new Date("2026-09-23T09:00:00.000Z");
      const first = await runPromoClaimReleaseTick(scheduler, { now: releasedAt, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(first[0]).toMatchObject({ action: "released" });

      const pastDeadline = new Date(releasedAt.getTime() + 91 * 60_000);
      const miss1 = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(miss1[0]).toMatchObject({ action: "deadline_missed", detail: { missedDeadlineCount: 1 } });

      // 模拟"曾经被 worker 拿到过租约、后来又退回 pending"：attempt_count
      // 推到 1，条目仍是 pending，且这个账号名下没有任何 side_effect_intent。
      await owner.genericTaskItem.updateMany({ where: { taskId: shardIds[0] }, data: { attemptCount: 1 } });
      const intentCount = await owner.sideEffectIntent.count({ where: { channelAccountId: foundation.accountId } });
      expect(intentCount).toBe(0);

      const retry = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(retry[0]).toMatchObject({ action: "deadline_missed_twice", shardId: shardIds[0], detail: { reason: "unsafe_to_auto_retry" } });

      const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: shardIds[0] } });
      expect(item.status).toBe("pending");
      expect(item.attemptCount).toBe(1); // D4 只读不写——零改写。
      const shard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(shard.status).toBe("disabled");
      expect(readTaskControlMarker(shard.result)).toMatchObject({ reasonCode: "deadline_missed_twice" });
    });

    it("连续两次单纯超时（无意图记录）→ deadline_missed_twice；此后不再被 select-next 选中（需要人工处理）", async () => {
      const { shardIds } = await buildLifecycleShards(owner, foundation, 1, "release-missed-twice");
      const releasedAt = new Date("2026-09-23T09:00:00.000Z");
      await runPromoClaimReleaseTick(scheduler, { now: releasedAt, env: LIFECYCLE_ON_ENV, logger: () => {} });
      const pastDeadline1 = new Date(releasedAt.getTime() + 91 * 60_000);
      const miss1 = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline1, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(miss1[0]).toMatchObject({ action: "deadline_missed", detail: { missedDeadlineCount: 1 } });

      const retryRelease = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline1, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(retryRelease[0]).toMatchObject({ action: "released" });
      const pastDeadline2 = new Date(pastDeadline1.getTime() + 91 * 60_000);
      const miss2 = await runPromoClaimReleaseTick(scheduler, { now: pastDeadline2, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(miss2[0]).toMatchObject({ action: "deadline_missed_twice", detail: { missedDeadlineCount: 2 } });

      const shard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardIds[0] } });
      expect(readTaskControlMarker(shard.result)).toMatchObject({ reasonCode: "deadline_missed_twice" });

      // 再跑一轮：账号已经不再"占用"（分片是 disabled，不是 pending/processing），
      // 但 select-next 不认 deadline_missed_twice，找不到候选分片。
      const stuck = await runPromoClaimReleaseTick(scheduler, { now: new Date(pastDeadline2.getTime() + 60_000), env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(stuck).toEqual([{ channelAccountId: foundation.accountId, action: "no_eligible_shard" }]);
    });
  });

  describe("批次批准时刻先后：多批次时先放行更早批准的那个", () => {
    it("两个批次各一个分片，先提交的批次先被选中放行", async () => {
      const first = await buildLifecycleShards(owner, foundation, 1, "release-order-a");
      const second = await buildLifecycleShards(owner, foundation, 1, "release-order-b");
      const now = new Date("2026-09-23T12:00:00.000Z");
      const outcome = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(outcome).toEqual([{
        channelAccountId: foundation.accountId, action: "released", batchId: first.batchId, shardId: first.shardIds[0],
        detail: { deadlineAt: new Date(now.getTime() + 90 * 60_000).toISOString() },
      }]);
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: second.shardIds[0] } })).status).toBe("disabled");
    });
  });

  describe("真实 scheduler_app 角色权限验证（D7）", () => {
    it("scheduler_app 能完成一次完整放行；读取凭据密文列 / side_effect_intent 未授权列均被拒绝", async () => {
      await buildLifecycleShards(owner, foundation, 1, "release-role-check");
      const now = new Date("2026-09-23T12:00:00.000Z");
      const [{ current_user: currentUser }] = await scheduler.$queryRawUnsafe<Array<{ current_user: string }>>("SELECT current_user");
      expect(currentUser).toBe("scheduler_app");

      const outcome = await runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} });
      expect(outcome[0]).toMatchObject({ action: "released" });

      await expectDenied(() => scheduler.$queryRawUnsafe("SELECT encrypted_secret FROM channel_account_credential LIMIT 1"));
      await expectDenied(() => scheduler.$queryRawUnsafe("SELECT secret_fingerprint FROM channel_account_credential LIMIT 1"));
      await expectDenied(() => scheduler.$queryRawUnsafe("SELECT * FROM channel_account_credential LIMIT 1"));
      const readableCredentialColumns = await scheduler.$queryRawUnsafe<Array<{ status: string }>>(
        "SELECT id, channel_account_id, status, last_validated_at, expires_at, created_at FROM channel_account_credential LIMIT 1",
      );
      expect(readableCredentialColumns).toHaveLength(1);

      await expectDenied(() => scheduler.$queryRawUnsafe("SELECT target_id FROM side_effect_intent LIMIT 1"));
      await expectDenied(() => scheduler.$queryRawUnsafe("SELECT status FROM side_effect_intent LIMIT 1"));
      await expectDenied(() => scheduler.$queryRawUnsafe("SELECT * FROM side_effect_intent LIMIT 1"));

      await expectDenied(() => scheduler.$executeRawUnsafe("UPDATE channel_account_credential SET status = 'invalid'"));
      await expectDenied(() => scheduler.$executeRawUnsafe("DELETE FROM operation_audit"));
    });
  });

  describe("并发放行：同一账号 100 次并发触发，任意时刻至多一个分片处于 pending/processing", () => {
    it("100 次并发放行只有恰好一次成功，其余全部 admission_blocked", async () => {
      const shardCount = 3;
      const { shardIds } = await buildLifecycleShards(owner, foundation, shardCount, "release-concurrency");
      const now = new Date("2026-09-23T12:00:00.000Z");

      const attempts = 100;
      const results = await Promise.all(
        Array.from({ length: attempts }, () => runPromoClaimReleaseTick(scheduler, { now, env: LIFECYCLE_ON_ENV, logger: () => {} })),
      );
      const actions = results.map((r) => r[0]!.action);
      const releasedCount = actions.filter((a) => a === "released").length;
      const blockedCount = actions.filter((a) => a === "admission_blocked").length;
      expect(releasedCount).toBe(1);
      expect(blockedCount).toBe(attempts - 1);

      const liveShards = await owner.genericTask.findMany({ where: { id: { in: shardIds } } });
      const activeCount = liveShards.filter((s) => s.status === "pending" || s.status === "processing").length;
      expect(activeCount).toBe(1);
      expect(liveShards.filter((s) => s.status === "disabled")).toHaveLength(shardCount - 1);
    }, 60_000);
  });
});
