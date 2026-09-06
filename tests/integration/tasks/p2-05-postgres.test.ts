import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMoboreaderReadAdapter,
  parsePreviewChaptersResponse,
  type ListBooksResponse,
  type MoboreaderBook,
  type MoboreaderReadAdapter,
} from "@/lib/adapters";
import { materializeChangduPreview } from "@/lib/preview";
import { resolveSiteLocale } from "@/lib/locale/locale-canonical";
import {
  buildPromoLinkIdempotencyKey,
  buildWorkerAllowlist,
  createMoboreaderCatalogScanTask,
  createMoboreaderPreviewRefreshTask,
} from "@/lib/tasks";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { createMoboreaderWorkerHandlers } from "../../../worker/handlers/moboreader";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";
import { runPreviewOne } from "../../../scripts/x8-preview-one";

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
  MOBOREADER_PREVIEW_SOURCE_APP_CODES: "moboreader",
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
      existingPromo: { upstreamCode: null, webUrl: null },
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
  // Phase B entity fix: Channel is the changdu channel, SourceApp is the
  // moboreader theater — see 施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md
  // §二. Previously reversed here (and in production); ChannelApp.externalAppId
  // stays "moboreader" (unaffected — it names the upstream app id, not either
  // entity's own code).
  await owner.channel.create({ data: { id: ids.channel, code: "changdu", name: "Changdu" } });
  await owner.sourceApp.create({ data: { id: ids.sourceApp, code: "moboreader", name: "MoboReader" } });
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
      encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker("test-jwt", ids.account, ids.credential, 1)),
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

async function seedLinkedSource(
  bookId: string,
  businessId: string,
  language = "2",
  languageName = "English",
) {
  const novel = await owner.novel.create({
    data: { businessId, title: `Novel ${bookId}`, description: "Description", locale: "en-US", slug: businessId },
  });
  const source = await owner.novelSourceItem.create({
    data: {
      channelAppId: ids.channelApp,
      novelId: novel.id,
      externalBookId: bookId,
      sourceLanguageCode: language,
      sourceLanguageName: languageName,
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
      MOBOREADER_PREVIEW_SOURCE_APP_CODES: "moboreader",
    } satisfies NodeJS.ProcessEnv;
    const created = await enqueue("dry_run", randomUUID(), dryRunOnly);
    expect(created.status).toBe("enqueued");
    expect(await consume(adapter(), dryRunOnly)).toBe(true);
    expect(await owner.novelSourceItem.count()).toBe(0);
    expect(await owner.channelSyncTask.count()).toBe(0);
    const task = await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(task).toMatchObject({ status: "completed", successCount: 1 });
    expect(await owner.operationAudit.count({ where: { taskId: created.taskId } })).toBeGreaterThanOrEqual(2);
  });

  it("writes a checkpoint through worker_app and reruns idempotently", async () => {
    const first = await enqueue("apply");
    expect(await consume()).toBe(true);
    expect(await owner.novelSourceItem.count()).toBe(1);
    const task = await owner.genericTask.findUniqueOrThrow({ where: { id: first.taskId } });
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

  it("writes sourceLocale and captures a linked source promo before rawPayload redaction", async () => {
    const linked = await seedLinkedSource("promo-book", "promo-book-business", "3", "英语");
    await owner.article.create({
      data: {
        novelId: linked.novel.id,
        locale: "en-US",
        slug: "promo-book-article",
        publicPageShortId: "promoarticle1",
        title: "Promo article",
        body: "Body",
      },
    });
    const secretCode = "UPSTREAM-SECRET-CODE";
    const secretUrl = "https://promo.example/secret-path";
    const response = page("promo-book", {
      language: "3",
      languageName: "英语",
      existingPromo: { upstreamCode: secretCode, webUrl: secretUrl },
      rawEvidence: {
        id: "promo-book",
        agencyId: "agency-1",
        seriesId: "series-promo-book",
        projectType: 1,
        language: "3",
        kocCode: "[redacted]",
        publicUrl: "[redacted]",
        promotionalText: "[redacted]",
        __boundary: "approved_raw_evidence",
      },
    });
    const created = await enqueue("apply");
    expect(await consume({ ...adapter(), listBooks: async () => response })).toBe(true);

    const source = await owner.novelSourceItem.findUniqueOrThrow({ where: { id: linked.source.id } });
    expect(source.sourceLocale).toBe(resolveSiteLocale("3", "英语"));
    expect(JSON.stringify(source.rawPayload)).not.toContain(secretCode);
    expect(JSON.stringify(source.rawPayload)).not.toContain(secretUrl);
    expect(source.rawPayload).toMatchObject({
      kocCode: "[redacted]",
      publicUrl: "[redacted]",
      promotionalText: "[redacted]",
    });

    const promoLink = await owner.promoLink.findUniqueOrThrow({
      where: {
        idempotencyKey: buildPromoLinkIdempotencyKey({
          channelAppId: ids.channelApp,
          novelSourceItemId: linked.source.id,
          channelAccountId: ids.account,
          offerType: "read",
        }),
      },
    });
    expect(promoLink).toMatchObject({
      novelId: linked.novel.id,
      novelSourceItemId: linked.source.id,
      channelAccountId: ids.account,
      offerType: "read",
      origin: "upstream_existing",
      upstreamCode: secretCode,
      webUrl: secretUrl,
      appUrl: null,
      status: "fetched",
    });
    expect(promoLink.publicRedirectCode).toMatch(/^[a-z0-9]{10}$/);
    expect((await owner.article.findUniqueOrThrow({ where: { novelId_locale: { novelId: linked.novel.id, locale: "en-US" } } })).promoLinkId)
      .toBe(promoLink.id);
    const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: created.taskId } });
    expect(item.result).toMatchObject({ promoCapture: { fetched: 1, deferredUntilLinked: 0, incomplete: 0, articlesBound: 1 } });
    const publicEvidence = JSON.stringify({
      item: item.result,
      audits: await owner.operationAudit.findMany({
        where: { taskId: created.taskId },
        select: { action: true, reason: true, beforeSnapshot: true, afterSnapshot: true },
      }),
    });
    expect(publicEvidence).not.toContain(secretCode);
    expect(publicEvidence).not.toContain(secretUrl);

    const updatedCode = "UPDATED-UPSTREAM-SECRET";
    const updatedUrl = "https://promo.example/updated-secret-path";
    await enqueue("apply");
    expect(await consume({
      ...adapter(),
      listBooks: async () => page("promo-book", {
        language: "3",
        languageName: "英语",
        existingPromo: { upstreamCode: updatedCode, webUrl: updatedUrl },
      }),
    })).toBe(true);
    const refreshed = await owner.promoLink.findUniqueOrThrow({ where: { id: promoLink.id } });
    expect(await owner.promoLink.count()).toBe(1);
    expect(refreshed.publicRedirectCode).toBe(promoLink.publicRedirectCode);
    expect(refreshed).toMatchObject({ upstreamCode: updatedCode, webUrl: updatedUrl, status: "fetched" });
  });

  it("defers promo capture for an unlinked source without staging secrets in rawPayload", async () => {
    const secretCode = "UNLINKED-SECRET-CODE";
    const created = await enqueue("apply");
    expect(await consume({
      ...adapter(),
      listBooks: async () => page("unlinked-promo", {
        existingPromo: { upstreamCode: secretCode, webUrl: "https://promo.example/unlinked" },
        rawEvidence: {
          id: "unlinked-promo",
          agencyId: "agency-1",
          seriesId: "series-unlinked-promo",
          projectType: 1,
          language: "2",
          kocCode: "[redacted]",
          publicUrl: "[redacted]",
          promotionalText: "[redacted]",
          __boundary: "approved_raw_evidence",
        },
      }),
    })).toBe(true);
    expect(await owner.promoLink.count()).toBe(0);
    const source = await owner.novelSourceItem.findFirstOrThrow({ where: { externalBookId: "unlinked-promo" } });
    expect(JSON.stringify(source.rawPayload)).not.toContain(secretCode);
    const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: created.taskId } });
    expect(item.result).toMatchObject({ promoCapture: { fetched: 0, deferredUntilLinked: 1 } });
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

  it("keeps absent relations active while refreshing only labels returned by upstream", async () => {
    const firstSeen = new Date();
    const secondSeen = new Date(firstSeen.valueOf() + 60_000);
    await enqueue("apply");
    await consume({
      ...adapter(),
      listBooks: async () => page("incremental-labels", { seriesTypeList: ["A", "B"] }),
    }, gates, () => firstSeen);
    const source = await owner.novelSourceItem.findFirstOrThrow({
      where: { externalBookId: "incremental-labels" },
    });
    const [labelA, labelB] = await Promise.all(["A", "B"].map((externalLabelValue) => (
      owner.sourceLabel.findFirstOrThrow({
        where: { channelAppId: ids.channelApp, labelKind: "series_type", externalLabelValue },
      })
    )));
    const [initialA, initialB] = await Promise.all([labelA, labelB].map((label) => (
      owner.novelSourceItemLabel.findUniqueOrThrow({
        where: {
          novelSourceItemId_sourceLabelId: {
            novelSourceItemId: source.id,
            sourceLabelId: label.id,
          },
        },
      })
    )));
    expect(initialA).toMatchObject({ active: true, lastSeenAt: firstSeen });
    expect(initialB).toMatchObject({ active: true, lastSeenAt: firstSeen });

    await enqueue("apply", randomUUID());
    await consume({
      ...adapter(),
      listBooks: async () => page("incremental-labels", { seriesTypeList: ["A"] }),
    }, gates, () => secondSeen);
    const [refreshedA, absentB] = await Promise.all([labelA, labelB].map((label) => (
      owner.novelSourceItemLabel.findUniqueOrThrow({
        where: {
          novelSourceItemId_sourceLabelId: {
            novelSourceItemId: source.id,
            sourceLabelId: label.id,
          },
        },
      })
    )));
    expect(refreshedA).toMatchObject({
      active: true,
      firstSeenAt: initialA.firstSeenAt,
      lastSeenAt: secondSeen,
    });
    expect(absentB).toMatchObject({
      active: true,
      firstSeenAt: initialB.firstSeenAt,
      lastSeenAt: firstSeen,
    });
  });

  it("keeps an explicitly inactive relation inactive when upstream returns it again", async () => {
    const firstSeen = new Date();
    const returnedAgainAt = new Date(firstSeen.valueOf() + 60_000);
    await enqueue("apply");
    await consume({
      ...adapter(),
      listBooks: async () => page("manual-inactive", { seriesTypeList: ["B"] }),
    }, gates, () => firstSeen);
    const source = await owner.novelSourceItem.findFirstOrThrow({ where: { externalBookId: "manual-inactive" } });
    const label = await owner.sourceLabel.findFirstOrThrow({
      where: { channelAppId: ids.channelApp, labelKind: "series_type", externalLabelValue: "B" },
    });
    const relationKey = {
      novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: label.id },
    };
    const initial = await owner.novelSourceItemLabel.findUniqueOrThrow({ where: relationKey });
    await owner.novelSourceItemLabel.update({ where: relationKey, data: { active: false } });

    await enqueue("apply", randomUUID());
    await consume({
      ...adapter(),
      listBooks: async () => page("manual-inactive", { seriesTypeList: ["B"] }),
    }, gates, () => returnedAgainAt);
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({ where: relationKey })).toMatchObject({
      active: false,
      firstSeenAt: initial.firstSeenAt,
      lastSeenAt: returnedAgainAt,
    });
  });

  it("creates a newly returned label relation active by default", async () => {
    const firstSeen = new Date();
    const newLabelSeenAt = new Date(firstSeen.valueOf() + 60_000);
    await enqueue("apply");
    await consume({
      ...adapter(),
      listBooks: async () => page("new-label", { seriesTypeList: ["A"] }),
    }, gates, () => firstSeen);
    await enqueue("apply", randomUUID());
    await consume({
      ...adapter(),
      listBooks: async () => page("new-label", { seriesTypeList: ["A", "C"] }),
    }, gates, () => newLabelSeenAt);
    const source = await owner.novelSourceItem.findFirstOrThrow({ where: { externalBookId: "new-label" } });
    const labelC = await owner.sourceLabel.findFirstOrThrow({
      where: { channelAppId: ids.channelApp, labelKind: "series_type", externalLabelValue: "C" },
    });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: labelC.id } },
    })).toMatchObject({ active: true, lastSeenAt: newLabelSeenAt });
  });

  it("keeps successful positive facts after later partial failure and skips incomplete snapshots", async () => {
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
    })).toMatchObject({ active: true });
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
    expect(await owner.genericTask.findUniqueOrThrow({ where: { id: range.taskId } })).toMatchObject({
      status: "completed_with_errors",
      result: { terminalState: "partial_failed", droppedLabels: { count: 1 } },
    });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: oldLabel.id } },
    })).toMatchObject({ active: true });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: source.id, sourceLabelId: confirmed.id } },
    })).toMatchObject({ active: true });
    expect(await owner.novelSourceItemLabel.findUniqueOrThrow({
      where: { novelSourceItemId_sourceLabelId: { novelSourceItemId: unseenSource.id, sourceLabelId: oldLabel.id } },
    })).toMatchObject({ active: true });

    const sourceLabelCountBeforeIncomplete = await owner.sourceLabel.count();
    const relationsBeforeIncomplete = await owner.novelSourceItemLabel.findMany({
      where: { novelSourceItemId: source.id },
      orderBy: { sourceLabelId: "asc" },
    });
    const incompleteEnqueue = await enqueue("apply", randomUUID());
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
    // F3: an untrusted label snapshot (missing agencyId entirely) must not write any
    // structured label row or flip any active/inactive state — only a durable count.
    expect(await owner.sourceLabel.count()).toBe(sourceLabelCountBeforeIncomplete);
    expect(await owner.novelSourceItemLabel.findMany({
      where: { novelSourceItemId: source.id },
      orderBy: { sourceLabelId: "asc" },
    })).toEqual(relationsBeforeIncomplete);
    const incompleteItem = await owner.genericTaskItem.findFirstOrThrow({
      where: { taskId: incompleteEnqueue.taskId },
    });
    expect(incompleteItem.result).toMatchObject({
      incompleteLabelSnapshots: 1,
      droppedLabels: { count: 0, groups: [] },
    });
    const incompleteTask = await owner.genericTask.findUniqueOrThrow({ where: { id: incompleteEnqueue.taskId } });
    expect(incompleteTask.result).toMatchObject({
      terminalState: "completed",
      incompleteLabelSnapshots: 1,
      droppedLabels: { count: 0, groups: [] },
    });
    const incompleteAudit = await owner.operationAudit.findFirstOrThrow({
      where: { taskId: incompleteEnqueue.taskId, action: "moboreader.catalog_page.applied.1" },
    });
    expect(incompleteAudit.afterSnapshot).toMatchObject({ incompleteLabelSnapshots: 1 });
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
    const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: created.taskId } });
    const task = await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } });
    const audit = await owner.operationAudit.findFirstOrThrow({
      where: { taskId: created.taskId, action: "moboreader.catalog_page.applied.1" },
    });
    expect(item.result).toMatchObject({ droppedLabels: expected });
    expect(task.result).toMatchObject({ droppedLabels: expected });
    expect(audit.afterSnapshot).toMatchObject({ droppedLabels: expected });
    expect(JSON.stringify({ item: item.result, task: task.result, audit: audit.afterSnapshot })).not.toContain(longValue);
  });

  it("keeps per-page droppedLabels on non-terminal pages and only aggregates the full task at the terminal page", async () => {
    const longA = `oversize-a-${"a".repeat(293)}`;
    const longB = `oversize-b-${"b".repeat(293)}`;
    const digestA = createHash("sha256").update(longA, "utf8").digest("hex");
    const digestB = createHash("sha256").update(longB, "utf8").digest("hex");
    const lengthA = Array.from(longA).length;
    const lengthB = Array.from(longB).length;
    const created = await enqueueRange({ pageEnd: 3, pageSize: 1 });
    const pagedAdapter: MoboreaderReadAdapter = {
      ...adapter(),
      listBooks: async (request) => {
        if (request.pageIndex === 1) return page("page-a", { seriesTypeList: [longA] }, 3);
        if (request.pageIndex === 2) return page("page-b", { seriesTypeList: [longB] }, 3);
        return page("page-c", {}, 3);
      },
    };

    expect(await consume(pagedAdapter)).toBe(true);
    const itemPage1 = await owner.genericTaskItem.findFirstOrThrow({
      where: { taskId: created.taskId, targetType: "catalog_page", targetId: "1" },
    });
    expect(itemPage1.result).toMatchObject({
      droppedLabels: { count: 1, groups: [{ kind: "series_type", length: lengthA, sha256: digestA, count: 1 }] },
    });
    const taskAfterPage1 = await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(taskAfterPage1.result).toMatchObject({
      terminalState: "processing",
      droppedLabels: { count: 1, groups: [{ kind: "series_type", length: lengthA, sha256: digestA, count: 1 }] },
    });

    expect(await consume(pagedAdapter)).toBe(true);
    const itemPage2 = await owner.genericTaskItem.findFirstOrThrow({
      where: { taskId: created.taskId, targetType: "catalog_page", targetId: "2" },
    });
    expect(itemPage2.result).toMatchObject({
      droppedLabels: { count: 1, groups: [{ kind: "series_type", length: lengthB, sha256: digestB, count: 1 }] },
    });
    // Still non-terminal (page 3 is pending): the task summary must stay page-scoped
    // (only page 2's drop) rather than already carrying page 1's drop as well.
    const taskAfterPage2 = await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(taskAfterPage2.result).toMatchObject({
      terminalState: "processing",
      droppedLabels: { count: 1, groups: [{ kind: "series_type", length: lengthB, sha256: digestB, count: 1 }] },
    });

    expect(await consume(pagedAdapter)).toBe(true);
    const itemPage3 = await owner.genericTaskItem.findFirstOrThrow({
      where: { taskId: created.taskId, targetType: "catalog_page", targetId: "3" },
    });
    expect(itemPage3.result).toMatchObject({ droppedLabels: { count: 0, groups: [] } });
    // Terminal page: the task summary must now be the full-task aggregate across all pages.
    const finalTask = await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(finalTask.result).toMatchObject({
      terminalState: "completed",
      droppedLabels: {
        count: 2,
        groups: expect.arrayContaining([
          { kind: "series_type", length: lengthA, sha256: digestA, count: 1 },
          { kind: "series_type", length: lengthB, sha256: digestB, count: 1 },
        ]),
      },
    });
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
    expect(await owner.genericTaskItem.count({ where: { taskId: created.taskId, status: "success" } })).toBe(1);
    expect(await owner.genericTaskItem.count({ where: { taskId: created.taskId, status: "pending" } })).toBe(1);
    const completedPage = await owner.genericTaskItem.findFirstOrThrow({
      where: { taskId: created.taskId, targetType: "catalog_page", status: "success" },
      select: { targetId: true },
    });
    expect((await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } })).result)
      .toMatchObject({ checkpoint: { lastCompletedPage: Number(completedPage.targetId) } });
    expect(await consume(paged)).toBe(true);
    expect(await owner.novelSourceItem.count()).toBe(2);
    expect(await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } })).toMatchObject({
      status: "completed",
      successCount: 2,
      result: { checkpoint: { lastCompletedPage: 2 } },
    });
  });

  it("records safety limit as logical partial_failed and schema-compatible completed_with_errors", async () => {
    const safetyEnv = { ...gates, MOBOREADER_CATALOG_SAFETY_MAX_PAGES: "1" } satisfies NodeJS.ProcessEnv;
    const created = await enqueueRange({ pageEnd: 3, pageSize: 1, env: safetyEnv });
    expect(await consume(adapter(), safetyEnv)).toBe(true);
    const task = await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } });
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
    const task = await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(task).toMatchObject({ status: "completed_with_errors", totalCount: 3, successCount: 3 });
    expect(task.result).toMatchObject({ stopReason: reason, terminalState: "partial_failed" });
    expect(await owner.genericTaskItem.count({ where: { taskId: created.taskId, result: { path: ["stoppedBeforeFetch"], equals: true } } })).toBe(2);
  });

  it("records upstream_error and does not continue later catalog pages", async () => {
    const created = await enqueueRange({ pageEnd: 3, pageSize: 1 });
    const failing = { ...adapter(), listBooks: async () => { throw new Error("upstream body must not persist"); } };
    expect(await consume(failing)).toBe(true);
    const task = await owner.genericTask.findUniqueOrThrow({ where: { id: created.taskId } });
    expect(task).toMatchObject({ status: "completed_with_errors", failedCount: 3 });
    expect(task.result).toMatchObject({ stopReason: "upstream_error", terminalState: "partial_failed" });
    expect(JSON.stringify(task.error)).not.toContain("upstream body must not persist");
  });

  it.each([false, true])("enqueues the linked batch and executes the frozen request contract (targeted=%s)", async (targeted) => {
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
    readAdapter.fetchPreviewChapters = vi.fn(async () => parsePreviewChaptersResponse({
      data: { bookId: 998877, currentLanguage: 2, chapterList: chapters(3) },
    }));
    if (targeted) {
      const logger = vi.fn();
      const options = { taskId: preview.id, itemId: preview.items[0].id, actor: "test-operator" };
      const dependencies = {
        env: { ...gates, P1_12_COMPOSE_PROJECT: "cps-novel-x8-local", SITE_URL: "https://novel.test", WORKER_TASK_ALLOWLIST: "moboreader.preview_refresh.v1" },
        handlers: createMoboreaderWorkerHandlers(worker, { adapter: readAdapter, env: gates }),
        logger,
      };
      expect(await runPreviewOne(worker, options, dependencies)).toMatchObject({ outcome: "success", attemptCount: 1 });
      expect(logger).toHaveBeenLastCalledWith(expect.objectContaining({
        phase: "finished", taskId: preview.id, itemId: preview.items[0].id, actor: "test-operator", outcome: "success",
      }));
      expect(JSON.stringify(logger.mock.calls)).not.toMatch(/test-jwt|body-1|agency-1/);
      expect(await runPreviewOne(worker, options, dependencies)).toMatchObject({ outcome: "not_consumed", reason: "target_not_eligible" });
      expect(readAdapter.fetchBookMaterial).toHaveBeenCalledTimes(1);
      expect(readAdapter.fetchPreviewChapters).toHaveBeenCalledTimes(1);
    } else {
      expect(await consumePreview(readAdapter)).toBe(true);
    }
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

  it.each(["getbydataid", "getchapterinfo", "source_app_excluded", "channel_inactive", "account_disabled"])(
    "targeting cannot bypass a closed preview boundary (%s)", async (boundary) => {
      await seedLinkedSource("book-1", `disabled-${boundary}`);
      const created = await enqueue("apply");
      await consume();
      const preview = await owner.channelSyncTask.findUniqueOrThrow({
        where: { requestToken: `moboreader.preview_refresh.v1:${created.taskId}` }, include: { items: true },
      });
      const runtimeEnv = { ...gates };
      if (boundary === "source_app_excluded") {
        runtimeEnv.MOBOREADER_PREVIEW_SOURCE_APP_CODES = "another-source";
      } else if (boundary === "channel_inactive") {
        await owner.channel.update({ where: { id: ids.channel }, data: { status: "inactive" } });
      } else if (boundary === "account_disabled") {
        await owner.channelAccount.update({ where: { id: ids.account }, data: { status: "disabled" } });
      } else {
        await owner.channelCapability.updateMany({ where: { capabilityKey: boundary }, data: { status: "registered_disabled" } });
      }
      const readAdapter = adapter();
      readAdapter.fetchBookMaterial = vi.fn(readAdapter.fetchBookMaterial);
      readAdapter.fetchPreviewChapters = vi.fn(readAdapter.fetchPreviewChapters);
      expect(await runPreviewOne(worker, { taskId: preview.id, itemId: preview.items[0].id, actor: "test-operator" }, {
        env: { ...runtimeEnv, P1_12_COMPOSE_PROJECT: "cps-novel-x8-local", SITE_URL: "https://novel.test", WORKER_TASK_ALLOWLIST: "moboreader.preview_refresh.v1" },
        handlers: createMoboreaderWorkerHandlers(worker, { adapter: readAdapter, env: runtimeEnv }), logger: () => undefined,
      })).toMatchObject({ outcome: "failed" });
      expect(readAdapter.fetchBookMaterial).not.toHaveBeenCalled();
      expect(readAdapter.fetchPreviewChapters).not.toHaveBeenCalled();
      expect(await owner.novelChapterContent.count()).toBe(0);
    },
  );

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
