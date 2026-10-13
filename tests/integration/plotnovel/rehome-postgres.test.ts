/**
 * v0.6.0 C：存量改挂脚本——真实库、真实角色（worker_app）、真实 grants。
 *
 * 要证明的不是"外键改了"，而是改完之后这批书在系统里**仍然是同一批书**：
 *   - 推广链接的幂等键按新剧场重算，领取 handler 用新剧场编号算出的键能找到原来那一行（不会再 getcode 一次）；
 *   - 副作用意图（防重复领取的最后一道闸）跟着换键、换剧场，状态不变；
 *   - 标签字典与映射边跟着复制，标签投影对账零差异；
 *   - 数量不符 / 有未完成任务 / 唯一键冲突 → 一行不写；重复执行 → 改挂 0 行。
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildPromoLinkIdempotencyKey } from "@/lib/tasks/promo-link-claim";
import { checkEffectiveTags, reconcileAllEffectiveTags } from "@/server/tagging/effective-tag-projection";

import {
  REHOME_AUDIT_ACTION,
  REHOME_CONFIRM_PHRASE,
  RehomeRefusedError,
  rehomePlotnovelSourceItems,
  type RehomeOptions,
} from "../../../scripts/rehome-plotnovel-source-items";

import {
  MOBO_AGENCY,
  PLOT_AGENCY,
  analyst,
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
} from "./support";

const SCOPE = JSON.stringify(["RAW_LANGUAGE_SCOPE_V1", "3", "English"]);


async function seedWorld(options: { pending?: boolean } = {}) {
  await seedTheaters({ plotStatus: "registered_disabled" });
  const admin = await owner.adminIdentity.create({ data: { username: `rehome-${randomUUID()}`, passwordHash: "scrypt$v1$test-only", role: "super_admin" } });
  const tag = await owner.canonicalTag.create({
    data: { stableId: "ct-v1-romance", slug: "romance", canonicalDefinition: "Romance", sortOrder: 1, taxonomyVersion: "t1", status: "active" },
  });
  // MoboReader 名下的标签字典与映射边（生产现状：PlotNovel 的书当初也是挂在这里的）。
  const moboLabel = await owner.sourceLabel.create({ data: { channelAppId: ids.moboApp, labelKind: "series_type", externalLabelValue: "Romance" } });
  const moboAgencyLabel = await owner.sourceLabel.create({ data: { channelAppId: ids.moboApp, labelKind: "agency", externalLabelValue: PLOT_AGENCY, displayValue: "PlotNovel" } });
  await owner.sourceLabelMapping.create({
    data: { channelAppId: ids.moboApp, rawLanguageScope: SCOPE, rawToken: "Romance", canonicalTagId: tag.id, mappingVersion: "v1", approvedBy: admin.id },
  });

  const plotBooks = [];
  for (let index = 1; index <= 5; index += 1) {
    const linked = index <= 4; // 第 5 本没有绑定小说，也就没有推广链接
    const { novel, source } = await seedBook({
      appId: ids.moboApp, externalBookId: `plot-${index}`, title: `Plot Book ${index}`, agencyId: PLOT_AGENCY, linked,
    });
    await owner.$executeRawUnsafe(`UPDATE novel_source_item SET raw_language_scope = $1 WHERE id = '${source.id}'`, SCOPE);
    await owner.novelSourceItemLabel.create({ data: { novelSourceItemId: source.id, sourceLabelId: moboLabel.id } });
    await owner.novelSourceItemLabel.create({ data: { novelSourceItemId: source.id, sourceLabelId: moboAgencyLabel.id } });
    plotBooks.push({ novel, source });
  }
  const promos = [];
  for (const [index, { novel, source }] of plotBooks.entries()) {
    if (!novel) continue;
    promos.push(await seedPromo({
      appId: ids.moboApp, novelId: novel.id, sourceId: source.id,
      status: index === 3 ? "pending" : "fetched", // 一条在排队
      upstreamCode: index === 3 ? null : `9600${index}`,
    }));
  }
  // 一条已经领取过的副作用意图（意图记着推广链接的幂等键——改挂必须让它跟着换键）
  const intentedPromo = promos[0]!;
  const intent = await owner.sideEffectIntent.create({
    data: {
      effectKey: "a".repeat(64), operationType: "promo_link.claim_promo", idempotencyKey: "a".repeat(64),
      targetType: "promo_link", targetId: intentedPromo.idempotencyKey.trim(),
      channelAccountId: ids.account, channelAppId: ids.moboApp, promoLinkId: intentedPromo.id,
      status: "manual_review_required", requestSummary: { novelSourceItemId: plotBooks[0]!.source.id },
    },
  });

  // MoboReader 自己的书（不能被动到）
  const moboBooks = [];
  for (let index = 1; index <= 3; index += 1) {
    const { novel, source } = await seedBook({
      appId: ids.moboApp, externalBookId: `mobo-${index}`, title: `Mobo Book ${index}`, agencyId: MOBO_AGENCY,
    });
    await owner.$executeRawUnsafe(`UPDATE novel_source_item SET raw_language_scope = $1 WHERE id = '${source.id}'`, SCOPE);
    await owner.novelSourceItemLabel.create({ data: { novelSourceItemId: source.id, sourceLabelId: moboLabel.id } });
    const promo = await seedPromo({ appId: ids.moboApp, novelId: novel!.id, sourceId: source.id, upstreamCode: `M${index}`, webUrl: `https://example.test/${index}` });
    moboBooks.push({ novel, source, promo });
  }
  if (options.pending) {
    // 在途的领取任务条目引用了 plot-1
    const task = await owner.genericTask.create({
      data: {
        taskType: "promo_link.claim.v1", channelAccountId: ids.account, channelAppId: ids.moboApp,
        operationScopeHash: "b".repeat(64), mode: "apply", status: "pending", requestToken: randomUUID(), totalCount: 1,
        items: { create: [{ targetType: "novel_source_item", targetId: plotBooks[0]!.source.id, status: "pending", payload: {} }] },
      },
    });
    return { admin, tag, plotBooks, promos, intent, moboBooks, moboLabel, task };
  }
  return { admin, tag, plotBooks, promos, intent, moboBooks, moboLabel, task: null };
}

const APPLY = (extra: Partial<RehomeOptions> = {}): RehomeOptions => ({
  apply: true,
  operatorId: "release-operator",
  requestId: `rehome-${randomUUID()}`,
  reason: "v0.6.0 PlotNovel rehome",
  confirm: REHOME_CONFIRM_PHRASE,
  expectedSourceItems: 5,
  expectedPromoLinks: 4,
  ...extra,
});

const DRY = (): RehomeOptions => ({ apply: false, operatorId: "op", requestId: "dry", reason: "dry" });

/** 一份足以发现任何写入的快照（行数 + 关键列指纹）。 */
async function snapshot() {
  const [items, promos, intents, labels, links, edges, audits] = await Promise.all([
    owner.novelSourceItem.findMany({ orderBy: { id: "asc" }, select: { id: true, channelAppId: true, updatedAt: true } }),
    owner.promoLink.findMany({ orderBy: { id: "asc" }, select: { id: true, channelAppId: true, idempotencyKey: true, updatedAt: true } }),
    owner.sideEffectIntent.findMany({ orderBy: { id: "asc" }, select: { id: true, channelAppId: true, targetId: true, status: true } }),
    owner.sourceLabel.count(),
    owner.novelSourceItemLabel.findMany({ orderBy: [{ novelSourceItemId: "asc" }, { sourceLabelId: "asc" }] }),
    owner.sourceLabelMapping.count(),
    owner.operationAudit.count(),
  ]);
  return JSON.stringify({ items, promos, intents, labels, links, edges, audits });
}

describe.skipIf(!enabled).sequential("v0.6.0 C：存量改挂（真实库）", () => {
  beforeAll(assertDisposableDatabase);
  beforeEach(truncateDatabase);
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), scheduler.$disconnect(), analyst.$disconnect()]);
  });

  it("预演：只读，如实盘点各类计数，不写任何东西", async () => {
    await seedWorld();
    const before = await snapshot();
    const report = await rehomePlotnovelSourceItems(worker, DRY());
    expect(report.mode).toBe("dry-run");
    expect(report.blocked).toBe(false);
    expect(report.agencyIds).toEqual([PLOT_AGENCY]);
    expect(report.counts).toMatchObject({
      sourceItems: 5,
      sourceItemsAlreadyAtTarget: 0,
      promoLinks: 4,
      promoLinksByStatus: { fetched: 3, pending: 1 },
      sideEffectIntents: 1,
      labelLinks: 10, // 5 本 × (series_type + agency)
      sourceLabelsToCreate: 2,
      mappingEdgesToCopy: 1,
    });
    expect(await snapshot()).toBe(before);
  });

  it("执行：书目与推广链接改挂、幂等键重算、意图跟着换键、标签与映射复制，MoboReader 自己的书原封不动", async () => {
    const world = await seedWorld();
    const moboBefore = JSON.stringify(await Promise.all(world.moboBooks.map(async ({ source, promo }) => ({
      source: await owner.novelSourceItem.findUniqueOrThrow({ where: { id: source.id } }),
      promo: await owner.promoLink.findUniqueOrThrow({ where: { id: promo.id } }),
    }))));

    const report = await rehomePlotnovelSourceItems(worker, APPLY());
    expect(report.noop).toBe(false);
    expect(report.applied).toMatchObject({
      rehomedSourceItems: 5, rehomedPromoLinks: 4, rekeyedPromoLinks: 4, updatedSideEffectIntents: 1,
      repointedLabelLinks: 10, createdSourceLabels: 2, copiedMappingEdges: 1,
    });

    // 书目
    const plotItems = await owner.novelSourceItem.findMany({ where: { externalAgencyId: PLOT_AGENCY } });
    expect(plotItems).toHaveLength(5);
    expect(plotItems.every((item) => item.channelAppId === ids.plotApp)).toBe(true);

    // 推广链接：剧场改了，幂等键 = 新剧场算出来的键（领取 handler 用同一个函数找这一行）
    const promos = await owner.promoLink.findMany({ where: { id: { in: world.promos.map((promo) => promo.id) } } });
    expect(promos).toHaveLength(4);
    for (const promo of promos) {
      expect(promo.channelAppId).toBe(ids.plotApp);
      expect(promo.idempotencyKey.trim()).toBe(buildPromoLinkIdempotencyKey({
        channelAppId: ids.plotApp, novelSourceItemId: promo.novelSourceItemId, channelAccountId: ids.account, offerType: "read",
      }));
    }
    const found = await owner.promoLink.findUnique({
      where: {
        idempotencyKey: buildPromoLinkIdempotencyKey({
          channelAppId: ids.plotApp, novelSourceItemId: world.plotBooks[0]!.source.id, channelAccountId: ids.account, offerType: "read",
        }),
      },
    });
    expect(found?.id).toBe(world.promos[0]!.id);
    // 公开跳转码、口令码一字不动
    expect(promos.find((promo) => promo.id === world.promos[0]!.id)).toMatchObject({
      publicRedirectCode: world.promos[0]!.publicRedirectCode, upstreamCode: "96000", status: "fetched",
    });

    // 副作用意图：目标键换成新键、剧场改挂，状态与其它列不变
    const intent = await owner.sideEffectIntent.findUniqueOrThrow({ where: { id: world.intent.id } });
    expect(intent).toMatchObject({ channelAppId: ids.plotApp, status: "manual_review_required", promoLinkId: world.promos[0]!.id });
    expect(intent.targetId).toBe(found!.idempotencyKey.trim());

    // 标签：PlotNovel 下有了自己的字典，书目的关联指向它；MoboReader 的字典与它自己的书不受影响
    const plotLabels = await owner.sourceLabel.findMany({ where: { channelAppId: ids.plotApp } });
    expect(plotLabels.map((label) => `${label.labelKind}:${label.externalLabelValue}`).sort()).toEqual(["agency:1351", "series_type:Romance"]);
    expect(plotLabels.find((label) => label.labelKind === "agency")?.displayValue).toBe("PlotNovel");
    expect(await owner.novelSourceItemLabel.count({
      where: { novelSourceItemId: { in: plotItems.map((item) => item.id) }, sourceLabel: { channelAppId: ids.moboApp } },
    })).toBe(0);
    expect(await owner.novelSourceItemLabel.count({ where: { sourceLabel: { channelAppId: ids.plotApp } } })).toBe(10);
    // 映射边复制（不是移动）
    expect(await owner.sourceLabelMapping.count({ where: { channelAppId: ids.moboApp } })).toBe(1);
    expect(await owner.sourceLabelMapping.count({ where: { channelAppId: ids.plotApp } })).toBe(1);

    // MoboReader 的书：书目、推广链接逐列不变
    const moboAfter = JSON.stringify(await Promise.all(world.moboBooks.map(async ({ source, promo }) => ({
      source: await owner.novelSourceItem.findUniqueOrThrow({ where: { id: source.id } }),
      promo: await owner.promoLink.findUniqueOrThrow({ where: { id: promo.id } }),
    }))));
    expect(moboAfter).toBe(moboBefore);

    // 审计
    const audit = await owner.operationAudit.findFirstOrThrow({ where: { action: REHOME_AUDIT_ACTION } });
    expect(audit).toMatchObject({ actorType: "system", actorId: "release-operator", entityId: ids.plotApp });
    expect(String(audit.id)).toBe(report.applied!.auditId);
  });

  it("拒绝：期望数量不符 → 一行不写", async () => {
    await seedWorld();
    const before = await snapshot();
    await expect(rehomePlotnovelSourceItems(worker, APPLY({ expectedSourceItems: 4 }))).rejects.toMatchObject({ code: "count_mismatch" });
    await expect(rehomePlotnovelSourceItems(worker, APPLY({ expectedPromoLinks: 5 }))).rejects.toMatchObject({ code: "count_mismatch" });
    expect(await snapshot()).toBe(before);
  });

  it("拒绝：缺确认短语 / 缺期望数量 / 确认短语不对 → 不连数据库就拒绝", async () => {
    await seedWorld();
    const before = await snapshot();
    for (const bad of [
      APPLY({ confirm: undefined }),
      APPLY({ confirm: "yes" }),
      APPLY({ expectedSourceItems: undefined }),
      APPLY({ expectedPromoLinks: undefined }),
    ]) {
      await expect(rehomePlotnovelSourceItems(worker, bad)).rejects.toBeInstanceOf(RehomeRefusedError);
    }
    expect(await snapshot()).toBe(before);
  });

  it("拒绝：这批书还有未完成的领取任务条目 → 列出明细，一行不写", async () => {
    await seedWorld({ pending: true });
    const before = await snapshot();
    const error = await rehomePlotnovelSourceItems(worker, APPLY()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RehomeRefusedError);
    expect((error as RehomeRefusedError).code).toBe("gate_unfinished_tasks");
    const detail = (error as RehomeRefusedError).detail as { pendingGenericTaskItems: { total: number; sample: Array<Record<string, unknown>> } };
    expect(detail.pendingGenericTaskItems.total).toBe(1);
    expect(detail.pendingGenericTaskItems.sample[0]).toMatchObject({ task_type: "promo_link.claim.v1", item_status: "pending" });
    expect(await snapshot()).toBe(before);

    // 预演同样把它列出来并标记 blocked
    const dry = await rehomePlotnovelSourceItems(worker, DRY());
    expect(dry.blocked).toBe(true);
    expect(dry.blockers.pendingGenericTaskItems.total).toBe(1);
  });

  it("拒绝：processing 的任务条目、进行中的试读条目、进行中的目录扫描，一样挡住", async () => {
    const world = await seedWorld();
    const before = await snapshot();

    // processing 的物化条目
    const materialize = await owner.genericTask.create({
      data: {
        taskType: "novel.materialize.v1", operationScopeHash: "c".repeat(64), mode: "apply", status: "processing",
        requestToken: randomUUID(), totalCount: 1,
        items: {
          create: [{
            targetType: "novel_source_item", targetId: world.plotBooks[1]!.source.id, status: "processing", payload: {},
            attemptCount: 1, executionToken: randomUUID(), leaseEpoch: 1n, lockedBy: "some-worker",
            lockedUntil: new Date(Date.now() + 60_000), heartbeatAt: new Date(), startedAt: new Date(),
          }],
        },
      },
    });
    await expect(rehomePlotnovelSourceItems(worker, APPLY())).rejects.toMatchObject({ code: "gate_unfinished_tasks" });
    await owner.genericTask.delete({ where: { id: materialize.id } });

    // 进行中的试读条目
    const sync = await owner.channelSyncTask.create({
      data: {
        taskType: "moboreader.preview_refresh.v1", channelAccountId: ids.account, channelAppId: ids.moboApp,
        operationScopeHash: "d".repeat(64), mode: "apply", status: "pending", requestToken: randomUUID(), totalCount: 1,
        items: { create: [{ novelSourceItemId: world.plotBooks[2]!.source.id, status: "pending" }] },
      },
    });
    const dry = await rehomePlotnovelSourceItems(worker, DRY());
    expect(dry.blockers.pendingSyncTaskItems.total).toBe(1);
    await expect(rehomePlotnovelSourceItems(worker, APPLY())).rejects.toMatchObject({ code: "gate_unfinished_tasks" });
    await owner.channelSyncTask.delete({ where: { id: sync.id } });

    // 进行中的目录扫描
    const scan = await owner.genericTask.create({
      data: {
        taskType: "catalog_scan", channelAccountId: ids.account, channelAppId: ids.moboApp,
        operationScopeHash: "e".repeat(64), mode: "apply", status: "processing", requestToken: randomUUID(), totalCount: 0,
      },
    });
    await expect(rehomePlotnovelSourceItems(worker, APPLY())).rejects.toMatchObject({ code: "gate_unfinished_tasks" });
    await owner.genericTask.delete({ where: { id: scan.id } });

    expect(await snapshot()).toBe(before);
    // 清掉全部拦截后可以正常执行
    await expect(rehomePlotnovelSourceItems(worker, APPLY())).resolves.toMatchObject({ noop: false });
  });

  it("已结束的任务条目不挡路（历史记录不是拦截项）", async () => {
    const world = await seedWorld();
    await owner.genericTask.create({
      data: {
        taskType: "promo_link.claim.v1", channelAccountId: ids.account, channelAppId: ids.moboApp,
        operationScopeHash: "f".repeat(64), mode: "apply", status: "completed", requestToken: randomUUID(), totalCount: 1,
        items: { create: [{ targetType: "novel_source_item", targetId: world.plotBooks[0]!.source.id, status: "success", payload: {} }] },
      },
    });
    await expect(rehomePlotnovelSourceItems(worker, APPLY())).resolves.toMatchObject({ noop: false });
  });

  it("拒绝：已发布的文章正挂在这批推广链接上（公开网址冻结）→ 列出明细，一行不写；草稿 / 下架的不挡路", async () => {
    const world = await seedWorld();
    const novel = world.plotBooks[1]!.novel!;
    const promo = world.promos[1]!;
    const article = await owner.article.create({
      data: {
        novelId: novel.id, promoLinkId: promo.id, locale: "en", slug: "already-public-slug", publicPageShortId: "palreadypub1",
        title: "Already public", summary: "s", body: `Read it at /go/${promo.publicRedirectCode}`,
        status: "published", articleType: "novel_article", publishedAt: new Date(),
      },
    });
    const before = await snapshot();
    const error = await rehomePlotnovelSourceItems(worker, APPLY()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RehomeRefusedError);
    expect((error as RehomeRefusedError).code).toBe("gate_published_pages");
    const detail = (error as RehomeRefusedError).detail as { publishedArticles: { total: number; sample: Array<Record<string, unknown>> } };
    expect(detail.publishedArticles.total).toBe(1);
    expect(detail.publishedArticles.sample[0]).toMatchObject({ article_id: article.id, locale: "en", promo_link_id: promo.id });
    expect(await snapshot()).toBe(before);

    const dry = await rehomePlotnovelSourceItems(worker, DRY());
    expect(dry.blocked).toBe(true);
    expect(dry.blockers.publishedArticles.total).toBe(1);

    // 不是"已发布"的文章（草稿 / 已下架）不挡路——挡的是会让已公开页面可见性变化的情形
    await owner.article.update({ where: { id: article.id }, data: { status: "draft", publishedAt: null } });
    expect((await rehomePlotnovelSourceItems(worker, DRY())).blocked).toBe(false);
    await owner.article.update({ where: { id: article.id }, data: { status: "takedown" } });
    await expect(rehomePlotnovelSourceItems(worker, APPLY())).resolves.toMatchObject({ noop: false });
  });

  it("拒绝：目标剧场下已有同 (外部书号, 语种码) 的书目 → 唯一键冲突，一行不写", async () => {
    await seedWorld();
    await seedBook({ appId: ids.plotApp, externalBookId: "plot-1", title: "Duplicate of plot-1", agencyId: PLOT_AGENCY });
    const before = await snapshot();
    await expect(rehomePlotnovelSourceItems(worker, APPLY())).rejects.toMatchObject({ code: "gate_unique_conflict" });
    expect(await snapshot()).toBe(before);
  });

  it("拒绝：推广链接的剧场与它的书目不一致（历史数据异常，不敢动）", async () => {
    const world = await seedWorld();
    await owner.promoLink.update({ where: { id: world.promos[1]!.id }, data: { channelAppId: ids.plotApp } });
    const before = await snapshot();
    await expect(rehomePlotnovelSourceItems(worker, APPLY())).rejects.toMatchObject({ code: "gate_data_anomaly" });
    expect(await snapshot()).toBe(before);
  });

  it("重复执行：第二次候选为 0，改挂 0 行、不写审计，即使带着同样的期望数量", async () => {
    await seedWorld();
    await rehomePlotnovelSourceItems(worker, APPLY());
    const before = await snapshot();
    const again = await rehomePlotnovelSourceItems(worker, APPLY());
    expect(again).toMatchObject({ noop: true, applied: null, counts: { sourceItems: 0, promoLinks: 0, sourceItemsAlreadyAtTarget: 5 } });
    expect(await snapshot()).toBe(before);
    expect(await owner.operationAudit.count({ where: { action: REHOME_AUDIT_ACTION } })).toBe(1);
  });

  it("同一个 request-id 在还有书要挪时重放：拒绝", async () => {
    await seedWorld();
    const requestId = "rehome-fixed-request";
    await expect(rehomePlotnovelSourceItems(worker, APPLY({ requestId, expectedSourceItems: 5 }))).resolves.toMatchObject({ noop: false });
    // 造一本新的待改挂书目，再用同一个 request-id
    await seedBook({ appId: ids.moboApp, externalBookId: "plot-late", title: "Late", agencyId: PLOT_AGENCY, linked: false });
    await expect(rehomePlotnovelSourceItems(worker, APPLY({ requestId, expectedSourceItems: 1, expectedPromoLinks: 0 })))
      .rejects.toMatchObject({ code: "request_replay_conflict" });
  });

  it("目标剧场不是口令码模式 / 没登记 → 拒绝执行", async () => {
    await seedWorld();
    await owner.channelApp.update({ where: { id: ids.plotApp }, data: { config: { promoMode: "link", agencyIds: [PLOT_AGENCY] } } });
    await expect(rehomePlotnovelSourceItems(worker, DRY())).rejects.toMatchObject({ code: "theater_not_ready" });
    await expect(rehomePlotnovelSourceItems(worker, APPLY())).rejects.toMatchObject({ code: "theater_not_ready" });
  });

  it("改挂 + 打开新剧场之后，标签投影对账零差异：上游映射分类没有因为改挂而消失", async () => {
    const world = await seedWorld();
    // 改挂前先让投影与规则一致
    await reconcileAllEffectiveTags(worker);
    const before = await owner.novelEffectiveTag.findMany({ orderBy: [{ novelId: "asc" }, { canonicalTagId: "asc" }] });
    expect(before.filter((row) => row.provenance === "mapped").length).toBe(world.plotBooks.filter((b) => b.novel).length + world.moboBooks.length);

    await rehomePlotnovelSourceItems(worker, APPLY());
    // 刚改挂、新剧场还没打开：按规则这批书暂时没有映射归属——这正是手册规定要先打开再对账的原因
    const whileClosed = await checkEffectiveTags(worker);
    expect(whileClosed.missing + whileClosed.extra + whileClosed.changed).toBeGreaterThan(0);

    await owner.channelApp.update({ where: { id: ids.plotApp }, data: { status: "active" } });
    const afterOpen = await checkEffectiveTags(worker);
    expect(afterOpen).toMatchObject({ missing: 0, extra: 0, changed: 0 });
    expect(await owner.novelEffectiveTag.findMany({ orderBy: [{ novelId: "asc" }, { canonicalTagId: "asc" }] })).toEqual(before);
  }, 30_000);
});
