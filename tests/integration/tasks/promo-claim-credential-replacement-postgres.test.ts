/**
 * B-1 端到端验收：后台"替换凭据"之后，领推广生命周期批次必须能被 scheduler 自动恢复放行，
 * 不需要运营再手动点一次"校验"。
 *
 * 根因（v0.5.13 预生产实测）：`addOrReplaceCredential` 写新凭据行时，
 * `last_validated_at` 用的是应用侧在事务开始前取好的 `now`，`created_at` 却是数据库的
 * `transaction_timestamp()`，所以新行的 `last_validated_at` 必然比 `created_at` 早几毫秒；
 * 生命周期的凭据就绪判定（D5，`evaluateCredentialReadiness`）要求校验时刻不早于创建时刻，
 * 于是误报 `validated_before_creation`，批次一直停在 `system_hold: credential_not_ready`。
 * 修法：INSERT 里 `last_validated_at` 与 `created_at` 同取事务时刻。
 *
 * 为什么必须是真实库 + 真实角色，而不是单测里的假 tx：
 *   - 这个缺陷出在"应用时钟 vs 数据库事务时钟"的先后关系上，假 tx 里根本没有数据库时钟；
 *   - 现有 `promo-claim-release-postgres.test.ts` 的凭据用例全部由 owner 直接写一行
 *     `createdAt` 定在 2020 年的凭据，绕过了真实的替换写入路径，所以抓不到这个缺陷。
 *
 * 角色（与生产一致，不放宽任何权限）：
 *   - migration_owner：只用来造数据 / 事后断言；
 *   - web_app：调用真实的 `addOrReplaceCredential`（后台替换凭据的真实服务）；
 *   - scheduler_app：调用真实的 `runPromoClaimReleaseTick`（放行 / 暂停 / 自动恢复）；
 *   - worker_app：用例 4 里跑真实的 `credential.validate.v1` 处理器。
 *
 * 一次性库安全守卫：库名必须以 `cps_novel_promo_claim_release_` 开头且是 PostgreSQL 16.14。
 *
 * 运行方式：`bash scripts/run-promo-claim-release-postgres-verification.sh`
 * （该脚本与 `promo-claim-release-postgres.test.ts` 一起跑，并生成凭据加密钥匙与指纹钥匙文件，
 * 经 CHANNEL_CREDENTIAL_* 环境变量传给本文件；钥匙只在测试进程里，不进 scheduler 的 env 对象）。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizeCatalogSelection } from "@/domain/catalog-batch";
import { hashAdminSessionToken } from "@/lib/auth";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { CREDENTIAL_TASK_TYPES } from "@/lib/credentials/contracts";
import {
  CATALOG_BATCH_TASK_TYPE,
  buildWorkerAllowlist,
  claimPendingItem,
  enqueueCatalogBatch,
  finalizeTaskItem,
  readTaskControlMarker,
  runPromoClaimReleaseTick,
} from "@/lib/tasks";
import { PROMO_LINK_CLAIM_CAPABILITY_KEY } from "@/lib/tasks/promo-link-claim-limits";
import { requireAdminActionAccess } from "@/server/auth/guards";
import { P1_08B_ADMIN_REGISTRY, addOrReplaceCredential } from "@/server/credentials";
import { createCatalogBatchHandler } from "../../../worker/handlers/catalog-batch";
import { createCredentialWorkerHandlers } from "../../../worker/handlers/credential";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";
import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";

const enabled = process.env.PROMO_CLAIM_RELEASE_DATABASE_TEST === "1";
const requiredUrl = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};

const owner = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_RELEASE_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_RELEASE_WEB_DATABASE_URL") });
const worker = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_RELEASE_WORKER_DATABASE_URL") });
const scheduler = new PrismaClient({ datasourceUrl: requiredUrl("PROMO_CLAIM_RELEASE_SCHEDULER_DATABASE_URL") });

/** scheduler 的 env 对象：只有生命周期配置，故意不含任何凭据钥匙（scheduler 不碰密文）。 */
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
  channelId: string;
  sourceAppId: string;
  channelAppId: string;
  accountId: string;
  /** "剩余有效期不足"的旧 active 凭据。 */
  oldCredentialId: string;
}

async function assertDisposablePromoClaimReleaseDatabase(db: PrismaClient): Promise<void> {
  const [database] = await db.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version
  `;
  if (!database.name.startsWith("cps_novel_promo_claim_release_")) {
    throw new Error(`Refusing credential-replacement setup against ${database.name}`);
  }
  if (!database.version.startsWith("16.14")) {
    throw new Error(`PostgreSQL 16.14 required, got ${database.version}`);
  }
}

/** 角色真实性守卫：四个连接必须各自是生产里的那个最小权限角色，不是 owner。 */
async function assertRealRoles(): Promise<void> {
  const roleOf = async (db: PrismaClient) =>
    (await db.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`)[0]!.role;
  expect(await roleOf(owner)).toBe("migration_owner");
  expect(await roleOf(web)).toBe("web_app");
  expect(await roleOf(worker)).toBe("worker_app");
  expect(await roleOf(scheduler)).toBe("scheduler_app");
}

async function truncateDatabase(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

/** 测试用 JWT（alg:none，只需要三段式 + exp，同 p1-08b 的 `jwt(exp)`）。 */
function jwt(expEpochSeconds: number): string {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: expEpochSeconds, nonce: randomUUID() })).toString("base64url")}.signature`;
}

const epochSecondsFromNow = (offsetMs: number) => Math.floor((Date.now() + offsetMs) / 1000);

/**
 * 一个渠道 + 已启用 claimPromo 能力的渠道应用 + 渠道账号 + 一条"剩余有效期不足"的旧 active 凭据
 * （创建 2 小时前、1 小时前校验过、10 分钟后过期：窗口 90 分钟 + 安全余量 30 分钟 = 120 分钟，
 * 所以旧凭据单独就会让批次停在 credential_not_ready，原因只有 expires_too_soon）。
 */
async function seedFoundation(db: PrismaClient): Promise<Foundation> {
  const actorId = `pccr-pg-${randomUUID()}`;
  const channelId = randomUUID();
  const sourceAppId = randomUUID();
  const channelAppId = randomUUID();
  const accountId = randomUUID();
  const code = `pccr-${randomUUID()}`;
  await db.channel.create({ data: { id: channelId, code, name: "Promo Claim Credential Replacement PG" } });
  await db.sourceApp.create({ data: { id: sourceAppId, code: `${code}-source`, name: "Promo Claim Credential Replacement Source" } });
  await db.channelApp.create({ data: { id: channelAppId, channelId, sourceAppId, externalAppId: `${code}-app`, projectType: 1 } });
  await db.channelAccount.create({
    data: { id: accountId, channelId, businessId: `${code}-account`, accountName: "Promo Claim Credential Replacement Account", status: "active" },
  });
  await db.channelCapability.create({
    data: {
      channelAppId, capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY, status: "enabled",
      sideEffecting: true, evidenceLevel: "OWNER_APPROVED_WRITE_PROBE",
    },
  });
  const wallClock = Date.now();
  const old = await db.channelAccountCredential.create({
    data: {
      channelAccountId: accountId,
      encryptedSecret: Buffer.from(`pccr-old-secret-${randomUUID()}`),
      keyVersion: 1,
      secretFingerprint: randomBytes(16).toString("hex"),
      fingerprintPrefix: randomBytes(6).toString("hex"),
      status: "active",
      createdAt: new Date(wallClock - 2 * 60 * 60_000),
      lastValidatedAt: new Date(wallClock - 60 * 60_000),
      expiresAt: new Date(wallClock + 10 * 60_000),
    },
  });
  return { actorId, channelId, sourceAppId, channelAppId, accountId, oldCredentialId: old.id };
}

async function seedBooks(db: PrismaClient, channelAppId: string, count: number, prefix: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO novel_source_item (
      id, channel_app_id, external_book_id, source_language_code, source_locale,
      title, description, status, raw_payload, updated_at
    )
    SELECT gen_random_uuid(), ${channelAppId}::uuid, ${prefix} || '-' || n::text, 'en', 'en',
           ${prefix} || ' title ' || n::text, 'promo claim credential replacement fixture', 'pending',
           jsonb_build_object('fixture', ${prefix}), transaction_timestamp()
    FROM generate_series(1, ${count}) AS n
    RETURNING id
  `);
  const ids = rows.map((row) => row.id);
  for (const id of ids) {
    const novelId = randomUUID();
    const slug = `pccr-${randomUUID()}`;
    await db.$executeRaw(Prisma.sql`
      INSERT INTO novel (id, business_id, title, description, locale, slug, created_at, updated_at)
      VALUES (${novelId}::uuid, ${slug}, ${`${prefix} novel`}, 'promo claim credential replacement fixture', 'en', ${slug}, transaction_timestamp(), transaction_timestamp())
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

/** 提交一个只有 1 本书的生命周期批次并跑完枚举，返回批次 id 与唯一分片 id。 */
async function buildLifecycleShard(db: PrismaClient, foundation: Foundation, prefix: string): Promise<{ batchId: string; shardId: string }> {
  const bookIds = await seedBooks(db, foundation.channelAppId, 1, prefix);
  const enqueued = await enqueueCatalogBatch(db, {
    operation: "promo_claim",
    selection: normalizeCatalogSelection({ scope: "explicit_ids", ids: bookIds }),
    actorId: foundation.actorId,
    requestId: randomUUID(),
    channelAccounts: { [foundation.channelAppId]: foundation.accountId },
  }, new Date(), true, undefined, LIFECYCLE_ON_ENV);
  const lease = await claimPendingItem(db, {
    family: "generic", taskTypes: [CATALOG_BATCH_TASK_TYPE], workerId: "promo-claim-credential-replacement-pg", leaseMs: 60_000,
  });
  const outcome = await createCatalogBatchHandler(db, { env: LIFECYCLE_ON_ENV })(handlerContext(lease!));
  await finalizeTaskItem(db, lease!, outcome);
  const shards = await db.genericTask.findMany({ where: { parentTaskId: enqueued.taskId } });
  expect(shards).toHaveLength(1);
  return { batchId: enqueued.taskId, shardId: shards[0]!.id };
}

/** 后台"替换凭据"的真实入口：授权构造同 p1-08b 的 `ingressAuthorization`，数据库连接用 web_app。 */
async function replaceCredentialAsWebAdmin(foundation: Foundation, secret: string, reason = "B-1 end-to-end credential replacement") {
  const requestId = randomUUID();
  const now = new Date();
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: "pccr-web-admin",
    username: "pccr-web-admin",
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const token = `pccr-session-${requestId}`;
  const session: AdminSessionRecord = {
    id: randomUUID(),
    tokenHash: hashAdminSessionToken(token),
    identityId: identity.id,
    sessionVersion: 1,
    issuedAt: new Date(now.getTime() - 60_000),
    lastSeenAt: now,
    absoluteExpiresAt: new Date(now.getTime() + 3_600_000),
    twoFactorCompletedAt: now,
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  const guarded = await requireAdminActionAccess({
    actionId: "admin.credential.replace",
    sessionToken: token,
    origin: "https://admin.example.com",
    canonicalOrigin: "https://admin.example.com",
    requestId,
  }, { identities: stores, sessions: stores, registry: P1_08B_ADMIN_REGISTRY, now });
  // 不传 deps.now：用真实时钟，和生产一样。
  return addOrReplaceCredential({
    authorization: guarded.serviceAuthorization!,
    requestId,
    channelAccountId: foundation.accountId,
    secret,
    reason,
  }, { db: web, identities: stores, sessions: stores, env: process.env });
}

/** 用 owner 在库里比较，保留微秒精度（Prisma 的 Date 只到毫秒，会掩盖先后差）。 */
async function readCredentialTimes(credentialId: string) {
  const rows = await owner.$queryRaw<Array<{ status: string; same: boolean; not_before: boolean; validated_is_null: boolean }>>(Prisma.sql`
    SELECT status,
           last_validated_at = created_at AS same,
           last_validated_at >= created_at AS not_before,
           last_validated_at IS NULL AS validated_is_null
    FROM channel_account_credential WHERE id = ${credentialId}::uuid
  `);
  return rows[0]!;
}

async function expectBatchHeldForCredential(batchId: string, shardId: string): Promise<void> {
  const batch = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
  expect(batch.status).toBe("disabled");
  expect(readTaskControlMarker(batch.result)).toMatchObject({ kind: "system_hold", reasonCode: "credential_not_ready" });
  const shard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardId } });
  expect(shard.status).toBe("disabled");
  expect(readTaskControlMarker(shard.result)).toMatchObject({ kind: "awaiting_release" });
  expect(await owner.genericTaskItem.count({ where: { taskId: shardId, status: { not: "pending" } } })).toBe(0);
}

async function expectBatchReleased(batchId: string, shardId: string): Promise<void> {
  const shard = await owner.genericTask.findUniqueOrThrow({ where: { id: shardId } });
  expect(shard.status).toBe("pending");
  expect(shard.params).toMatchObject({ releaseCount: 1 });
  expect(readTaskControlMarker(shard.result)).toBeUndefined();
  const batch = await owner.genericTask.findUniqueOrThrow({ where: { id: batchId } });
  expect(batch.status).not.toBe("disabled");
  expect(readTaskControlMarker(batch.result)).toBeUndefined();
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!enabled).sequential("B-1 端到端：替换凭据后生命周期批次自动恢复 (real Postgres, real roles)", () => {
  let foundation: Foundation;

  beforeAll(async () => {
    await assertDisposablePromoClaimReleaseDatabase(owner);
    await assertRealRoles();
    if (
      !process.env.CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION
      || !process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE
      || !process.env.CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE
    ) {
      throw new Error("Disposable credential key files are required (CHANNEL_CREDENTIAL_*)");
    }
  }, 30_000);
  beforeEach(async () => {
    await truncateDatabase(owner);
    foundation = await seedFoundation(owner);
  });
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), scheduler.$disconnect()]);
  });

  it("核心：旧凭据剩余有效期不足→批次停在 credential_not_ready；web 真实替换为有效 JWT（不再点校验）→ 下一轮 scheduler 自动解除暂停并放行", async () => {
    const { batchId, shardId } = await buildLifecycleShard(owner, foundation, "b1-replace-ready");

    const blocked = await runPromoClaimReleaseTick(scheduler, { now: new Date(), env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(blocked).toEqual([{
      channelAccountId: foundation.accountId, action: "credential_not_ready", batchId, shardId,
      detail: { reasons: ["expires_too_soon"] },
    }]);
    await expectBatchHeldForCredential(batchId, shardId);

    // 真实替换：web_app 角色 + 真实服务，之后不做任何"校验"动作。
    const replaced = await replaceCredentialAsWebAdmin(foundation, jwt(epochSecondsFromNow(7 * 24 * 60 * 60_000)));
    expect(replaced.status).toBe("active");

    // 旧行：被替换成 superseded，库里只剩一条 active。
    expect((await readCredentialTimes(foundation.oldCredentialId)).status).toBe("superseded");
    expect(await owner.channelAccountCredential.count({ where: { channelAccountId: foundation.accountId, status: "active" } })).toBe(1);

    // scheduler 下一轮（真实时钟）：自动解除暂停并放行。这一步先于下面的时间戳断言，
    // 是为了让缺陷复发时先红在用户可见的症状上（detail.reasons 会直接写出
    // validated_before_creation），再由时间戳断言给出根因。
    const recovered = await runPromoClaimReleaseTick(scheduler, { now: new Date(), env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ channelAccountId: foundation.accountId, action: "released", batchId, shardId });
    await expectBatchReleased(batchId, shardId);

    // 新行：active，last_validated_at 与 created_at 同一事务时刻（微秒级相等，更不可能早于）。
    expect(await readCredentialTimes(replaced.credentialId))
      .toMatchObject({ status: "active", validated_is_null: false, not_before: true, same: true });
  });

  it("反向（不放过宽）：web 替换为已过期 JWT → 新行 expired、旧 active 被 supersede；scheduler 仍停在 credential_not_ready，分片不放行", async () => {
    const { batchId, shardId } = await buildLifecycleShard(owner, foundation, "b1-replace-expired");
    await runPromoClaimReleaseTick(scheduler, { now: new Date(), env: LIFECYCLE_ON_ENV, logger: () => {} });
    await expectBatchHeldForCredential(batchId, shardId);

    const replaced = await replaceCredentialAsWebAdmin(foundation, jwt(epochSecondsFromNow(-60 * 60_000)));
    expect(replaced.status).toBe("expired");
    expect((await readCredentialTimes(replaced.credentialId)).status).toBe("expired");
    expect((await readCredentialTimes(foundation.oldCredentialId)).status).toBe("superseded");
    expect(await owner.channelAccountCredential.count({ where: { channelAccountId: foundation.accountId, status: "active" } })).toBe(0);

    const still = await runPromoClaimReleaseTick(scheduler, { now: new Date(), env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(still).toEqual([{ channelAccountId: foundation.accountId, action: "no_eligible_shard" }]);
    await expectBatchHeldForCredential(batchId, shardId);
    // 从未被放行过：releaseCount 仍是建分片时写入的 0，也没有 releasedAt / deadlineAt。
    const shardParams = (await owner.genericTask.findUniqueOrThrow({ where: { id: shardId } })).params;
    expect(shardParams).toMatchObject({ releaseCount: 0 });
    expect(shardParams).not.toHaveProperty("releasedAt");
    expect(shardParams).not.toHaveProperty("deadlineAt");
  });

  it("反向（有效期照旧把关）：web 替换为仍然很快过期的 active JWT → 新行 last_validated_at = created_at 但仍因 expires_too_soon 不放行", async () => {
    const { batchId, shardId } = await buildLifecycleShard(owner, foundation, "b1-replace-short");
    await runPromoClaimReleaseTick(scheduler, { now: new Date(), env: LIFECYCLE_ON_ENV, logger: () => {} });
    await expectBatchHeldForCredential(batchId, shardId);

    const replaced = await replaceCredentialAsWebAdmin(foundation, jwt(epochSecondsFromNow(20 * 60_000)));
    expect(replaced.status).toBe("active");
    expect(await readCredentialTimes(replaced.credentialId)).toMatchObject({ status: "active", not_before: true, same: true });

    const still = await runPromoClaimReleaseTick(scheduler, { now: new Date(), env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(still).toEqual([{ channelAccountId: foundation.accountId, action: "no_eligible_shard" }]);
    await expectBatchHeldForCredential(batchId, shardId);
  });

  it("替换后再跑一次 worker_app 的 credential.validate.v1：校验成功、仍然 last_validated_at ≥ created_at，批次照常放行", async () => {
    const { batchId, shardId } = await buildLifecycleShard(owner, foundation, "b1-replace-then-validate");
    await runPromoClaimReleaseTick(scheduler, { now: new Date(), env: LIFECYCLE_ON_ENV, logger: () => {} });
    await expectBatchHeldForCredential(batchId, shardId);

    const replaced = await replaceCredentialAsWebAdmin(foundation, jwt(epochSecondsFromNow(7 * 24 * 60 * 60_000)));
    const created = await owner.channelAccountCredential.findUniqueOrThrow({ where: { id: replaced.credentialId } });
    // worker 的 `now` 是宿主机应用时钟，created_at 是数据库容器的事务时钟；生产里两者同机同时钟，
    // 一次性容器（尤其 Docker Desktop 虚拟机）可能有毫秒级偏差，这里等宿主机时钟走过 created_at
    // 再校验，保证测的是处理器本身而不是测试环境的时钟偏差（上限 5 秒）。
    for (let waited = 0; Date.now() <= created.createdAt.getTime() + 5 && waited < 5_000; waited += 10) await sleep(10);

    const mutationRequestId = randomUUID();
    const task = await owner.genericTask.create({
      data: {
        taskType: CREDENTIAL_TASK_TYPES.validate, channelAccountId: foundation.accountId,
        operationScopeHash: randomBytes(32).toString("hex"), requestToken: `pccr:${mutationRequestId}`, totalCount: 1,
        items: { create: [{ targetType: "credential", targetId: replaced.credentialId, payload: {
          channelAccountId: foundation.accountId, credentialId: replaced.credentialId,
          actorId: "pccr-admin", mutationRequestId, operation: "validate",
        } }] },
      },
      include: { items: true },
    });
    const handlers = createCredentialWorkerHandlers(worker);
    expect(await processOneWorkerCycle({
      prisma: worker, workerId: "pccr-worker", handlers,
      allowlist: buildWorkerAllowlist(`${CREDENTIAL_TASK_TYPES.validate},${CREDENTIAL_TASK_TYPES.supersede}`, handlers),
      signal: new AbortController().signal, leaseMs: 30_000,
    })).toBe(true);
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0]!.id } })).toMatchObject({
      status: "success", result: expect.objectContaining({ status: "active" }),
    });

    expect(await readCredentialTimes(replaced.credentialId)).toMatchObject({ status: "active", validated_is_null: false, not_before: true });

    const recovered = await runPromoClaimReleaseTick(scheduler, { now: new Date(), env: LIFECYCLE_ON_ENV, logger: () => {} });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ channelAccountId: foundation.accountId, action: "released", batchId, shardId });
    await expectBatchReleased(batchId, shardId);
  });
});
