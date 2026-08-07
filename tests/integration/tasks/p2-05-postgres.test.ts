import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MoboreaderReadAdapter } from "@/lib/adapters";
import { materializeChangduPreview } from "@/lib/preview";
import {
  buildWorkerAllowlist,
  createMoboreaderCatalogScanTask,
} from "@/lib/tasks";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { createMoboreaderWorkerHandlers } from "../../../worker/handlers/moboreader";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";

const enabled = process.env.P2_05_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.P2_05_OWNER_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.P2_05_WORKER_DATABASE_URL });

const ids = {
  channel: "25050000-0000-4000-8000-000000000001",
  sourceApp: "25050000-0000-4000-8000-000000000002",
  channelApp: "25050000-0000-4000-8000-000000000003",
  account: "25050000-0000-4000-8000-000000000004",
  credential: "25050000-0000-4000-8000-000000000005",
} as const;

const gates = {
  NODE_ENV: "test",
  FEATURE_NOVEL_CATALOG_SYNC: "true",
  NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
} satisfies NodeJS.ProcessEnv;

function page(bookId = "book-1") {
  return {
    items: [{
      externalBookId: bookId,
      agencyId: "agency-1",
      agencyName: "Agency",
      seriesId: `series-${bookId}`,
      title: `Title ${bookId}`,
      description: "Description",
      coverUrl: null,
      projectType: 1,
      language: "2",
      languageName: "English",
      allEpis: 5,
      payEpisFrom: 4,
      splitRatio: 50,
      ttoSplitRatio: null,
      createTime: null,
      seriesTypeList: ["raw-series-type"],
      recommendList: ["raw-recommend"],
      rawEvidence: { source_label: { future: "unknown" }, __boundary: "approved_raw_evidence" } as const,
    }],
    totalCount: 95_479,
    rawEvidence: { totalCount: 95_479, __boundary: "approved_raw_evidence" } as const,
  };
}

function adapter(bookId = "book-1"): MoboreaderReadAdapter {
  return {
    listBooks: async () => page(bookId),
    fetchBookMaterial: async () => { throw new Error("registered_disabled"); },
    fetchPreviewChapters: async () => { throw new Error("registered_disabled"); },
  };
}

async function truncateDatabase() {
  const tables = await owner.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

async function seedFoundation() {
  await owner.channel.create({ data: { id: ids.channel, code: "moboreader", name: "MoboReader" } });
  await owner.sourceApp.create({ data: { id: ids.sourceApp, code: "changdu", name: "Changdu" } });
  await owner.channelApp.create({
    data: { id: ids.channelApp, channelId: ids.channel, sourceAppId: ids.sourceApp, externalAppId: "moboreader", projectType: 1 },
  });
  await owner.channelCapability.create({
    data: {
      channelAppId: ids.channelApp,
      capabilityKey: "getlistpc",
      status: "enabled",
      sideEffecting: false,
      evidenceLevel: "READ_ONLY_PRODUCTION_READ_PROVEN",
    },
  });
  await owner.channelAccount.create({
    data: { id: ids.account, channelId: ids.channel, businessId: "p2-05-account", accountName: "P2-05" },
  });
  await owner.channelAccountCredential.create({
    data: {
      id: ids.credential,
      channelAccountId: ids.account,
      encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker("test-jwt", ids.account, ids.credential)),
      keyVersion: 1,
      secretFingerprint: `hmac-sha256:v1:${"a".repeat(64)}`,
      fingerprintPrefix: "aaaaaaaaaaaa",
      status: "active",
    },
  });
}

async function enqueue(mode: "dry_run" | "apply", requestToken: string = randomUUID()) {
  return createMoboreaderCatalogScanTask(owner, {
    channelAccountId: ids.account,
    channelAppId: ids.channelApp,
    pageStart: 1,
    pageEnd: 1,
    pageSize: 1,
    maxItems: 1,
    requestToken,
    actorId: "owner",
    requestId: randomUUID(),
    mode,
  }, gates);
}

async function consume(readAdapter = adapter()) {
  const handlers = createMoboreaderWorkerHandlers(worker, { adapter: readAdapter, env: gates });
  return processOneWorkerCycle({
    prisma: worker,
    workerId: "p2-05-worker",
    handlers,
    allowlist: buildWorkerAllowlist("catalog_scan", handlers),
    signal: new AbortController().signal,
    leaseMs: 30_000,
  });
}

function chapters(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    i: index + 1,
    chapterID: `chapter-${index + 1}`,
    chapterName: `Chapter ${index + 1}`,
    chapterShowName: null,
    chapterContent: `body-${index + 1}`,
  }));
}

describe.skipIf(!enabled).sequential("P2-05 PostgreSQL 16.14 write paths", () => {
  beforeAll(async () => {
    const [database] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
      SELECT current_database() AS name, current_setting('server_version') AS version
    `;
    if (!database.name.includes("p1_13")) throw new Error(`Refusing P2-05 tests against ${database.name}`);
    if (!database.version.startsWith("16.14")) throw new Error(`PostgreSQL 16.14 required, got ${database.version}`);
  });

  beforeEach(async () => {
    await truncateDatabase();
    await seedFoundation();
  });

  afterAll(async () => {
    await Promise.all([owner.$disconnect(), worker.$disconnect()]);
  });

  it("retains task/audit results while dry-run makes zero business writes", async () => {
    const created = await enqueue("dry_run");
    expect(created.status).toBe("enqueued");
    expect(await consume()).toBe(true);
    expect(await owner.novelSourceItem.count()).toBe(0);
    const task = await owner.catalogScanTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(task).toMatchObject({ status: "completed", successCount: 1 });
    expect(await owner.operationAudit.count({ where: { taskId: created.taskId } })).toBeGreaterThanOrEqual(2);
  });

  it("writes a checkpoint through worker_app and reruns idempotently", async () => {
    const first = await enqueue("apply");
    expect(await consume()).toBe(true);
    expect(await owner.novelSourceItem.count()).toBe(1);
    const task = await owner.catalogScanTask.findUniqueOrThrow({ where: { id: first.taskId } });
    expect(task.result).toMatchObject({ checkpoint: { lastCompletedPage: 1, returnedCount: 1 } });
    const duplicate = await createMoboreaderCatalogScanTask(owner, {
      channelAccountId: ids.account,
      channelAppId: ids.channelApp,
      pageStart: 1,
      pageEnd: 1,
      pageSize: 1,
      requestToken: "same-token",
      actorId: "owner",
      requestId: randomUUID(),
      mode: "apply",
    }, gates);
    expect(duplicate.status).toBe("enqueued");
    expect(await consume()).toBe(true);
    const rerun = await createMoboreaderCatalogScanTask(owner, {
      channelAccountId: ids.account,
      channelAppId: ids.channelApp,
      pageStart: 1,
      pageEnd: 1,
      pageSize: 1,
      requestToken: "same-token",
      actorId: "owner",
      requestId: randomUUID(),
      mode: "apply",
    }, gates);
    expect(rerun).toMatchObject({ status: "duplicate", taskId: duplicate.taskId });
    expect(await owner.novelSourceItem.count()).toBe(1);
    expect(await owner.sourceLabel.count()).toBe(4);
  });

  it("enforces active uniqueness before work is consumed", async () => {
    const first = await enqueue("apply", "first");
    const conflict = await enqueue("apply", "second");
    expect(first.status).toBe("enqueued");
    expect(conflict).toMatchObject({ status: "active_conflict", taskId: first.taskId });
  });

  it("resumes at the next pending page from a durable checkpoint", async () => {
    const created = await createMoboreaderCatalogScanTask(owner, {
      channelAccountId: ids.account,
      channelAppId: ids.channelApp,
      pageStart: 1,
      pageEnd: 2,
      pageSize: 1,
      maxItems: 2,
      requestToken: randomUUID(),
      actorId: "owner",
      requestId: randomUUID(),
      mode: "apply",
    }, gates);
    const paged: MoboreaderReadAdapter = {
      ...adapter(),
      listBooks: async (request) => page(`book-${request.pageIndex}`),
    };
    expect(await consume(paged)).toBe(true);
    expect(await owner.catalogScanTaskItem.count({ where: { taskId: created.taskId, status: "success" } })).toBe(1);
    expect(await owner.catalogScanTaskItem.count({ where: { taskId: created.taskId, status: "pending" } })).toBe(1);
    const completedPage = await owner.catalogScanTaskItem.findFirstOrThrow({
      where: { taskId: created.taskId, status: "success" },
      select: { pageIndex: true },
    });
    expect((await owner.catalogScanTask.findUniqueOrThrow({ where: { id: created.taskId } })).result)
      .toMatchObject({ checkpoint: { lastCompletedPage: completedPage.pageIndex } });
    expect(await consume(paged)).toBe(true);
    expect(await owner.novelSourceItem.count()).toBe(2);
    expect(await owner.catalogScanTask.findUniqueOrThrow({ where: { id: created.taskId } })).toMatchObject({
      status: "completed",
      successCount: 2,
      result: { checkpoint: { lastCompletedPage: 2 } },
    });
  });

  it("materializes 5 to policy 3, then 2 to 2 without hard deletion or side effects", async () => {
    await enqueue("apply");
    await consume();
    const source = await owner.novelSourceItem.findFirstOrThrow();
    const novel = await owner.novel.create({
      data: { businessId: "p2-05-novel", title: "Novel", description: "Description", locale: "en-US", slug: "p2-05-novel" },
    });
    await owner.novelSourceItem.update({ where: { id: source.id }, data: { novelId: novel.id, status: "linked" } });
    const sync = await owner.channelSyncTask.create({
      data: {
        taskType: "moboreader.preview_refresh.v1",
        channelAccountId: ids.account,
        channelAppId: ids.channelApp,
        operationScopeHash: "b".repeat(64),
        requestToken: randomUUID(),
        totalCount: 1,
        status: "disabled",
        items: { create: [{ novelSourceItemId: source.id, payload: { registeredDisabled: true } }] },
      },
      include: { items: true },
    });
    const common = {
      novelId: novel.id,
      novelSourceItemId: source.id,
      sourceFetchId: sync.items[0].id,
      actorId: "owner",
      requestId: randomUUID(),
      taskId: sync.id,
      trustedCompleteResponse: true,
    };
    const five = await materializeChangduPreview(worker, { ...common, chapterList: chapters(5), allEpis: 99, payEpisFrom: 4 });
    expect(five).toMatchObject({ materializedCount: 3, contentWrites: 3, staleCount: 0 });
    expect(await owner.novelChapter.count()).toBe(3);
    expect((await owner.novelSourceItem.findUniqueOrThrow({ where: { id: source.id } }))).toMatchObject({ totalChapterCount: 99, paidFromChapter: 4 });
    const unchanged = await materializeChangduPreview(worker, { ...common, chapterList: chapters(5), allEpis: 101, payEpisFrom: 8 });
    expect(unchanged.contentWrites).toBe(0);
    const two = await materializeChangduPreview(worker, { ...common, chapterList: chapters(2), allEpis: 101, payEpisFrom: 8 });
    expect(two).toMatchObject({ materializedCount: 2, staleCount: 1 });
    expect(await owner.novelChapterContent.count()).toBe(3);
    expect(await owner.novelChapter.count({ where: { status: "stale" } })).toBe(1);
    expect(await owner.indexNowOutbox.count()).toBe(0);
  });

  it("failed and empty refreshes retain old valid preview state", async () => {
    await enqueue("apply");
    await consume();
    const source = await owner.novelSourceItem.findFirstOrThrow();
    const novel = await owner.novel.create({ data: { businessId: "retained", title: "Retained", description: "D", locale: "en-US", slug: "retained" } });
    await owner.novelSourceItem.update({ where: { id: source.id }, data: { novelId: novel.id } });
    const before = await owner.novelChapter.create({ data: { novelId: novel.id, canonicalChapterNumber: 1, title: "Old", status: "preview" } });
    await owner.novelChapterContent.create({ data: { novelChapterId: before.id, body: "old", charCount: 3, contentHash: "c".repeat(64), materializedAt: new Date() } });
    const result = await materializeChangduPreview(worker, {
      novelId: novel.id,
      novelSourceItemId: source.id,
      sourceFetchId: randomUUID(),
      actorId: "owner",
      requestId: randomUUID(),
      taskId: randomUUID(),
      chapterList: [],
      trustedCompleteResponse: false,
    });
    expect(result.authoritative).toBe(false);
    expect(await owner.novelChapter.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ status: "preview" });
    expect((await owner.novelChapterContent.findUniqueOrThrow({ where: { novelChapterId: before.id } })).body).toBe("old");
  });
});
