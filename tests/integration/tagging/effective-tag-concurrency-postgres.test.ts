/**
 * B-38 第一段·真实库用例 3/3：并发。咨询锁 50212（重算共享 / 对账独占）、`novel` 行锁，
 * 以及"先咨询锁、后行锁"的锁顺序纪律。每条用例都是**两个以上真实连接交错**，用 `pg_locks` 证明
 * "谁在等谁"，最后断言投影与规则一致（`checkEffectiveTags` 全 0）且没有死锁。
 *
 * 为什么要有这些：全量对账与单本重算同时发生时，如果对账拿着旧快照去"修"一本刚被别人改好的书，
 * 就会把新结果改回旧值；两个事务同时重算同一本书同理；锁的先后顺序错了还会互相等待成死锁。
 * 每一条断言去掉对应的锁都会变红（变异证据见交付报告）。
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import type { AdminRegistry } from "@/server/auth/registry";
import { mutateAdminCanonicalTag, replaceManualTagSnapshot } from "@/server/tagging";
import {
  checkEffectiveTags,
  lockEffectiveTagProjectionShared,
  reconcileAllEffectiveTags,
  refreshEffectiveTagsForNovels,
} from "@/server/tagging/effective-tag-projection";
import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";
import {
  addSourceItem,
  assertIsolatedDatabase,
  connectRoles,
  createNovel,
  disconnectRoles,
  enabled,
  resetDatabase,
  SCOPE_EN,
  seedFoundation,
  type Foundation,
} from "./effective-tag-fixtures";

const roles = connectRoles();
const { owner, web, worker } = roles;
let f: Foundation;

type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 等到至少 `count` 个别的连接正在等锁（pg_locks 里 granted=false）。 */
async function waitForWaiters(count = 1, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await owner.$queryRaw<Array<{ n: number }>>`
      SELECT count(DISTINCT l.pid)::int AS n
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database() AND a.pid <> pg_backend_pid()
    `;
    if ((row?.n ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lock waiter(s)`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function advisoryWaiters(): Promise<number> {
  const [row] = await owner.$queryRaw<Array<{ n: number }>>`
    SELECT count(DISTINCT l.pid)::int AS n
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND l.locktype = 'advisory' AND a.datname = current_database() AND a.pid <> pg_backend_pid()
  `;
  return row?.n ?? 0;
}

async function isSettled(promise: Promise<unknown>, withinMs = 400): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, withinMs));
  return settled;
}

async function rowsOf(novelId: string): Promise<string[]> {
  const rows = await owner.$queryRaw<Array<{ slug: string; provenance: string }>>`
    SELECT t.slug, e.provenance
    FROM novel_effective_tag e JOIN canonical_tag t ON t.id = e.canonical_tag_id
    WHERE e.novel_id = ${novelId}::uuid ORDER BY e.rank
  `;
  return rows.map((row) => `${row.slug}:${row.provenance}`);
}

async function novelWithRomance(): Promise<string> {
  const novel = await createNovel(owner);
  await addSourceItem(owner, f, novel, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:romance" }] });
  return novel;
}

async function baseline(): Promise<void> {
  await reconcileAllEffectiveTags(owner);
  expect(await checkEffectiveTags(worker)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });
}

/** 模拟"后台改人工标签"的真源改动（不含重算）：切到人工模式并写一条人工标签。 */
async function writeManualSource(tx: Pick<PrismaClient, "novelTagState" | "novelCanonicalTag">, novelId: string, tagId: string) {
  await tx.novelTagState.upsert({ where: { novelId }, create: { novelId, mode: "manual", revision: 1n }, update: { mode: "manual", revision: 1n } });
  await tx.novelCanonicalTag.create({
    data: { novelId, canonicalTagId: tagId, source: "manual", decidedBy: f.admin, evidence: {}, evidenceSchemaVersion: 1 },
  });
}

const TX = { timeout: 60_000, maxWait: 15_000 } as const;

// 后台入口鉴权夹具（同 write-points 用例）
const TAG_ADMIN_TOKEN = "b38-concurrency-admin-token";
const TAG_ADMIN_ORIGIN = "https://admin.example.test";
const TAG_ADMIN_NOW = new Date("2026-08-17T00:00:00.000Z");
const TAG_ADMIN_REGISTRY: AdminRegistry = {
  pageRoots: [],
  routes: [{ id: "admin.api.canonical_tag.write", path: "/api/admin/canonical-tags", methods: ["PUT"], capability: "tag:manage" }],
  actions: [],
};
const tagAdminEnv: NodeJS.ProcessEnv = {
  ...process.env, FEATURE_P2_06_5_TAGGING: "true", FEATURE_P2_06_5_TAG_ADMIN_WRITE: "true", FEATURE_NOVEL_TAG_AUTO: "false", AUTO_WRITE_AUTHORIZED: "NO",
};
async function canonicalAdminAccess() {
  const requestId = randomUUID();
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = { id: f.admin, username: "b38-admin", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true };
  const issuedAt = new Date(TAG_ADMIN_NOW.getTime() - 60_000);
  const session: AdminSessionRecord = {
    id: randomUUID(), tokenHash: hashAdminSessionToken(TAG_ADMIN_TOKEN), identityId: identity.id, sessionVersion: 1,
    issuedAt, lastSeenAt: issuedAt, absoluteExpiresAt: new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: issuedAt, revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  const guarded = await requireAdminRouteAccess({
    pathname: "/api/admin/canonical-tags", method: "PUT", sessionToken: TAG_ADMIN_TOKEN, origin: TAG_ADMIN_ORIGIN,
    canonicalOrigin: TAG_ADMIN_ORIGIN, requestId,
  }, { identities: stores, sessions: stores, registry: TAG_ADMIN_REGISTRY, env: tagAdminEnv, now: TAG_ADMIN_NOW });
  return { requestId, authorization: guarded.serviceAuthorization!, dependencies: { db: web, identities: stores, sessions: stores, env: tagAdminEnv, now: TAG_ADMIN_NOW } };
}

describe.skipIf(!enabled).sequential("B-38 novel_effective_tag · 并发（咨询锁 50212 + 书行锁 + 锁顺序）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    f = await seedFoundation(owner);
  }, 60_000);
  afterAll(async () => { await disconnectRoles(roles); });

  it("对账不会把提交后的结果改回旧值：一个事务改某书人工标签（已重算、未提交），全量对账在另一个连接上交错——对账要等它提交，最后检查全 0", async () => {
    const novel = await novelWithRomance();
    await baseline();
    // 先让这本书的投影"有毛病"（beta 的 rank 被改错），这样旧快照上的对账会想去修它——
    // 而写入事务正要把同一行改成别的值。没有锁时对账会在写入事务提交后把它覆盖回旧值。
    await owner.$executeRaw`UPDATE novel_effective_tag SET rank = 7 WHERE novel_id = ${novel}::uuid AND canonical_tag_id = ${f.tags.beta!}::uuid`;

    const started = deferred();
    const release = deferred();
    const writer = web.$transaction(async (tx) => {
      await writeManualSource(tx, novel, f.tags.beta!);
      await refreshEffectiveTagsForNovels(tx, [novel]); // 只靠 refresh 自己拿共享锁，不额外手拿
      started.resolve();
      await release.promise;
    }, TX);
    await started.promise;

    let reconcileSettled = false;
    const reconcile = reconcileAllEffectiveTags(worker).finally(() => { reconcileSettled = true; });
    try {
      await waitForWaiters(1);
      expect(await advisoryWaiters()).toBe(1);
      expect(await isSettled(reconcile.catch(() => undefined), 300)).toBe(false);
      expect(reconcileSettled).toBe(false);
    } finally {
      release.resolve();
    }
    await writer;
    await reconcile;

    expect(await rowsOf(novel)).toEqual(["beta:manual"]);
    expect(await checkEffectiveTags(worker)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });
  }, 90_000);

  it("独占锁持有期间，真实的人工保存（replaceManualTagSnapshot）和单本重算都要等；对账提交后才继续，且都成功", async () => {
    const novel = await novelWithRomance();
    const other = await novelWithRomance();
    await baseline();

    const holding = deferred();
    const release = deferred();
    const reconciler = worker.$transaction(async (tx) => {
      await reconcileAllEffectiveTags(tx); // 独占咨询锁 + 全量对账，事务保持打开
      holding.resolve();
      await release.promise;
    }, TX);
    await holding.promise;

    const service = replaceManualTagSnapshot({
      db: web, novelId: novel, canonicalTagIds: [f.tags.gamma!], expectedRevision: 0n,
      requestId: randomUUID(), actor: { id: f.admin, type: "admin" },
    });
    const direct = web.$transaction((tx) => refreshEffectiveTagsForNovels(tx, [other]), TX);
    try {
      await waitForWaiters(2);
      expect(await advisoryWaiters()).toBe(2);
      expect(await isSettled(service.catch(() => undefined), 300)).toBe(false);
      expect(await isSettled(direct.catch(() => undefined), 50)).toBe(false);
    } finally {
      release.resolve();
    }
    await reconciler;
    expect(await service).toMatchObject({ mode: "manual", revision: 1n });
    expect(await direct).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(await rowsOf(novel)).toEqual(["gamma:manual"]);
    expect(await checkEffectiveTags(worker)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });
  }, 90_000);

  it("共享锁互相兼容：对不同书的两个单本重算可以同时进行，不互相等待", async () => {
    const left = await novelWithRomance();
    const right = await novelWithRomance();
    await baseline();
    const bothIn = deferred();
    let inside = 0;
    const hold = async (novel: string, db: PrismaClient) => db.$transaction(async (tx) => {
      await refreshEffectiveTagsForNovels(tx, [novel]);
      inside += 1;
      if (inside === 2) bothIn.resolve();
      await bothIn.promise; // 必须等到两个事务同时处于"持有共享锁"状态才继续——互相阻塞的话这里会超时
    }, TX);
    const run = Promise.all([hold(left, web), hold(right, worker)]);
    const outcome = await Promise.race([
      run.then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 8_000)),
    ]);
    expect(outcome).toBe("done");
  }, 30_000);

  it("两个事务同时重算同一本书：后者在书行锁上等前者提交，之后基于前者提交的结果重算，不会用旧快照覆盖", async () => {
    const novel = await novelWithRomance();
    await baseline();
    await owner.$executeRaw`UPDATE novel_effective_tag SET rank = 7 WHERE novel_id = ${novel}::uuid AND canonical_tag_id = ${f.tags.beta!}::uuid`;

    const started = deferred();
    const release = deferred();
    const first = web.$transaction(async (tx) => {
      await writeManualSource(tx, novel, f.tags.beta!);
      await refreshEffectiveTagsForNovels(tx, [novel]);
      started.resolve();
      await release.promise;
    }, TX);
    await started.promise;

    const second = worker.$transaction((tx) => refreshEffectiveTagsForNovels(tx, [novel]), TX);
    try {
      await waitForWaiters(1);
      // 它等的是书行锁（事务 id），不是咨询锁：共享锁彼此兼容
      expect(await advisoryWaiters()).toBe(0);
      expect(await isSettled(second.catch(() => undefined), 300)).toBe(false);
    } finally {
      release.resolve();
    }
    await first;
    expect(await second).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(await rowsOf(novel)).toEqual(["beta:manual"]);
    expect(await checkEffectiveTags(worker)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });
  }, 90_000);

  it("目录同步式重算遇上后台改标签（后台已持有书行 FOR UPDATE）：不死锁——先等书行锁，后台提交后再算", async () => {
    const novel = await novelWithRomance();
    await baseline();
    // 让重算必须"插入"一行：删掉 alpha 的投影行
    await owner.$executeRaw`DELETE FROM novel_effective_tag WHERE novel_id = ${novel}::uuid AND canonical_tag_id = ${f.tags.alpha!}::uuid`;

    const locked = deferred();
    const proceed = deferred();
    const admin = web.$transaction(async (tx) => {
      // 与 lockNovelAndState 同款：先锁书行
      await tx.$queryRaw`SELECT id FROM novel WHERE id = ${novel}::uuid FOR UPDATE`;
      await writeManualSource(tx, novel, f.tags.alpha!);
      locked.resolve();
      await proceed.promise;
      await refreshEffectiveTagsForNovels(tx, [novel]);
    }, TX);
    await locked.promise;

    const catalogLike = worker.$transaction((tx) => refreshEffectiveTagsForNovels(tx, [novel]), TX);
    try {
      await waitForWaiters(1);
      expect(await isSettled(catalogLike.catch(() => undefined), 300)).toBe(false);
    } finally {
      proceed.resolve();
    }
    // 两个事务都必须成功（任何一个报 deadlock detected 都是失败）
    await expect(admin).resolves.toBeUndefined();
    await expect(catalogLike).resolves.toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(await rowsOf(novel)).toEqual(["alpha:manual"]);
    expect(await checkEffectiveTags(worker)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });
  }, 90_000);

  it("锁顺序：分类停用（mutateAdminCanonicalTag set_status）遇上持有共享锁、正要给投影行做外键检查的重算——不死锁，重算先完成、停用随后生效", async () => {
    const novel = await novelWithRomance();
    await baseline();
    // 让重算必须"插入"引用 beta 的投影行（外键检查要 beta 行的 KEY SHARE，而 set_status 会对 beta 行 FOR UPDATE）
    await owner.$executeRaw`DELETE FROM novel_effective_tag WHERE novel_id = ${novel}::uuid AND canonical_tag_id = ${f.tags.beta!}::uuid`;

    const holdingShared = deferred();
    const go = deferred();
    const refresher = worker.$transaction(async (tx) => {
      await lockEffectiveTagProjectionShared(tx);
      holdingShared.resolve();
      await go.promise;
      return refreshEffectiveTagsForNovels(tx, [novel]);
    }, TX);
    await holdingShared.promise;

    const tag = await owner.canonicalTag.findUniqueOrThrow({ where: { id: f.tags.beta! } });
    const access = await canonicalAdminAccess();
    const disable = mutateAdminCanonicalTag({
      authorization: access.authorization, entryId: "admin.api.canonical_tag.write",
      mutation: { action: "set_status", requestId: access.requestId, canonicalTagId: f.tags.beta!, expectedUpdatedAt: tag.updatedAt.toISOString(), status: "inactive" },
    }, access.dependencies);
    try {
      // 停用事务在等独占咨询锁（修复后的顺序：还没碰 canonical_tag 行锁）
      const deadline = Date.now() + 15_000;
      while (await advisoryWaiters() < 1) {
        if (Date.now() > deadline) throw new Error("set_status never started waiting for the advisory lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      go.resolve();
    }
    // 重算先完成（它的插入需要 beta 行的 KEY SHARE，此刻没人持有 FOR UPDATE）；停用随后获得独占锁并生效
    await expect(refresher).resolves.toEqual({ inserted: 1, updated: 0, deleted: 0 });
    await expect(disable).resolves.toMatchObject({ id: f.tags.beta, replayed: false });
    expect(await rowsOf(novel)).toEqual(["aaa-tie:mapped", "alpha:mapped"]);
    expect(await checkEffectiveTags(worker)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });

    // 还原，免得影响别的用例
    const restoreTag = await owner.canonicalTag.findUniqueOrThrow({ where: { id: f.tags.beta! } });
    await owner.canonicalTag.update({ where: { id: f.tags.beta! }, data: { status: "active", updatedAt: restoreTag.updatedAt } });
    await reconcileAllEffectiveTags(owner);
  }, 90_000);
});
