import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMoboreaderReadAdapter,
  type ListBooksResponse,
  type MoboreaderBook,
  type MoboreaderReadAdapter,
} from "@/lib/adapters";
import { materializeChangduPreview } from "@/lib/preview";
import {
  buildWorkerAllowlist,
  createMoboreaderCatalogScanTask,
  createMoboreaderPreviewRefreshTask,
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
  MOBOREADER_PREVIEW_SOURCE_APP_CODES: "changdu",
} satisfies NodeJS.ProcessEnv;

function page(
  bookId = "book-1",
  overrides: Partial<MoboreaderBook> = {},
  totalCount = 95_479,
): ListBooksResponse {
  return {
    items: [{
      externalBookId: bookId,
      agencyId: "agency-1",
      agencyName: "Agency",
      seriesId: `series-${bookId}`,
      materialType: null,
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
      labelSnapshotComplete: true,
      rawEvidence: {
        id: bookId,
        agencyId: "agency-1",
        seriesId: `series-${bookId}`,
        projectType: 1,
        language: "2",
        source_label: { future: "unknown" },
        __boundary: "approved_raw_evidence",
      } as const,
      ...overrides,
    }],
    totalCount,
    rawEvidence: { totalCount, __boundary: "approved_raw_evidence" } as const,
  };
}

function adapter(bookId = "book-1"): MoboreaderReadAdapter {
  return {
    listBooks: async () => page(bookId),
    fetchBookMaterial: async () => ({
      dataId: null,
      seriesId: `series-${bookId}`,
      materialType: null,
      materialStatus: null,
      statusText: null,
      rawEvidence: { list: [], __boundary: "approved_raw_evidence" },
    }),
    fetchPreviewChapters: async () => ({
      bookId: `series-${bookId}`,
      currentLanguage: "2",
      chapterList: chapters(3),
    }),
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
  await owner.channelCapability.createMany({
    data: ["getbydataid", "getchapterinfo"].map((capabilityKey) => ({
      channelAppId: ids.channelApp,
      capabilityKey,
      status: "enabled",
      sideEffecting: false,
      evidenceLevel: "READ_ONLY_PRODUCTION_READ_PROVEN",
    })),
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

async function enqueue(
  mode: "dry_run" | "apply",
  requestToken: string = randomUUID(),
  env: NodeJS.ProcessEnv = gates,
) {
  return createMoboreaderCatalogScanTask(owner, {
    channelAccountId: ids.account,
    channelAppId: ids.channelApp,
    pageStart: 1,
    pageEnd: 1,
    pageSize: 1,
    requestToken,
    actorId: "owner",
    requestId: randomUUID(),
    mode,
  }, env);
}

async function enqueueRange(input: {
  pageEnd: number;
  pageSize: number;
  env?: NodeJS.ProcessEnv;
}) {
  return createMoboreaderCatalogScanTask(owner, {
    channelAccountId: ids.account,
    channelAppId: ids.channelApp,
    pageStart: 1,
    pageEnd: input.pageEnd,
    pageSize: input.pageSize,
    requestToken: randomUUID(),
    actorId: "owner",
    requestId: randomUUID(),
    mode: "apply",
  }, input.env ?? gates);
}

async function consume(
  readAdapter = adapter(),
  env: NodeJS.ProcessEnv = gates,
  now?: () => Date,
) {
  const handlers = createMoboreaderWorkerHandlers(worker, { adapter: readAdapter, env, now });
  return processOneWorkerCycle({
    prisma: worker,
    workerId: "p2-05-worker",
    handlers,
    allowlist: buildWorkerAllowlist("catalog_scan", handlers),
    signal: new AbortController().signal,
    leaseMs: 30_000,
  });
}

async function consumePreview(readAdapter = adapter(), env: NodeJS.ProcessEnv = gates) {
  const handlers = createMoboreaderWorkerHandlers(worker, { adapter: readAdapter, env });
  return processOneWorkerCycle({
    prisma: worker,
    workerId: "p2-05-preview-worker",
    handlers,
    allowlist: buildWorkerAllowlist("moboreader.preview_refresh.v1", handlers),
    signal: new AbortController().signal,
    leaseMs: 30_000,
  });
}

async function seedLinkedSource(bookId: string, businessId: string) {
  const novel = await owner.novel.create({
    data: { businessId, title: `Novel ${bookId}`, description: "Description", locale: "en-US", slug: businessId },
  });
  const source = await owner.novelSourceItem.create({
    data: {
      channelAppId: ids.channelApp,
      novelId: novel.id,
      externalBookId: bookId,
      sourceLanguageCode: "2",
      sourceLanguageName: "English",
      title: `Old ${bookId}`,
      description: "Old",
      totalChapterCount: 1,
      paidFromChapter: 1,
      status: "linked",
      rawPayload: { seeded: true },
    },
  });
  return { novel, source };
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
    const dryRunOnly = {
      NODE_ENV: "test",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false",
      MOBOREADER_PREVIEW_SOURCE_APP_CODES: "changdu",
    } satisfies NodeJS.ProcessEnv;
    const created = await enqueue("dry_run", randomUUID(), dryRunOnly);
    expect(created.status).toBe("enqueued");
    expect(await consume(adapter(), dryRunOnly)).toBe(true);
    expect(await owner.novelSourceItem.count()).toBe(0);
    expect(await owner.channelSyncTask.count()).toBe(0);
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
    expect(task.result).toMatchObject({ stopReason: "expected_total_reached", terminalState: "completed" });
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

  it("preserves four raw identities and updates only real language and agency display names", async () => {
    const firstPage = page("labels", {
      agencyId: " agency-01 ",
      agencyName: "Agency One",
      language: " language-02 ",
      languageName: "Language One",
      seriesTypeList: ["  series/type  "],
      recommendList: ["recommend/特别"],
    });
    await enqueue("apply");
    await consume({ ...adapter(), listBooks: async () => firstPage });
    const initial = await owner.sourceLabel.findMany({ orderBy: { labelKind: "asc" } });
    expect(initial.map(({ labelKind, externalLabelValue, displayValue }) => ({
      labelKind,
      externalLabelValue,
      displayValue,
    }))).toEqual([
      { labelKind: "agency", externalLabelValue: " agency-01 ", displayValue: "Agency One" },
      { labelKind: "language", externalLabelValue: " language-02 ", displayValue: "Language One" },
      { labelKind: "recommend", externalLabelValue: "recommend/特别", displayValue: null },
      { labelKind: "series_type", externalLabelValue: "  series/type  ", displayValue: null },
    ]);
    const identities = new Map(initial.map(({ labelKind, id }) => [labelKind, id]));

    await enqueue("apply", randomUUID());
    await consume({
      ...adapter(),
      listBooks: async () => page("labels", {
        ...firstPage.items[0],
        agencyName: "Agency Renamed",
        languageName: "Language Renamed",
      }),
    });
    const renamed = await owner.sourceLabel.findMany({ orderBy: { labelKind: "asc" } });
    expect(renamed).toHaveLength(4);
    expect(new Map(renamed.map(({ labelKind, id }) => [labelKind, id]))).toEqual(identities);
    expect(renamed.find(({ labelKind }) => labelKind === "language")?.displayValue).toBe("Language Renamed");
    expect(renamed.find(({ labelKind }) => labelKind === "agency")?.displayValue).toBe("Agency Renamed");

    await enqueue("apply", randomUUID());
    await consume({
      ...adapter(),
      listBooks: async () => page("labels", {
        ...firstPage.items[0],
        agencyName: null,
        languageName: null,
      }),
    });
    const missingDisplay = await owner.sourceLabel.findMany();
    expect(missingDisplay).toHaveLength(4);
    expect(missingDisplay.find(({ labelKind }) => labelKind === "language")?.displayValue).toBe("Language Renamed");
    expect(missingDisplay.find(({ labelKind }) => labelKind === "agency")?.displayValue).toBe("Agency Renamed");
  });

  it("reconciles active state per trusted book while preserving history and refreshing last_seen", async () => {
    const firstSeen = new Date();
    const missingAt = new Date(firstSeen.valueOf() + 60_000);
    const restoredAt = new Date(firstSeen.valueOf() + 120_000);
    await enqueue("apply");
    await consume({ ...adapter(), listBooks: async () => page("lifecycle") }, gates, () => firstSeen);
    const source = await owner.novelSourceItem.findFirstOrThrow({ where: { externalBookId: "lifecycle" } });
    const oldLabel = await owner.sourceLabel.findFirstOrThrow({
      where: { channelAppId: ids.channelApp, labelKind: "series_type", externalLabelValue: "raw-series-type" },
    });
    const initialRelation = await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: oldLabel.id } },
    });
    expect(initialRelation).toMatchObject({ active: true, lastSeenAt: firstSeen });

    await enqueue("apply", randomUUID());
    await consume({
      ...adapter(),
      listBooks: async () => page("lifecycle", {
        seriesTypeList: ["replacement-series"],
      }),
    }, gates, () => missingAt);
    const inactive = await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: oldLabel.id } },
    });
    expect(inactive).toMatchObject({
      active: false,
      firstSeenAt: initialRelation.firstSeenAt,
      lastSeenAt: firstSeen,
    });
    const language = await owner.sourceLabel.findFirstOrThrow({
      where: { channelAppId: ids.channelApp, labelKind: "language", externalLabelValue: "2" },
    });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: language.id } },
    })).toMatchObject({ active: true, lastSeenAt: missingAt });

    await enqueue("apply", randomUUID());
    await consume({ ...adapter(), listBooks: async () => page("lifecycle") }, gates, () => restoredAt);
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: oldLabel.id } },
    })).toMatchObject({
      active: true,
      firstSeenAt: initialRelation.firstSeenAt,
      lastSeenAt: restoredAt,
    });
  });

  it("keeps successful per-book reconciliation after later partial failure and skips incomplete snapshots", async () => {
    await enqueue("apply");
    await consume({ ...adapter(), listBooks: async () => page("durable-labels") });
    const source = await owner.novelSourceItem.findFirstOrThrow({ where: { externalBookId: "durable-labels" } });
    const oldLabel = await owner.sourceLabel.findFirstOrThrow({
      where: { channelAppId: ids.channelApp, labelKind: "series_type", externalLabelValue: "raw-series-type" },
    });
    await enqueue("apply", randomUUID());
    await consume({ ...adapter(), listBooks: async () => page("unseen-on-failed-page") });
    const unseenSource = await owner.novelSourceItem.findFirstOrThrow({
      where: { externalBookId: "unseen-on-failed-page" },
    });

    const range = await enqueueRange({ pageEnd: 2, pageSize: 1 });
    const partialLongValue = `partial-${"y".repeat(293)}`;
    const partialAdapter: MoboreaderReadAdapter = {
      ...adapter(),
      listBooks: async (request) => {
        if (request.pageIndex === 1) {
          return page("durable-labels", {
            seriesTypeList: ["confirmed-on-page-one", partialLongValue],
          }, 2);
        }
        throw new Error("later page failed");
      },
    };
    await consume(partialAdapter);
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: oldLabel.id } },
    })).toMatchObject({ active: false });
    const confirmed = await owner.sourceLabel.findFirstOrThrow({
      where: { channelAppId: ids.channelApp, labelKind: "series_type", externalLabelValue: "confirmed-on-page-one" },
    });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: confirmed.id } },
    })).toMatchObject({ active: true });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: unseenSource.id, sourceLabelId: oldLabel.id } },
    })).toMatchObject({ active: true });

    await consume(partialAdapter);
    expect(await owner.catalogScanTask.findUniqueOrThrow({ where: { id: range.taskId } })).toMatchObject({
      status: "completed_with_errors",
      result: { terminalState: "partial_failed", droppedLabels: { count: 1 } },
    });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: oldLabel.id } },
    })).toMatchObject({ active: false });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: confirmed.id } },
    })).toMatchObject({ active: true });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: unseenSource.id, sourceLabelId: oldLabel.id } },
    })).toMatchObject({ active: true });

    await enqueue("apply", randomUUID());
    const incompleteAdapter = createMoboreaderReadAdapter({
      maxAttempts: 1,
      fetchImpl: async () => new Response(JSON.stringify({
        data: {
          totalCount: 1,
          list: [{
            id: "durable-labels",
            seriesId: "series-durable-labels",
            seriesName: "Incomplete label row",
            language: "2",
            languageName: "English",
            seriesTypeList: [],
            recommendList: [],
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await consume(incompleteAdapter);
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: confirmed.id } },
    })).toMatchObject({ active: true });
  });

  it("keeps oversize source values only in raw_payload and exposes a non-leaking anomaly summary", async () => {
    const longValue = `oversize-${"x".repeat(293)}`;
    expect(Array.from(longValue)).toHaveLength(302);
    const digest = createHash("sha256").update(longValue, "utf8").digest("hex");
    const created = await enqueue("apply");
    await consume({
      ...adapter(),
      listBooks: async () => page("oversize", {
        seriesTypeList: [longValue],
        rawEvidence: {
          id: "oversize",
          agencyId: "agency-1",
          agencyName: "Agency",
          seriesId: "series-oversize",
          projectType: 1,
          language: "2",
          languageName: "English",
          seriesTypeList: [longValue],
          recommendList: ["raw-recommend"],
          __boundary: "approved_raw_evidence",
        },
      }),
    });
    expect(await owner.sourceLabel.count({ where: { externalLabelValue: longValue } })).toBe(0);
    expect(await owner.sourceLabel.count()).toBe(3);
    const source = await owner.novelSourceItem.findFirstOrThrow({ where: { externalBookId: "oversize" } });
    expect(JSON.stringify(source.rawPayload)).toContain(longValue);

    const expected = {
      count: 1,
      groups: [{ kind: "series_type", length: 302, sha256: digest, count: 1 }],
    };
    const item = await owner.catalogScanTaskItem.findFirstOrThrow({ where: { taskId: created.taskId } });
    const task = await owner.catalogScanTask.findUniqueOrThrow({ where: { id: created.taskId } });
    const audit = await owner.operationAudit.findFirstOrThrow({
      where: { taskId: created.taskId, action: "moboreader.catalog_page.applied.1" },
    });
    expect(item.result).toMatchObject({ droppedLabels: expected });
    expect(task.result).toMatchObject({ droppedLabels: expected });
    expect(audit.afterSnapshot).toMatchObject({ droppedLabels: expected });
    expect(JSON.stringify({ item: item.result, task: task.result, audit: audit.afterSnapshot })).not.toContain(longValue);
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

  it("records safety limit as logical partial_failed and schema-compatible completed_with_errors", async () => {
    const safetyEnv = { ...gates, MOBOREADER_CATALOG_SAFETY_MAX_PAGES: "1" } satisfies NodeJS.ProcessEnv;
    const created = await enqueueRange({ pageEnd: 3, pageSize: 1, env: safetyEnv });
    expect(await consume(adapter(), safetyEnv)).toBe(true);
    const task = await owner.catalogScanTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(task).toMatchObject({ status: "completed_with_errors", totalCount: 1, successCount: 1 });
    expect(task.result).toMatchObject({
      stopReason: "safety_limit",
      terminalState: "partial_failed",
      completeness: { expected: 3, actual: 1 },
    });
  });

  it.each([
    ["empty_page", { items: [], totalCount: 10, rawEvidence: { __boundary: "approved_raw_evidence" } }],
    ["short_page", { ...page("short"), totalCount: 10 }],
  ] as const)("stops remaining pages on %s and records incomplete expected-vs-actual", async (reason, response) => {
    const created = await enqueueRange({ pageEnd: 3, pageSize: 2 });
    expect(await consume({ ...adapter(), listBooks: async () => response } as MoboreaderReadAdapter)).toBe(true);
    const task = await owner.catalogScanTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(task).toMatchObject({ status: "completed_with_errors", totalCount: 3, successCount: 3 });
    expect(task.result).toMatchObject({ stopReason: reason, terminalState: "partial_failed" });
    expect(await owner.catalogScanTaskItem.count({ where: { taskId: created.taskId, result: { path: ["stoppedBeforeFetch"], equals: true } } })).toBe(2);
  });

  it("records upstream_error and does not continue later catalog pages", async () => {
    const created = await enqueueRange({ pageEnd: 3, pageSize: 1 });
    const failing = { ...adapter(), listBooks: async () => { throw new Error("upstream body must not persist"); } };
    expect(await consume(failing)).toBe(true);
    const task = await owner.catalogScanTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(task).toMatchObject({ status: "completed_with_errors", failedCount: 3 });
    expect(task.result).toMatchObject({ stopReason: "upstream_error", terminalState: "partial_failed" });
    expect(JSON.stringify(task.error)).not.toContain("upstream body must not persist");
  });

  it("enqueues exactly the current linked catalog batch and executes the frozen fallback request contract", async () => {
    const touched = await seedLinkedSource("book-1", "scope-touched");
    const outside = await seedLinkedSource("book-outside", "scope-outside");
    const created = await enqueue("apply");
    expect(await consume()).toBe(true);
    const preview = await owner.channelSyncTask.findUniqueOrThrow({
      where: { requestToken: `moboreader.preview_refresh.v1:${created.taskId}` },
      include: { items: true },
    });
    expect(preview).toMatchObject({
      taskType: "moboreader.preview_refresh.v1",
      status: "pending",
      totalCount: 1,
      params: {
        trigger: "auto",
        catalogScanTaskId: created.taskId,
        runtime: { chunkSize: 25, concurrency: 2, timeoutMs: 20_000, freshnessMs: 86_400_000 },
        evidence: {
          dataId: "confirmed_getlistpc_series_id",
          materialType: "confirmed_runtime_selection_policy",
          materialTypeGlobalConstant: "not_asserted",
          materialType1001: "rejected",
          productionPreviewCall: "enabled",
        },
      },
    });
    expect(preview.items.map(({ novelSourceItemId }) => novelSourceItemId)).toEqual([touched.source.id]);
    expect(preview.items.map(({ novelSourceItemId }) => novelSourceItemId)).not.toContain(outside.source.id);

    const readAdapter = adapter();
    readAdapter.fetchBookMaterial = vi.fn(readAdapter.fetchBookMaterial);
    readAdapter.fetchPreviewChapters = vi.fn(readAdapter.fetchPreviewChapters);
    expect(await consumePreview(readAdapter)).toBe(true);
    expect(readAdapter.fetchBookMaterial).toHaveBeenCalledWith({
      agencyId: "agency-1",
      dataId: "series-book-1",
      projectType: 1,
      language: "2",
      materialType: 1,
    }, "test-jwt", expect.any(AbortSignal));
    expect(readAdapter.fetchPreviewChapters).toHaveBeenCalledWith({
      agencyId: "agency-1",
      seriesId: "series-book-1",
      projectType: 1,
      language: "2",
    }, "test-jwt", expect.any(AbortSignal));
    expect(await owner.channelSyncTask.findUniqueOrThrow({ where: { id: preview.id } })).toMatchObject({
      status: "completed",
      successCount: 1,
    });
    expect(await owner.novelChapter.count({ where: { novelId: touched.novel.id } })).toBe(3);

    const retry = await createMoboreaderPreviewRefreshTask(owner, {
      channelAccountId: ids.account,
      channelAppId: ids.channelApp,
      novelSourceItemIds: [touched.source.id],
      requestToken: `moboreader.preview_refresh.v1:${created.taskId}`,
      actorId: "owner",
      requestId: randomUUID(),
    }, gates);
    expect(retry).toMatchObject({ status: "duplicate", taskId: preview.id });
  });

  it("uses the same task path for manual trigger and applies 24h freshness without widening scope", async () => {
    const stale = await seedLinkedSource("book-1", "manual-stale");
    const fresh = await seedLinkedSource("book-fresh", "manual-fresh");
    await owner.novelPreviewPolicy.create({
      data: {
        novelId: fresh.novel.id,
        maxMaterializedChapters: 3,
        lastRefreshedAt: new Date(),
      },
    });
    const manual = await createMoboreaderPreviewRefreshTask(owner, {
      channelAccountId: ids.account,
      channelAppId: ids.channelApp,
      novelSourceItemIds: [stale.source.id, fresh.source.id],
      requestToken: randomUUID(),
      actorId: "owner",
      requestId: randomUUID(),
    }, gates);
    expect(manual).toMatchObject({
      status: "enqueued",
      taskStatus: "pending",
      eligibleCount: 1,
      skipReasonCounts: { fresh_preview: 1 },
    });
    const task = await owner.channelSyncTask.findUniqueOrThrow({
      where: { id: manual.status === "enqueued" ? manual.taskId : randomUUID() },
      include: { items: true },
    });
    expect(task.params).toMatchObject({ trigger: "manual" });
    expect(task.items.map(({ novelSourceItemId }) => novelSourceItemId)).toEqual([stale.source.id]);

    const disjoint = await seedLinkedSource("book-disjoint", "manual-disjoint");
    const disjointManual = await createMoboreaderPreviewRefreshTask(owner, {
      channelAccountId: ids.account,
      channelAppId: ids.channelApp,
      novelSourceItemIds: [disjoint.source.id],
      requestToken: randomUUID(),
      actorId: "owner",
      requestId: randomUUID(),
    }, gates);
    expect(disjointManual).toMatchObject({ status: "enqueued", eligibleCount: 1 });

    const noSourceAppAllowlist = await createMoboreaderPreviewRefreshTask(owner, {
      channelAccountId: ids.account,
      channelAppId: ids.channelApp,
      novelSourceItemIds: [stale.source.id],
      requestToken: randomUUID(),
      actorId: "owner",
      requestId: randomUUID(),
    }, {
      NODE_ENV: "test",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    });
    expect(noSourceAppAllowlist).toEqual({
      status: "no_eligible_sources",
      skipReasonCounts: { source_app_not_allowlisted: 1 },
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
    const restored = await materializeChangduPreview(worker, { ...common, chapterList: chapters(3), allEpis: 101, payEpisFrom: 8 });
    expect(restored).toMatchObject({ materializedCount: 3, restoredCount: 1 });
    expect(await owner.novelChapter.count({ where: { status: "stale" } })).toBe(0);
    expect(await owner.indexNowOutbox.count()).toBe(0);
    const previewAudits = await owner.operationAudit.findMany({
      where: { action: "moboreader.preview.materialized" },
      select: { afterSnapshot: true },
    });
    const serializedAudits = JSON.stringify(previewAudits);
    expect(serializedAudits).not.toContain("body-1");
    expect(serializedAudits).not.toContain("body-2");
  });

  it("rereads per-novel preview cap values 1, 2 and 5 on each refresh", async () => {
    await enqueue("apply");
    await consume();
    const source = await owner.novelSourceItem.findFirstOrThrow();
    const novel = await owner.novel.create({ data: { businessId: "dynamic-cap", title: "Dynamic", description: "D", locale: "en-US", slug: "dynamic-cap" } });
    await owner.novelSourceItem.update({ where: { id: source.id }, data: { novelId: novel.id } });
    const sync = await owner.channelSyncTask.create({
      data: {
        taskType: "moboreader.preview_refresh.v1",
        channelAccountId: ids.account,
        channelAppId: ids.channelApp,
        operationScopeHash: "d".repeat(64),
        requestToken: randomUUID(),
        status: "disabled",
        totalCount: 1,
        items: { create: [{ novelSourceItemId: source.id, payload: { test: true } }] },
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
      chapterList: chapters(5),
    };
    expect((await materializeChangduPreview(worker, common)).materializedCount).toBe(3);
    for (const cap of [1, 2, 5]) {
      await owner.novelPreviewPolicy.update({ where: { novelId: novel.id }, data: { maxMaterializedChapters: cap } });
      expect((await materializeChangduPreview(worker, common)).materializedCount).toBe(cap);
    }
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
