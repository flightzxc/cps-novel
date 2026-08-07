import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getAdminChapterDetail,
  getAdminNovelDetail,
  listAdminNovelChapters,
  listAdminNovels,
  readAdminChapterContent,
} from "@/server/admin-content";

const enabled = process.env.P2_04_DATABASE_TEST === "1";

function requiredUrl(name: string): string | undefined {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
}

const owner = new PrismaClient({ datasourceUrl: requiredUrl("P2_04_OWNER_DATABASE_URL") });
const web = new PrismaClient({
  datasourceUrl: requiredUrl("P2_04_WEB_DATABASE_URL"),
  log: [{ emit: "event", level: "query" }],
});

let webQueryCount = 0;
web.$on("query", () => {
  webQueryCount += 1;
});

const ids = {
  channel: "24040000-0000-4000-8000-000000000001",
  sourceApp: "24040000-0000-4000-8000-000000000002",
  channelApp: "24040000-0000-4000-8000-000000000003",
  account: "24040000-0000-4000-8000-000000000004",
  credential: "24040000-0000-4000-8000-000000000005",
  novelA: "24040000-0000-4000-8000-000000000011",
  novelB: "24040000-0000-4000-8000-000000000012",
  novelC: "24040000-0000-4000-8000-000000000013",
  deletedNovel: "24040000-0000-4000-8000-000000000014",
  sourceItem: "24040000-0000-4000-8000-000000000021",
  chapterA1: "24040000-0000-4000-8000-000000000101",
  chapterA2: "24040000-0000-4000-8000-000000000102",
  chapterSource: "24040000-0000-4000-8000-000000000111",
  syncTask: "24040000-0000-4000-8000-000000000201",
  syncItem: "24040000-0000-4000-8000-000000000202",
} as const;

const sentinel = "P2_04_MUST_NEVER_ESCAPE_RAW_OR_SECRET";
const sharedUpdatedAt = new Date("2026-08-04T12:00:00.000Z");

async function truncateDatabase(): Promise<void> {
  const tables = await owner.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

async function seedDatabase(): Promise<void> {
  await owner.channel.create({
    data: { id: ids.channel, code: "p2-04-channel", name: "P2-04 Channel" },
  });
  await owner.sourceApp.create({
    data: { id: ids.sourceApp, code: "mobo-reader", name: "MoboReader" },
  });
  await owner.channelApp.create({
    data: {
      id: ids.channelApp,
      channelId: ids.channel,
      sourceAppId: ids.sourceApp,
      externalAppId: "p2-04-app",
      projectType: 2,
    },
  });
  await owner.channelAccount.create({
    data: {
      id: ids.account,
      channelId: ids.channel,
      businessId: "p2-04-account",
      accountName: "P2-04 Account",
    },
  });
  await owner.channelAccountCredential.create({
    data: {
      id: ids.credential,
      channelAccountId: ids.account,
      encryptedSecret: Buffer.from(sentinel),
      keyVersion: 1,
      secretFingerprint: "a".repeat(64),
      fingerprintPrefix: "aaaaaaaa",
      status: "invalid",
    },
  });

  await owner.novel.createMany({
    data: [
      {
        id: ids.novelA,
        businessId: "novel-alpha-identifier",
        title: "Alpha Story",
        description: "Operational metadata",
        locale: "en",
        slug: "alpha-story",
        author: "Author A",
        completionStatus: "ongoing",
        country: "US",
        region: "NA",
        totalChapterCount: 999,
        paidFromChapter: 3,
        splitRatio: "0.5000",
        status: "published",
        createdAt: sharedUpdatedAt,
        updatedAt: sharedUpdatedAt,
      },
      {
        id: ids.novelB,
        businessId: "novel-beta-identifier",
        title: "Beta Story",
        description: "Second novel",
        locale: "en",
        slug: "beta-story",
        totalChapterCount: 0,
        status: "ready",
        createdAt: sharedUpdatedAt,
        updatedAt: sharedUpdatedAt,
      },
      {
        id: ids.novelC,
        businessId: "novel-gamma-identifier",
        title: "Gamma Tale",
        description: "Japanese novel",
        locale: "fr",
        slug: "gamma-tale",
        totalChapterCount: 0,
        status: "draft",
        createdAt: new Date("2026-08-03T12:00:00.000Z"),
        updatedAt: new Date("2026-08-03T12:00:00.000Z"),
      },
      {
        id: ids.deletedNovel,
        businessId: "deleted-novel",
        title: "Deleted Story",
        description: "Must stay hidden",
        locale: "en",
        slug: "deleted-story",
        status: "published",
        deletedAt: new Date("2026-08-05T00:00:00.000Z"),
        createdAt: sharedUpdatedAt,
        updatedAt: sharedUpdatedAt,
      },
    ],
  });
  await owner.novelPreviewPolicy.create({
    data: {
      novelId: ids.novelA,
      materializedChapterCount: 1,
      displayAuthorized: true,
      indexAuthorized: false,
      cacheAuthorized: true,
      maxMaterializedChapters: 20,
      lastRefreshedAt: sharedUpdatedAt,
    },
  });
  await owner.novelChapter.createMany({
    data: [
      {
        id: ids.chapterA1,
        novelId: ids.novelA,
        canonicalChapterNumber: 1,
        title: "First Chapter",
        status: "preview",
        sourceUpdatedAt: sharedUpdatedAt,
        createdAt: sharedUpdatedAt,
        updatedAt: sharedUpdatedAt,
      },
      {
        id: ids.chapterA2,
        novelId: ids.novelA,
        canonicalChapterNumber: 2,
        title: "Second Chapter",
        status: "locked",
        sourceUpdatedAt: sharedUpdatedAt,
        createdAt: sharedUpdatedAt,
        updatedAt: sharedUpdatedAt,
      },
    ],
  });
  await owner.novelChapterContent.createMany({
    data: [
      {
        novelChapterId: ids.chapterA1,
        body: "First chapter body",
        charCount: 18,
        contentHash: "1".repeat(64),
        materializedAt: sharedUpdatedAt,
        createdAt: sharedUpdatedAt,
        updatedAt: sharedUpdatedAt,
      },
      {
        novelChapterId: ids.chapterA2,
        body: "Second chapter body",
        charCount: 19,
        contentHash: "2".repeat(64),
        materializedAt: sharedUpdatedAt,
        createdAt: sharedUpdatedAt,
        updatedAt: sharedUpdatedAt,
      },
    ],
  });
  await owner.novelSourceItem.create({
    data: {
      id: ids.sourceItem,
      channelAppId: ids.channelApp,
      novelId: ids.novelA,
      externalBookId: "external-alpha",
      sourceLanguageCode: "en",
      sourceLanguageName: "English",
      sourceLocale: "en-US",
      title: "Upstream Alpha",
      description: "Upstream description",
      totalChapterCount: 999,
      status: "stale",
      rawPayload: { credential: sentinel, sourceUrl: `https://invalid.test/${sentinel}` },
      sourceUpdatedAt: sharedUpdatedAt,
      lastSeenAt: sharedUpdatedAt,
      createdAt: sharedUpdatedAt,
      updatedAt: sharedUpdatedAt,
    },
  });
  await owner.novelChapterSourceItem.create({
    data: {
      id: ids.chapterSource,
      novelSourceItemId: ids.sourceItem,
      novelChapterId: ids.chapterA2,
      externalChapterId: "external-alpha-2",
      sourceChapterNumber: 2,
      chapterName: "Second Chapter",
      chapterShowName: "Chapter 2",
      status: "failed",
      rawPayload: { bearer: sentinel },
      lastSeenAt: sharedUpdatedAt,
      sourceUpdatedAt: sharedUpdatedAt,
      createdAt: sharedUpdatedAt,
      updatedAt: sharedUpdatedAt,
    },
  });
  await owner.channelSyncTask.create({
    data: {
      id: ids.syncTask,
      taskType: "p2_04.materialize",
      channelAccountId: ids.account,
      channelAppId: ids.channelApp,
      operationScopeHash: "b".repeat(64),
      mode: "apply",
      status: "failed",
      requestToken: "p2-04-sync-task",
      totalCount: 1,
      failedCount: 1,
      params: { hidden: sentinel },
      error: { message: sentinel },
      requestedAt: sharedUpdatedAt,
      startedAt: sharedUpdatedAt,
      completedAt: sharedUpdatedAt,
      createdAt: sharedUpdatedAt,
      updatedAt: sharedUpdatedAt,
    },
  });
  await owner.channelSyncTaskItem.create({
    data: {
      id: ids.syncItem,
      taskId: ids.syncTask,
      novelSourceItemId: ids.sourceItem,
      status: "failed",
      attemptCount: 2,
      payload: { token: sentinel },
      error: { detail: sentinel },
      startedAt: sharedUpdatedAt,
      finishedAt: sharedUpdatedAt,
      createdAt: sharedUpdatedAt,
      updatedAt: sharedUpdatedAt,
    },
  });
}

describe.skipIf(!enabled).sequential("P2-04 admin content PostgreSQL read kernel", () => {
  beforeAll(async () => {
    const [database] = await owner.$queryRawUnsafe<Array<{ name: string; version: string }>>(
      "SELECT current_database() AS name, current_setting('server_version') AS version",
    );
    if (!database.name.includes("p2_04")) {
      throw new Error(`Refusing P2-04 setup against ${database.name}`);
    }
    if (!database.version.startsWith("16.")) {
      throw new Error(`PostgreSQL 16 required, got ${database.version}`);
    }
  });

  beforeEach(async () => {
    await truncateDatabase();
    await seedDatabase();
    webQueryCount = 0;
  });

  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect()]);
  });

  it("returns a bounded, stable, filtered page with exactly two queries", async () => {
    const first = await listAdminNovels(web, { page: 1, pageSize: 1 });
    expect(first).toMatchObject({ page: 1, pageSize: 1, total: 3, totalPages: 3 });
    expect(first.items.map(({ id }) => id)).toEqual([ids.novelB]);
    expect(webQueryCount).toBe(2);

    const second = await listAdminNovels(web, { page: 2, pageSize: 1 });
    expect(second.items.map(({ id }) => id)).toEqual([ids.novelA]);
    const beyond = await listAdminNovels(web, { page: 99, pageSize: 1 });
    expect(beyond).toMatchObject({ items: [], total: 3, totalPages: 3 });

    expect((await listAdminNovels(web, { status: "published" })).items.map(({ id }) => id))
      .toEqual([ids.novelA]);
    expect((await listAdminNovels(web, { locale: "en" })).items.map(({ id }) => id))
      .toEqual([ids.novelB, ids.novelA]);
    expect((await listAdminNovels(web, { search: "ALPHA STORY" })).items).toHaveLength(1);
    expect((await listAdminNovels(web, { search: "beta-identifier" })).items).toHaveLength(1);
    expect((await listAdminNovels(web, { search: "gamma-tale" })).items).toHaveLength(1);
    expect((await listAdminNovels(web, { search: ids.novelA })).items).toHaveLength(1);
    expect((await listAdminNovels(web, { search: "no-result" }))).toMatchObject({ items: [], total: 0 });
  });

  it("uses real content rows for preview counts and exposes only stable exception codes", async () => {
    const detail = await getAdminNovelDetail(web, ids.novelA);
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      id: ids.novelA,
      totalChapterCount: 999,
      actualChapterRowCount: 2,
      preview: {
        actualMaterializedChapterCount: 2,
        actualDisplayableChapterCount: 1,
        policyCountMatchesActual: false,
        policy: { materializedChapterCount: 1, maxMaterializedChapters: 20 },
      },
      sync: {
        sourceItemCount: 1,
        sourceAppCodes: ["mobo-reader"],
        exceptions: [
          "source_item_stale",
          "chapter_materialization_failed",
          "sync_item_failed",
          "sync_task_failed",
          "preview_count_mismatch",
        ],
      },
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("rawPayload");
    expect(serialized).not.toContain("encryptedSecret");
    expect(serialized).not.toContain("chapter body");
    expect(await getAdminNovelDetail(web, "24040000-0000-4000-8000-000000009999")).toBeNull();
  });

  it("lists only persisted chapters in canonical order and reports content presence", async () => {
    const chapters = await listAdminNovelChapters(web, {
      novelId: ids.novelA,
      page: 1,
      pageSize: 100,
    });
    expect(chapters.total).toBe(2);
    expect(chapters.items.map(({ canonicalChapterNumber }) => canonicalChapterNumber)).toEqual([1, 2]);
    expect(chapters.items.every(({ hasContent }) => hasContent)).toBe(true);
    expect(chapters.items).toHaveLength(2);
    expect(JSON.stringify(chapters)).not.toContain("chapter body");

    const filtered = await listAdminNovelChapters(web, {
      novelId: ids.novelA,
      status: "locked",
    });
    expect(filtered.items.map(({ id }) => id)).toEqual([ids.chapterA2]);
  });

  it("keeps chapter metadata separate from body and audits successful body reads", async () => {
    const detail = await getAdminChapterDetail(web, ids.novelA, ids.chapterA1);
    expect(detail).toMatchObject({
      id: ids.chapterA1,
      novelId: ids.novelA,
      canonicalChapterNumber: 1,
      hasContent: true,
      charCount: 18,
    });
    expect(JSON.stringify(detail)).not.toContain("First chapter body");
    expect(await getAdminChapterDetail(web, ids.novelA, "24040000-0000-4000-8000-000000009999"))
      .toBeNull();

    const content = await readAdminChapterContent(web, {
      novelId: ids.novelA,
      chapterId: ids.chapterA1,
      context: { actorId: "admin-p2-04", requestId: "request-p2-04" },
    });
    expect(content).toMatchObject({
      chapterId: ids.chapterA1,
      novelId: ids.novelA,
      body: "First chapter body",
      charCount: 18,
      contentHash: "1".repeat(64),
    });
    const audit = await owner.operationAudit.findFirstOrThrow({
      where: { action: "admin.chapter_content.read", entityId: ids.chapterA1 },
    });
    expect(audit).toMatchObject({
      actorType: "admin",
      actorId: "admin-p2-04",
      entityType: "novel_chapter",
      requestId: "request-p2-04",
      beforeSnapshot: null,
      afterSnapshot: null,
      reason: null,
    });
    expect(JSON.stringify({ ...audit, id: audit.id.toString() })).not.toContain("First chapter body");
  });
});
