/**
 * B-38 第一段·真实库用例 2/3：每个写入点都用**真实角色**的连接走真实的服务函数 / 处理器，
 * 之后 `checkEffectiveTags` 必须全 0，并且预期的行确实变了。
 *
 *   角色        写入点（本文件里各一条用例）
 *   web_app     人工保存 / 退出人工 / 后台入口保存人工标签 / 改映射 / 分类启停 / 创建小说
 *   worker_app  自动打标写入 / 批量创建小说（真实 worker 周期）/ 目录同步每页（真实 worker 周期）/
 *               站点地图刷新前的兜底全量对账 / 运维命令
 *
 * 最后一条用例核对"每个会写 novel_effective_tag 的角色，至少真实执行过一个写入点，而不只是裸 SQL 授权探测"。
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import type { ListBooksResponse, MoboreaderBook, MoboreaderReadAdapter } from "@/lib/adapters";
import { rawLanguageScopeFromPayload } from "@/lib/tagging/raw-language-scope";
import { buildWorkerAllowlist, createMoboreaderCatalogScanTask } from "@/lib/tasks";
import { materializeNovelFromSourceItem } from "@/server/content-creation/service";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import type { AdminRegistry } from "@/server/auth/registry";
import {
  checkEffectiveTags,
  reconcileAllEffectiveTags,
} from "@/server/tagging/effective-tag-projection";
import {
  exitManualTagMode,
  mutateAdminCanonicalTag,
  mutateAdminNovelTags,
  mutateAdminSourceLabelMapping,
  replaceAutoTagSnapshot,
  replaceManualTagSnapshot,
} from "@/server/tagging";
import { createMoboreaderWorkerHandlers } from "../../../worker/handlers/moboreader";
import { createNovelMaterializeWorkerHandlers } from "../../../worker/handlers/novel-materialize";
import { createSitemapRefreshHandler } from "../../../worker/handlers/sitemap-refresh";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { runEffectiveTagOps } from "../../../scripts/ops/effective-tag-projection";
import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";
import {
  addSourceItem,
  assertIsolatedDatabase,
  connectRoles,
  createNovel,
  disconnectRoles,
  enabled,
  HASH,
  resetDatabase,
  SCOPE_EN,
  seedFoundation,
  type Foundation,
} from "./effective-tag-fixtures";

const roles = connectRoles();
const { owner, web, worker } = roles;

let f: Foundation;

// ───────────── 后台入口的鉴权夹具（照 tests/integration/tagging/p2-06-5-postgres.test.ts） ─────────────
const TAG_ADMIN_TOKEN = "b38-tag-admin-token";
const TAG_ADMIN_ORIGIN = "https://admin.example.test";
const TAG_ADMIN_NOW = new Date("2026-08-17T00:00:00.000Z");
const TAG_ADMIN_REGISTRY: AdminRegistry = {
  pageRoots: [],
  routes: [
    { id: "admin.api.canonical_tag.write", path: "/api/admin/canonical-tags", methods: ["PUT"], capability: "tag:manage" },
    { id: "admin.api.tag_mapping.write", path: "/api/admin/tag-mappings", methods: ["PUT"], capability: "tag:manage" },
    { id: "admin.api.novel_tag.write", path: "/api/admin/novels/tags", methods: ["PUT"], capability: "tag:manage" },
  ],
  actions: [],
};
const tagAdminEnv: NodeJS.ProcessEnv = {
  ...process.env,
  FEATURE_P2_06_5_TAGGING: "true",
  FEATURE_P2_06_5_TAG_ADMIN_WRITE: "true",
  FEATURE_NOVEL_TAG_AUTO: "false",
  AUTO_WRITE_AUTHORIZED: "NO",
};
const autoEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test", FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES",
};

async function adminAccess(entryId: string, routePath: string) {
  const requestId = randomUUID();
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: f.admin, username: "b38-admin", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true,
  };
  const issuedAt = new Date(TAG_ADMIN_NOW.getTime() - 60_000);
  const session: AdminSessionRecord = {
    id: randomUUID(), tokenHash: hashAdminSessionToken(TAG_ADMIN_TOKEN), identityId: identity.id, sessionVersion: 1,
    issuedAt, lastSeenAt: issuedAt, absoluteExpiresAt: new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: issuedAt, revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  const guarded = await requireAdminRouteAccess({
    pathname: routePath, method: "PUT", sessionToken: TAG_ADMIN_TOKEN, origin: TAG_ADMIN_ORIGIN,
    canonicalOrigin: TAG_ADMIN_ORIGIN, requestId,
  }, { identities: stores, sessions: stores, registry: TAG_ADMIN_REGISTRY, env: tagAdminEnv, now: TAG_ADMIN_NOW });
  expect(guarded.serviceAuthorization?.entryId).toBe(entryId);
  return {
    requestId,
    authorization: guarded.serviceAuthorization!,
    dependencies: { db: web, identities: stores, sessions: stores, env: tagAdminEnv, now: TAG_ADMIN_NOW },
  };
}

// ───────────── 角色覆盖登记 ─────────────
const coverage = new Map<string, Set<string>>();
async function role(db: PrismaClient): Promise<string> {
  const [row] = await db.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`;
  return row!.role;
}
async function covered(point: string, db: PrismaClient): Promise<void> {
  const name = await role(db);
  coverage.set(name, new Set([...(coverage.get(name) ?? []), point]));
}

// ───────────── 读取与断言 ─────────────
async function rowsOf(novelId: string): Promise<string[]> {
  const rows = await owner.$queryRaw<Array<{ slug: string; provenance: string; rank: number }>>`
    SELECT t.slug, e.provenance, e.rank
    FROM novel_effective_tag e JOIN canonical_tag t ON t.id = e.canonical_tag_id
    WHERE e.novel_id = ${novelId}::uuid ORDER BY e.rank
  `;
  expect(rows.map((row) => row.rank)).toEqual(rows.map((_, index) => index));
  return rows.map((row) => `${row.slug}:${row.provenance}`);
}

async function expectConsistent(db: PrismaClient = worker): Promise<void> {
  expect(await checkEffectiveTags(db)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });
}

/** 夹具由 owner 直接写真源（绕过写入点），所以每个用例开头先把表带到"应有"状态，再让写入点自己去改。 */
async function baseline(): Promise<void> {
  await reconcileAllEffectiveTags(owner);
  await expectConsistent();
}

const ROMANCE = { key: "A:series_type:romance" };
const MAPPED_ROMANCE = ["aaa-tie:mapped", "alpha:mapped", "beta:mapped"];

async function novelWithRomance(): Promise<string> {
  const novel = await createNovel(owner);
  await addSourceItem(owner, f, novel, { app: f.appActive, scope: SCOPE_EN, labels: [ROMANCE] });
  return novel;
}

const autoMetadata = {
  method: "deterministic_text" as const, taxonomyVersion: "v1", taxonomySha256: HASH, keywordLexiconVersion: "v1",
  keywordFingerprint: HASH, classifierConfigVersion: "v1", classifierConfigFingerprint: HASH, resultSummary: {},
};

describe.skipIf(!enabled).sequential("B-38 novel_effective_tag · 每个写入点（真实角色、同一事务、检查全 0）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    f = await seedFoundation(owner);
  }, 60_000);
  afterAll(async () => { await disconnectRoles(roles); });

  // ───────────────────────────── web_app ─────────────────────────────

  it("人工保存（web_app）：同事务重算——映射结果被人工快照替换；版本冲突时源与投影一起不变；写审计失败时整个事务（含投影）一起回滚", async () => {
    const novel = await novelWithRomance();
    await baseline();
    expect(await rowsOf(novel)).toEqual(MAPPED_ROMANCE);

    const result = await replaceManualTagSnapshot({
      db: web, novelId: novel, canonicalTagIds: [f.tags.delta!, f.tags.gamma!], expectedRevision: 0n,
      requestId: randomUUID(), actor: { id: f.admin, type: "admin" },
    });
    expect(result).toMatchObject({ mode: "manual", revision: 1n, replayed: false });
    expect(await rowsOf(novel)).toEqual(["gamma:manual", "delta:manual"]);
    await expectConsistent();

    // 版本冲突：源和投影一起不变
    await expect(replaceManualTagSnapshot({
      db: web, novelId: novel, canonicalTagIds: [f.tags.omega!], expectedRevision: 0n,
      requestId: randomUUID(), actor: { id: f.admin, type: "admin" },
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await rowsOf(novel)).toEqual(["gamma:manual", "delta:manual"]);

    // 幂等重放：同一个 requestId 不重复改
    const requestId = randomUUID();
    await replaceManualTagSnapshot({ db: web, novelId: novel, canonicalTagIds: [f.tags.theta!], expectedRevision: 1n, requestId, actor: { id: f.admin, type: "admin" } });
    expect(await rowsOf(novel)).toEqual(["theta:manual"]);
    const replay = await replaceManualTagSnapshot({ db: web, novelId: novel, canonicalTagIds: [f.tags.theta!], expectedRevision: 1n, requestId, actor: { id: f.admin, type: "admin" } });
    expect(replay.replayed).toBe(true);
    expect(await rowsOf(novel)).toEqual(["theta:manual"]);

    // 原子性：重算已经发生、随后写审计失败（actor_type 超过 varchar(32)）→ 人工快照、标签状态、投影一起回滚
    const before = await owner.novelTagState.findUniqueOrThrow({ where: { novelId: novel } });
    await expect(replaceManualTagSnapshot({
      db: web, novelId: novel, canonicalTagIds: [f.tags.omega!], expectedRevision: before.revision,
      requestId: randomUUID(), actor: { id: f.admin, type: "x".repeat(40) as never },
    })).rejects.toThrow();
    expect(await owner.novelTagState.findUniqueOrThrow({ where: { novelId: novel } })).toMatchObject({ revision: before.revision, mode: "manual" });
    expect((await owner.novelCanonicalTag.findMany({ where: { novelId: novel, source: "manual" } })).map((row) => row.canonicalTagId)).toEqual([f.tags.theta]);
    expect(await rowsOf(novel)).toEqual(["theta:manual"]);
    await expectConsistent();
    await covered("replaceManualTagSnapshot", web);
  }, 60_000);

  it("退出人工模式（web_app）：同事务重算——回到映射结果", async () => {
    const novel = await novelWithRomance();
    await replaceManualTagSnapshot({
      db: web, novelId: novel, canonicalTagIds: [f.tags.omega!], expectedRevision: 0n,
      requestId: randomUUID(), actor: { id: f.admin, type: "admin" },
    });
    expect(await rowsOf(novel)).toEqual(["omega:manual"]);
    await expectConsistent();

    const result = await exitManualTagMode({ db: web, novelId: novel, expectedRevision: 1n, requestId: randomUUID(), actor: { id: f.admin, type: "admin" } });
    expect(result).toMatchObject({ mode: "automatic", revision: 2n });
    expect(await rowsOf(novel)).toEqual(MAPPED_ROMANCE);
    await expectConsistent();
    await covered("exitManualTagMode", web);
  }, 60_000);

  it("后台入口保存人工标签 / 退出人工（mutateAdminNovelTags，web_app）：人工清空 = 没有任何分类", async () => {
    const novel = await novelWithRomance();
    await baseline();
    const save = await adminAccess("admin.api.novel_tag.write", "/api/admin/novels/tags");
    expect(await mutateAdminNovelTags({
      authorization: save.authorization, entryId: "admin.api.novel_tag.write",
      mutation: { action: "replace_manual", requestId: save.requestId, novelId: novel, expectedRevision: "0", canonicalTagIds: [] },
    }, save.dependencies)).toMatchObject({ mode: "manual", revision: "1" });
    expect(await rowsOf(novel)).toEqual([]);
    await expectConsistent();

    const exit = await adminAccess("admin.api.novel_tag.write", "/api/admin/novels/tags");
    await mutateAdminNovelTags({
      authorization: exit.authorization, entryId: "admin.api.novel_tag.write",
      mutation: { action: "exit_manual", requestId: exit.requestId, novelId: novel, expectedRevision: "1" },
    }, exit.dependencies);
    expect(await rowsOf(novel)).toEqual(MAPPED_ROMANCE);
    await expectConsistent();
    await covered("mutateAdminNovelTags", web);
  }, 60_000);

  it("改映射（mutateAdminSourceLabelMapping，web_app）：新增边 → 同事务全量对账，所有挂这个标签的书立刻有分类；改版不变；停用 → 立刻消失", async () => {
    const first = await createNovel(owner);
    const second = await createNovel(owner);
    for (const novel of [first, second]) {
      await addSourceItem(owner, f, novel, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:unmapped" }] });
    }
    await baseline();
    expect(await rowsOf(first)).toEqual([]);

    const approve = await adminAccess("admin.api.tag_mapping.write", "/api/admin/tag-mappings");
    const created = await mutateAdminSourceLabelMapping({
      authorization: approve.authorization, entryId: "admin.api.tag_mapping.write",
      mutation: {
        action: "approve_edge", requestId: approve.requestId, channelAppId: f.appActive, rawLanguageScope: SCOPE_EN,
        rawToken: "unmapped", canonicalTagId: f.tags.omega!, mappingVersion: "b38-v1", expectedUpdatedAt: null,
      },
    }, approve.dependencies);
    expect(created.replayed).toBe(false);
    expect(await rowsOf(first)).toEqual(["omega:mapped"]);
    expect(await rowsOf(second)).toEqual(["omega:mapped"]);
    await expectConsistent();

    // 已有边改版（approve_edge + 期望的 updatedAt）
    const bump = await adminAccess("admin.api.tag_mapping.write", "/api/admin/tag-mappings");
    const bumped = await mutateAdminSourceLabelMapping({
      authorization: bump.authorization, entryId: "admin.api.tag_mapping.write",
      mutation: {
        action: "approve_edge", requestId: bump.requestId, channelAppId: f.appActive, rawLanguageScope: SCOPE_EN,
        rawToken: "unmapped", canonicalTagId: f.tags.omega!, mappingVersion: "b38-v2", expectedUpdatedAt: created.updatedAt,
      },
    }, bump.dependencies);
    expect(await rowsOf(first)).toEqual(["omega:mapped"]);
    await expectConsistent();

    const deactivate = await adminAccess("admin.api.tag_mapping.write", "/api/admin/tag-mappings");
    await mutateAdminSourceLabelMapping({
      authorization: deactivate.authorization, entryId: "admin.api.tag_mapping.write",
      mutation: { action: "deactivate_edge", requestId: deactivate.requestId, mappingId: created.id, expectedUpdatedAt: bumped.updatedAt },
    }, deactivate.dependencies);
    expect(await rowsOf(first)).toEqual([]);
    expect(await rowsOf(second)).toEqual([]);
    await expectConsistent();
    await covered("mutateAdminSourceLabelMapping", web);
  }, 60_000);

  it("分类启用 / 停用（mutateAdminCanonicalTag set_status，web_app）：同事务全量对账，停用后其余分类 rank 重新连续；改译名不触发对账", async () => {
    const novel = await novelWithRomance();
    await baseline();
    expect(await rowsOf(novel)).toEqual(MAPPED_ROMANCE);

    const tag = await owner.canonicalTag.findUniqueOrThrow({ where: { id: f.tags.alpha! } });
    const off = await adminAccess("admin.api.canonical_tag.write", "/api/admin/canonical-tags");
    const disabled = await mutateAdminCanonicalTag({
      authorization: off.authorization, entryId: "admin.api.canonical_tag.write",
      mutation: { action: "set_status", requestId: off.requestId, canonicalTagId: f.tags.alpha!, expectedUpdatedAt: tag.updatedAt.toISOString(), status: "inactive" },
    }, off.dependencies);
    expect(await rowsOf(novel)).toEqual(["aaa-tie:mapped", "beta:mapped"]);
    await expectConsistent();

    // 改译名不触发对账：先人为删掉一行，改译名之后它依然缺着；再启用分类（触发对账）才补齐
    await owner.$executeRaw`DELETE FROM novel_effective_tag WHERE novel_id = ${novel}::uuid AND canonical_tag_id = ${f.tags.beta!}::uuid`;
    const rename = await adminAccess("admin.api.canonical_tag.write", "/api/admin/canonical-tags");
    const renamed = await mutateAdminCanonicalTag({
      authorization: rename.authorization, entryId: "admin.api.canonical_tag.write",
      mutation: {
        action: "replace_translations", requestId: rename.requestId, canonicalTagId: f.tags.alpha!,
        expectedUpdatedAt: disabled.updatedAt, translations: [{ locale: "en", displayName: "Alpha renamed" }],
      },
    }, rename.dependencies);
    expect(await rowsOf(novel)).toEqual(["aaa-tie:mapped"]);
    expect((await checkEffectiveTags(worker)).missing).toBe(1);

    const on = await adminAccess("admin.api.canonical_tag.write", "/api/admin/canonical-tags");
    await mutateAdminCanonicalTag({
      authorization: on.authorization, entryId: "admin.api.canonical_tag.write",
      mutation: { action: "set_status", requestId: on.requestId, canonicalTagId: f.tags.alpha!, expectedUpdatedAt: renamed.updatedAt, status: "active" },
    }, on.dependencies);
    expect(await rowsOf(novel)).toEqual(MAPPED_ROMANCE);
    await expectConsistent();
    await covered("mutateAdminCanonicalTag", web);
  }, 60_000);

  it("创建小说绑定上游书目（materializeNovelFromSourceItem，web_app）：新书立刻有映射分类", async () => {
    await baseline();
    const source = await owner.novelSourceItem.create({
      data: {
        channelAppId: f.appActive, externalBookId: randomUUID(), sourceLocale: "en", sourceLanguageCode: "en",
        rawLanguageScope: SCOPE_EN, title: "B38 web creation", description: "", status: "pending", rawPayload: {},
      },
    });
    await owner.novelSourceItemLabel.create({ data: { novelSourceItemId: source.id, sourceLabelId: f.labels.get("A:series_type:romance")! } });
    await baseline();

    const result = await materializeNovelFromSourceItem(web, {
      novelSourceItemId: source.id, mode: "apply", actor: { type: "admin", adminId: f.admin }, requestId: randomUUID(),
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("creation failed");
    expect(await rowsOf(result.novelId)).toEqual(MAPPED_ROMANCE);
    await expectConsistent();
    await covered("materializeNovelFromSourceItem", web);
  }, 60_000);

  // ───────────────────────────── worker_app ─────────────────────────────

  it("自动打标写入（replaceAutoTagSnapshot → replaceAutoTagSnapshotInTransaction，worker_app）：同事务重算——自动行排在映射段之后，重复分类记 mapped，人工模式下跳过", async () => {
    const novel = await novelWithRomance();
    await baseline();

    const first = await replaceAutoTagSnapshot({
      db: worker, novelId: novel, runMetadata: autoMetadata, contentSha: HASH, requestId: randomUUID(), env: autoEnv,
      tags: [
        { canonicalTagId: f.tags.omega!, score: 70, evidence: {} },
        { canonicalTagId: f.tags.theta!, score: 90, evidence: {} },
        { canonicalTagId: f.tags.beta!, score: 50, evidence: {} },
      ],
    });
    expect(first).toMatchObject({ mode: "automatic", skipped: false, replayed: false });
    expect(await rowsOf(novel)).toEqual([...MAPPED_ROMANCE, "theta:auto", "omega:auto"]);
    await expectConsistent();

    // 新一次自动打标成为"当前这次"：上一次的自动行被换掉
    const requestId = randomUUID();
    await replaceAutoTagSnapshot({
      db: worker, novelId: novel, runMetadata: autoMetadata, contentSha: HASH, requestId, env: autoEnv,
      tags: [{ canonicalTagId: f.tags.omega!, score: 10, evidence: {} }],
    });
    expect(await rowsOf(novel)).toEqual([...MAPPED_ROMANCE, "omega:auto"]);
    await expectConsistent();
    // 同一个 requestId 重放：投影不变
    const replay = await replaceAutoTagSnapshot({
      db: worker, novelId: novel, runMetadata: autoMetadata, contentSha: HASH, requestId, env: autoEnv,
      tags: [{ canonicalTagId: f.tags.omega!, score: 10, evidence: {} }],
    });
    expect(replay.replayed).toBe(true);
    expect(await rowsOf(novel)).toEqual([...MAPPED_ROMANCE, "omega:auto"]);

    // 人工模式：自动打标被跳过，投影仍是人工结果
    const manual = await createNovel(owner);
    await replaceManualTagSnapshot({ db: web, novelId: manual, canonicalTagIds: [f.tags.eta!], expectedRevision: 0n, requestId: randomUUID(), actor: { id: f.admin, type: "admin" } });
    const skipped = await replaceAutoTagSnapshot({
      db: worker, novelId: manual, runMetadata: autoMetadata, contentSha: HASH, requestId: randomUUID(), env: autoEnv,
      tags: [{ canonicalTagId: f.tags.omega!, score: 99, evidence: {} }],
    });
    expect(skipped).toMatchObject({ mode: "manual", skipped: true });
    expect(await rowsOf(manual)).toEqual(["eta:manual"]);
    await expectConsistent();
    await covered("replaceAutoTagSnapshot", worker);
  }, 60_000);

  it("批量创建小说（真实 worker 周期跑 novel.materialize.v1，worker_app）：新书立刻有映射分类", async () => {
    await baseline();
    const sources: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const source = await owner.novelSourceItem.create({
        data: {
          channelAppId: f.appActive, externalBookId: randomUUID(), sourceLocale: "en", sourceLanguageCode: "en",
          rawLanguageScope: SCOPE_EN, title: `B38 worker creation ${index}`, description: "", status: "pending", rawPayload: {},
        },
      });
      await owner.novelSourceItemLabel.create({ data: { novelSourceItemId: source.id, sourceLabelId: f.labels.get("A:series_type:romance")! } });
      sources.push(source.id);
    }
    await owner.genericTask.create({
      data: {
        taskType: "novel.materialize.v1", mode: "apply", status: "pending", operationScopeHash: randomUUID(),
        requestToken: randomUUID(), totalCount: sources.length,
        items: { create: sources.map((id) => ({ targetType: "novel_source_item", targetId: id, payload: { novelSourceItemId: id, channelAppId: f.appActive, actorId: f.admin, requestId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() } })) },
      },
    });
    const handlers = createNovelMaterializeWorkerHandlers(worker);
    const options = {
      prisma: worker, workerId: "b38-materialize", handlers, allowlist: buildWorkerAllowlist("novel.materialize.v1", handlers),
      signal: new AbortController().signal,
    };
    expect(await processOneWorkerCycle(options)).toBe(true);
    expect(await processOneWorkerCycle(options)).toBe(true);
    for (const id of sources) {
      const source = await owner.novelSourceItem.findUniqueOrThrow({ where: { id } });
      expect(source.status).toBe("linked");
      expect(await rowsOf(source.novelId!)).toEqual(MAPPED_ROMANCE);
    }
    await expectConsistent();
    await covered("novel.materialize.v1", worker);
  }, 60_000);

  it("目录同步每页（真实 worker 周期跑 catalog_scan，worker_app）：页里复活的软删除书目、新出现的标签，在本页事务里立刻进入归属；未绑定小说的书目不产生归属", async () => {
    // 目录同步用的渠道应用必须是 moboreader 剧场 + changdu 渠道 + 打开 getlistpc 能力 + 有账号凭证
    const channel = randomUUID(), sourceApp = randomUUID(), app = randomUUID(), account = randomUUID(), credential = randomUUID();
    await owner.channel.create({ data: { id: channel, code: "changdu", name: "Changdu" } });
    await owner.sourceApp.create({ data: { id: sourceApp, code: "moboreader", name: "MoboReader" } });
    await owner.channelApp.create({ data: { id: app, channelId: channel, sourceAppId: sourceApp, externalAppId: "moboreader", projectType: 1 } });
    await owner.channelCapability.createMany({
      data: ["getlistpc", "getbydataid", "getchapterinfo"].map((capabilityKey) => ({
        channelAppId: app, capabilityKey, status: "enabled", sideEffecting: false, evidenceLevel: "READ_ONLY_PRODUCTION_READ_PROVEN",
      })),
    });
    await owner.channelAccount.create({ data: { id: account, channelId: channel, businessId: "b38-account", accountName: "B38" } });
    await owner.channelAccountCredential.create({
      data: {
        id: credential, channelAccountId: account, keyVersion: 1, status: "active",
        encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker("test-jwt", account, credential, 1)),
        secretFingerprint: `hmac-sha256:v1:${"a".repeat(64)}`, fingerprintPrefix: "aaaaaaaaaaaa",
      },
    });

    const book = (id: string, seriesTypeList: string[]): MoboreaderBook => ({
      externalBookId: id, agencyId: "agency-1", agencyName: "Agency", seriesId: `series-${id}`, materialType: null,
      title: `Title ${id}`, description: "Description", coverUrl: null, projectType: 1, language: "2", languageName: "English",
      allEpis: 5, payEpisFrom: 4, splitRatio: 50, ttoSplitRatio: null, createTime: null, seriesTypeList, recommendList: [],
      labelSnapshotComplete: true, existingPromo: { upstreamCode: null, webUrl: null },
      rawEvidence: { id, agencyId: "agency-1", seriesId: `series-${id}`, projectType: 1, language: "2", languageName: "English", __boundary: "approved_raw_evidence" } as const,
    });
    const books = [book("book-revive", []), book("book-newlabel", ["Romance"]), book("book-unbound", ["Romance"])];
    const scope = rawLanguageScopeFromPayload(books[0]!.rawEvidence)!;
    expect(scope).toBeTruthy();

    // 映射：这个应用 + 这个语言范围下，"Romance" → alpha、beta
    await owner.sourceLabelMapping.createMany({
      data: ["alpha", "beta"].map((tag) => ({
        channelAppId: app, rawLanguageScope: scope, rawToken: "Romance", canonicalTagId: f.tags[tag]!,
        mappingVersion: "b38", approvedBy: f.admin, active: true,
      })),
    });
    const sourceItem = (externalBookId: string, novelId: string | null, extra: { deletedAt?: Date } = {}) => owner.novelSourceItem.create({
      data: {
        channelAppId: app, novelId, externalBookId, sourceLanguageCode: "2", sourceLanguageName: "English", sourceLocale: "en",
        rawLanguageScope: scope, title: "old", description: "", status: novelId ? "linked" : "pending", rawPayload: {}, ...extra,
      },
    });
    // 书 A：书目已被软删除、但有现成的 Romance 标签——页面再次出现这本书会撤销软删除（归属从无到有）
    const reviveNovel = await createNovel(owner);
    const reviveSource = await sourceItem("book-revive", reviveNovel, { deletedAt: new Date() });
    const romance = await owner.sourceLabel.create({ data: { channelAppId: app, labelKind: "series_type", externalLabelValue: "Romance" } });
    await owner.novelSourceItemLabel.create({ data: { novelSourceItemId: reviveSource.id, sourceLabelId: romance.id } });
    // 书 B：已绑定、暂时没有任何标签——页面带来新标签 Romance（归属从无到有）
    const labelNovel = await createNovel(owner);
    await sourceItem("book-newlabel", labelNovel);
    // 书 C：书目还没绑定小说——页面带来标签也不产生归属
    await sourceItem("book-unbound", null);

    await baseline();
    expect(await rowsOf(reviveNovel)).toEqual([]);
    expect(await rowsOf(labelNovel)).toEqual([]);

    const gates = {
      NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
      MOBOREADER_PREVIEW_SOURCE_APP_CODES: "moboreader",
    } satisfies NodeJS.ProcessEnv;
    const response: ListBooksResponse = {
      items: books, totalCount: 100, rawEvidence: { totalCount: 100, __boundary: "approved_raw_evidence" } as const,
    };
    const adapter: MoboreaderReadAdapter = {
      listBooks: async () => response,
      fetchBookMaterial: async () => { throw new Error("not used"); },
      fetchPreviewChapters: async () => { throw new Error("not used"); },
    };
    // 两页、每页 3 本、总数 100：第 1 页不是终态页（不会触发终态页的预读入队），只测每页重算
    const task = await createMoboreaderCatalogScanTask(owner, {
      channelAccountId: account, channelAppId: app, pageStart: 1, pageEnd: 2, pageSize: 3,
      requestToken: randomUUID(), actorId: "owner", requestId: randomUUID(), mode: "apply",
    }, gates);
    expect(task).toMatchObject({ status: "enqueued", taskStatus: "pending" });

    const handlers = createMoboreaderWorkerHandlers(worker, { adapter, env: gates });
    expect(await processOneWorkerCycle({
      prisma: worker, workerId: "b38-catalog", handlers, allowlist: buildWorkerAllowlist("catalog_scan", handlers),
      signal: new AbortController().signal, leaseMs: 30_000,
    })).toBe(true);

    const revived = await owner.novelSourceItem.findUniqueOrThrow({ where: { id: reviveSource.id } });
    expect(revived.deletedAt).toBeNull();
    expect(await rowsOf(reviveNovel)).toEqual(["alpha:mapped", "beta:mapped"]);
    expect(await rowsOf(labelNovel)).toEqual(["alpha:mapped", "beta:mapped"]);
    const unbound = await owner.novelSourceItem.findFirstOrThrow({ where: { channelAppId: app, externalBookId: "book-unbound" } });
    expect(unbound.novelId).toBeNull();
    await expectConsistent();
    await covered("catalog_scan", worker);
  }, 90_000);

  it("站点地图刷新前的兜底对账（真实 createSitemapRefreshHandler 默认对账，worker_app）：修好被篡改的行并记录 inserted/updated/deleted；稳定后再跑为 0/0/0；对账失败不中断站点地图构建", async () => {
    const novel = await novelWithRomance();
    await baseline();
    const bare = await createNovel(owner);
    // 篡改：缺一行、改一行、多一行
    await owner.$executeRaw`DELETE FROM novel_effective_tag WHERE novel_id = ${novel}::uuid AND canonical_tag_id = ${f.tags.beta!}::uuid`;
    await owner.$executeRaw`UPDATE novel_effective_tag SET rank = rank + 4 WHERE novel_id = ${novel}::uuid AND canonical_tag_id = ${f.tags.alpha!}::uuid`;
    await owner.$executeRaw`INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
      VALUES (${bare}::uuid, ${f.tags.omega!}::uuid, 'manual', NULL, 0)`;
    expect(await checkEffectiveTags(worker)).toMatchObject({ missing: 1, extra: 1, changed: 1 });

    const infos: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];
    const log = { info: (line: string) => infos.push(line), warn: (line: string) => warns.push(line), error: (line: string) => errors.push(line) };
    const success = { ok: true, status: "success", message: "ok", state: { task: { status: "success", runId: "r", manifest: { runId: "r", urlCount: 1 } }, active: null } };
    const buildHandler = (db: PrismaClient, extra: Record<string, unknown> = {}) => createSitemapRefreshHandler(db, {
      buildFamily: vi.fn(), refresh: vi.fn(async () => success) as never, reconcileLog: log as never,
      env: { ...process.env, FEATURE_SITEMAP_AUTO_REFRESH: "true", SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true" },
      ...extra,
    });
    const context = () => ({
      lease: {
        family: "generic" as const, taskType: "sitemap_refresh", mode: "apply" as const, itemId: randomUUID(), taskId: randomUUID(),
        workerId: "b38", executionToken: randomUUID(), leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(Date.now() + 60_000),
        payload: { reason: "b38", triggeredBy: "b38" },
      },
      mode: "apply" as const, signal: new AbortController().signal, heartbeat: vi.fn().mockResolvedValue(true),
    });

    expect((await buildHandler(worker)(context() as never)).status).toBe("success");
    expect(warns).toHaveLength(1);
    expect(JSON.parse(warns[0]!)).toMatchObject({ event: "effective_tag_reconcile", level: "warn", inserted: 1, updated: 1, deleted: 1 });
    expect(await rowsOf(novel)).toEqual(MAPPED_ROMANCE);
    expect(await rowsOf(bare)).toEqual([]);
    await expectConsistent();

    // 稳定后再跑：0/0/0
    await buildHandler(worker)(context() as never);
    expect(infos).toHaveLength(1);
    expect(JSON.parse(infos[0]!)).toMatchObject({ event: "effective_tag_reconcile", level: "info", inserted: 0, updated: 0, deleted: 0 });

    // 对账失败（连接已断开的 client）→ 只记错误日志，站点地图构建照常成功
    const dead = new PrismaClient({ datasourceUrl: "postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1" });
    try {
      const outcome = await buildHandler(dead)(context() as never);
      expect(outcome.status).toBe("success");
      expect(errors).toHaveLength(1);
      expect(JSON.parse(errors[0]!)).toMatchObject({ event: "effective_tag_reconcile_failed", level: "error" });
      expect(errors[0]).not.toMatch(/nothing|postgresql:/);
    } finally {
      await dead.$disconnect().catch(() => undefined);
    }
    await covered("sitemap_refresh", worker);
  }, 90_000);

  it("运维命令（worker 层，worker_app）：check 只读报差异并退出 3；reconcile 不带确认短语仍只读；带确认短语才修复，之后检查为 0 退出 0", async () => {
    const novel = await novelWithRomance();
    await baseline();
    await owner.$executeRaw`DELETE FROM novel_effective_tag WHERE novel_id = ${novel}::uuid AND canonical_tag_id = ${f.tags.alpha!}::uuid`;

    const check = await runEffectiveTagOps(worker, { mode: "check" });
    expect(check.exitCode).toBe(3);
    expect(check.lines[0]).toBe("EFFECTIVE_TAG_CHECK missing=1 extra=0 changed=0");

    const notConfirmed = await runEffectiveTagOps(worker, { mode: "reconcile", apply: false });
    expect(notConfirmed.exitCode).toBe(3);
    expect((await checkEffectiveTags(worker)).missing).toBe(1);

    const applied = await runEffectiveTagOps(worker, { mode: "reconcile", apply: true });
    expect(applied.exitCode).toBe(0);
    expect(applied.lines[0]).toMatch(/^EFFECTIVE_TAG_RECONCILE inserted=1 updated=0 deleted=0 ms=\d+$/);
    expect(applied.lines[1]).toBe("EFFECTIVE_TAG_CHECK missing=0 extra=0 changed=0");
    expect(await rowsOf(novel)).toEqual(MAPPED_ROMANCE);
    await covered("scripts/ops/effective-tag-projection.ts", worker);
  }, 60_000);

  // ───────────────────────────── 覆盖核对 ─────────────────────────────

  it("角色覆盖核对：每个会写 novel_effective_tag 的角色，都真实执行过各自的写入点（不是裸 SQL 授权探测）", () => {
    const web_app = coverage.get("web_app") ?? new Set<string>();
    const worker_app = coverage.get("worker_app") ?? new Set<string>();
    expect([...web_app].sort()).toEqual([
      "exitManualTagMode", "materializeNovelFromSourceItem", "mutateAdminCanonicalTag", "mutateAdminNovelTags",
      "mutateAdminSourceLabelMapping", "replaceManualTagSnapshot",
    ]);
    expect([...worker_app].sort()).toEqual([
      "catalog_scan", "novel.materialize.v1", "replaceAutoTagSnapshot", "scripts/ops/effective-tag-projection.ts", "sitemap_refresh",
    ]);
    expect([...coverage.keys()].sort()).toEqual(["web_app", "worker_app"]);
  });
});
