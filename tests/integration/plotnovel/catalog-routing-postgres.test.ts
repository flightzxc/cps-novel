/**
 * v0.6.0 B：目录扫描按机构分流 + 口令码模式只写码——真实库、真实角色、真实 persistCatalogPage 事务。
 *
 * 目录接口不带剧场参数，PlotNovel（机构 1351）和 MoboReader（机构 3366）的书混在同一页里。
 * 这里用假上游适配器喂一页混合书目，经真实 worker 循环落库，逐行核对每本书落在哪个剧场、
 * 推广链接怎么写。
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ListBooksResponse, MoboreaderBook, MoboreaderReadAdapter } from "@/lib/adapters";
import { buildPromoLinkIdempotencyKey, buildWorkerAllowlist, createMoboreaderCatalogScanTask } from "@/lib/tasks";

import { createMoboreaderWorkerHandlers } from "../../../worker/handlers/moboreader";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";

import {
  MOBO_AGENCY,
  PLOT_AGENCY,
  assertDisposableDatabase,
  enabled,
  ids,
  owner,
  scheduler,
  seedBook,
  seedPromo,
  seedTheaters,
  truncateDatabase,
  web,
  worker,
  analyst,
} from "./support";

const gates = {
  NODE_ENV: "test",
  FEATURE_NOVEL_CATALOG_SYNC: "true",
  NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
} satisfies NodeJS.ProcessEnv;

function book(input: {
  id: string;
  agencyId: string | null;
  upstreamCode?: string | null;
  webUrl?: string | null;
  language?: string;
  languageName?: string;
  seriesTypes?: string[];
}): MoboreaderBook {
  const language = input.language ?? "3";
  const languageName = input.languageName ?? "English";
  return {
    externalBookId: input.id,
    agencyId: input.agencyId,
    agencyName: input.agencyId === PLOT_AGENCY ? "PlotNovel" : input.agencyId === MOBO_AGENCY ? "MoboReader" : null,
    seriesId: `series-${input.id}`,
    materialType: null,
    title: `Title ${input.id}`,
    description: "Description",
    coverUrl: null,
    projectType: 1,
    language,
    languageName,
    allEpis: 10,
    payEpisFrom: 4,
    splitRatio: 50,
    ttoSplitRatio: null,
    createTime: null,
    seriesTypeList: input.seriesTypes ?? ["Romance"],
    recommendList: [],
    labelSnapshotComplete: true,
    existingPromo: { upstreamCode: input.upstreamCode ?? null, webUrl: input.webUrl ?? null },
    rawEvidence: {
      id: input.id,
      agencyId: input.agencyId,
      seriesId: `series-${input.id}`,
      projectType: 1,
      language,
      languageName,
      __boundary: "approved_raw_evidence",
    } as const,
  };
}

function adapterFor(books: MoboreaderBook[]): MoboreaderReadAdapter {
  const response: ListBooksResponse = {
    items: books,
    totalCount: books.length,
    rawEvidence: { totalCount: books.length, __boundary: "approved_raw_evidence" } as const,
  };
  return {
    listBooks: async () => response,
    fetchBookMaterial: async () => { throw new Error("not used"); },
    fetchPreviewChapters: async () => { throw new Error("not used"); },
  };
}

async function scan(books: MoboreaderBook[], appId: string = ids.moboApp): Promise<string> {
  const created = await createMoboreaderCatalogScanTask(owner, {
    channelAccountId: ids.account,
    channelAppId: appId,
    pageStart: 1,
    pageEnd: 1,
    pageSize: 20,
    requestToken: randomUUID(),
    actorId: "plotnovel-test",
    requestId: randomUUID(),
    mode: "apply",
  }, gates);
  if (created.status !== "enqueued") throw new Error(`scan not enqueued: ${created.status}`);
  const handlers = createMoboreaderWorkerHandlers(worker, { adapter: adapterFor(books), env: gates });
  const consumeOnce = () => processOneWorkerCycle({
    prisma: worker,
    workerId: "plotnovel-worker",
    handlers,
    allowlist: buildWorkerAllowlist("catalog_scan", handlers),
    signal: new AbortController().signal,
    leaseMs: 30_000,
  });
  expect(await consumeOnce()).toBe(true);
  // 终结（finalize）条目在页条目之后才可领取。
  await consumeOnce();
  return created.taskId;
}

async function sourceRows(externalBookId: string) {
  return owner.novelSourceItem.findMany({
    where: { externalBookId },
    select: { id: true, channelAppId: true, sourceLocale: true, sourceLanguageCode: true, externalAgencyId: true, status: true },
  });
}

describe.skipIf(!enabled).sequential("v0.6.0 B：目录扫描按机构分流（真实库）", () => {
  beforeAll(assertDisposableDatabase);
  beforeEach(truncateDatabase);
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), scheduler.$disconnect(), analyst.$disconnect()]);
  });

  it("混合页：机构 1351 的书落到 PlotNovel，3366 落到 MoboReader；新机构与无机构编号的书退回任务剧场；语种都解析成 en", async () => {
    await seedTheaters();
    const taskId = await scan([
      book({ id: "plot-new", agencyId: PLOT_AGENCY }),
      book({ id: "mobo-new", agencyId: MOBO_AGENCY }),
      book({ id: "stranger", agencyId: "9999" }),
      book({ id: "no-agency", agencyId: null }),
    ]);

    expect((await sourceRows("plot-new")).map((row) => row.channelAppId)).toEqual([ids.plotApp]);
    expect((await sourceRows("mobo-new")).map((row) => row.channelAppId)).toEqual([ids.moboApp]);
    expect((await sourceRows("stranger")).map((row) => row.channelAppId)).toEqual([ids.moboApp]);
    expect((await sourceRows("no-agency")).map((row) => row.channelAppId)).toEqual([ids.moboApp]);
    for (const id of ["plot-new", "mobo-new", "stranger", "no-agency"]) {
      expect((await sourceRows(id))[0]).toMatchObject({ sourceLocale: "en", sourceLanguageCode: "3" });
    }
    expect((await sourceRows("plot-new"))[0]).toMatchObject({ externalAgencyId: PLOT_AGENCY });

    // 标签（含机构标签）也落在书所属的剧场下，不跟着任务剧场走。
    const labels = await owner.sourceLabel.findMany({ select: { channelAppId: true, labelKind: true, externalLabelValue: true } });
    const agencyLabels = labels.filter((label) => label.labelKind === "agency");
    expect(agencyLabels).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelAppId: ids.plotApp, externalLabelValue: PLOT_AGENCY }),
      expect.objectContaining({ channelAppId: ids.moboApp, externalLabelValue: MOBO_AGENCY }),
      expect.objectContaining({ channelAppId: ids.moboApp, externalLabelValue: "9999" }),
    ]));
    expect(agencyLabels.find((label) => label.externalLabelValue === PLOT_AGENCY)?.channelAppId).toBe(ids.plotApp);

    // 分流统计进了页结果：新机构 9999 被计数（便于发现该登记新剧场了）。
    const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId, targetType: "catalog_page" } });
    expect(item.result).toMatchObject({
      agencyRouting: {
        routedByChannelApp: { [ids.plotApp]: 1, [ids.moboApp]: 3 },
        unmappedBooks: 2,
        unmappedAgencies: { "9999": 1 },
      },
    });
    const task = await owner.genericTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.result).toMatchObject({ agencyRouting: { unmappedAgencies: { "9999": 1 } } });
  });

  it("任务建在 PlotNovel 剧场下也一样按机构分流（分流看书的机构，不看任务挂在谁名下）", async () => {
    await seedTheaters();
    await scan([book({ id: "plot-a", agencyId: PLOT_AGENCY }), book({ id: "mobo-a", agencyId: MOBO_AGENCY })], ids.plotApp);
    expect((await sourceRows("plot-a")).map((row) => row.channelAppId)).toEqual([ids.plotApp]);
    expect((await sourceRows("mobo-a")).map((row) => row.channelAppId)).toEqual([ids.moboApp]);
  });

  it("PlotNovel 还没打开（registered_disabled）时：1351 的书落在任务剧场下，与改动前完全一致，绝不另建重复书目", async () => {
    await seedTheaters({ plotStatus: "registered_disabled" });
    // 现状：PlotNovel 的书挂在 MoboReader 名下。
    await seedBook({ appId: ids.moboApp, externalBookId: "plot-legacy", title: "Legacy", agencyId: PLOT_AGENCY });
    await scan([book({ id: "plot-legacy", agencyId: PLOT_AGENCY }), book({ id: "plot-brand-new", agencyId: PLOT_AGENCY })]);

    expect(await sourceRows("plot-legacy")).toHaveLength(1);
    expect((await sourceRows("plot-legacy"))[0]!.channelAppId).toBe(ids.moboApp);
    expect((await sourceRows("plot-brand-new"))[0]!.channelAppId).toBe(ids.moboApp);
    expect(await owner.novelSourceItem.count({ where: { channelAppId: ids.plotApp } })).toBe(0);
  });

  it("口令码模式：只有口令码、没有网址的推广照样写入（status fetched、web_url 为空），幂等键用 PlotNovel 剧场编号", async () => {
    await seedTheaters();
    const { novel, source } = await seedBook({ appId: ids.plotApp, externalBookId: "plot-coded", title: "Coded", agencyId: PLOT_AGENCY });
    await scan([book({ id: "plot-coded", agencyId: PLOT_AGENCY, upstreamCode: "960031", webUrl: null })]);

    const promos = await owner.promoLink.findMany({ where: { novelSourceItemId: source.id } });
    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({
      novelId: novel!.id,
      channelAppId: ids.plotApp,
      upstreamCode: "960031",
      webUrl: null,
      status: "fetched",
      origin: "upstream_existing",
      idempotencyKey: buildPromoLinkIdempotencyKey({
        channelAppId: ids.plotApp, novelSourceItemId: source.id, channelAccountId: ids.account, offerType: "read",
      }),
    });
  });

  it("口令码模式：有网址、没有口令码 = 不完整，不写（没有码读者无从在 App 里找到这本书）", async () => {
    await seedTheaters();
    const { source } = await seedBook({ appId: ids.plotApp, externalBookId: "plot-urlonly", title: "UrlOnly", agencyId: PLOT_AGENCY });
    const taskId = await scan([book({ id: "plot-urlonly", agencyId: PLOT_AGENCY, upstreamCode: null, webUrl: "https://example.test/x" })]);
    expect(await owner.promoLink.count({ where: { novelSourceItemId: source.id } })).toBe(0);
    const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId, targetType: "catalog_page" } });
    expect(item.result).toMatchObject({ promoCapture: { fetched: 0, incomplete: 1 } });
  });

  it("防误伤：MoboReader（link 模式）下，有口令码、没有网址 = 不完整，不写推广链接（规则逐字不变）", async () => {
    await seedTheaters();
    const { source } = await seedBook({ appId: ids.moboApp, externalBookId: "mobo-codeonly", title: "CodeOnly", agencyId: MOBO_AGENCY });
    const taskId = await scan([book({ id: "mobo-codeonly", agencyId: MOBO_AGENCY, upstreamCode: "ABC123", webUrl: null })]);
    expect(await owner.promoLink.count({ where: { novelSourceItemId: source.id } })).toBe(0);
    const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId, targetType: "catalog_page" } });
    expect(item.result).toMatchObject({ promoCapture: { fetched: 0, incomplete: 1 } });
  });

  it("link 模式照旧：码和网址都有 → 写入并 fetched", async () => {
    await seedTheaters();
    const { source } = await seedBook({ appId: ids.moboApp, externalBookId: "mobo-full", title: "Full", agencyId: MOBO_AGENCY });
    await scan([book({ id: "mobo-full", agencyId: MOBO_AGENCY, upstreamCode: "ABC123", webUrl: "https://example.test/read" })]);
    const promos = await owner.promoLink.findMany({ where: { novelSourceItemId: source.id } });
    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({ channelAppId: ids.moboApp, upstreamCode: "ABC123", webUrl: "https://example.test/read", status: "fetched" });
  });

  it("口令码模式刷新已有推广：不会把已有网址冲成 NULL", async () => {
    await seedTheaters();
    const { novel, source } = await seedBook({ appId: ids.plotApp, externalBookId: "plot-keep", title: "Keep", agencyId: PLOT_AGENCY });
    await seedPromo({ appId: ids.plotApp, novelId: novel!.id, sourceId: source.id, upstreamCode: "OLD", webUrl: "https://example.test/kept" });
    await scan([book({ id: "plot-keep", agencyId: PLOT_AGENCY, upstreamCode: "960031", webUrl: null })]);
    const promo = await owner.promoLink.findFirstOrThrow({ where: { novelSourceItemId: source.id } });
    expect(promo).toMatchObject({ upstreamCode: "960031", webUrl: "https://example.test/kept", status: "fetched" });
    expect(await owner.promoLink.count({ where: { novelSourceItemId: source.id } })).toBe(1);
  });
});
