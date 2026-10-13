import { describe, expect, it } from "vitest";

import {
  MAX_TALLIED_UNMAPPED_AGENCIES,
  buildCatalogRouting,
  emptyCatalogRoutingTally,
  loadCatalogRouting,
  recordCatalogRouting,
} from "@/lib/tasks/catalog-agency-routing";
import { sumAgencyRouting } from "../../../worker/handlers/moboreader";

type App = Parameters<typeof buildCatalogRouting>[0];

function app(id: string, code: string, config: unknown, overrides: Partial<App> = {}): App {
  return { id, channelId: "channel-1", projectType: 1, config, sourceApp: { code }, ...overrides } as App;
}

const MOBO = app("app-mobo", "moboreader", { promoMode: "link", agencyIds: ["3366"] });
const PLOT = app("app-plot", "plotnovel", { promoMode: "code", agencyIds: ["1351"], codeModeLocales: ["en"] });

describe("目录扫描按机构分流", () => {
  it("机构 1351 → PlotNovel，机构 3366 → MoboReader，不论任务建在哪个剧场下", () => {
    for (const taskApp of [MOBO, PLOT]) {
      const routing = buildCatalogRouting(taskApp, [MOBO, PLOT]);
      expect(routing.resolve("1351")).toMatchObject({
        route: { channelAppId: "app-plot", sourceAppCode: "plotnovel", promoMode: "code" },
        mapped: true,
        fallbackReason: null,
      });
      expect(routing.resolve("3366")).toMatchObject({
        route: { channelAppId: "app-mobo", sourceAppCode: "moboreader", promoMode: "link" },
        mapped: true,
      });
    }
  });

  it("找不到对应剧场的机构：仍落在任务剧场下（不丢数据），并标记为未映射", () => {
    const routing = buildCatalogRouting(MOBO, [MOBO, PLOT]);
    expect(routing.resolve("9999")).toMatchObject({
      route: { channelAppId: "app-mobo" },
      mapped: false,
      fallbackReason: "unmapped_agency",
    });
  });

  it.each([null, undefined, "", "   "])("没有机构编号（%j）：落在任务剧场下", (agencyId) => {
    const routing = buildCatalogRouting(MOBO, [MOBO, PLOT]);
    expect(routing.resolve(agencyId)).toMatchObject({ route: { channelAppId: "app-mobo" }, mapped: false, fallbackReason: "no_agency_id" });
  });

  it("新登记、尚未打开的剧场（不在 active 列表里）不参与分流：1351 退回任务剧场，与改动前一致", () => {
    const routing = buildCatalogRouting(MOBO, [MOBO]); // PlotNovel 还是 registered_disabled，查询没把它选出来
    expect(routing.resolve("1351")).toMatchObject({ route: { channelAppId: "app-mobo" }, mapped: false });
    expect(routing.routableChannelAppIds).toEqual(["app-mobo"]);
  });

  it("同一个机构编号被两个 active 剧场同时声明：不猜，退回任务剧场并标记 ambiguous", () => {
    const clash = app("app-clash", "other", { agencyIds: ["1351"] });
    const routing = buildCatalogRouting(MOBO, [MOBO, PLOT, clash]);
    expect(routing.resolve("1351")).toMatchObject({ route: { channelAppId: "app-mobo" }, mapped: false, fallbackReason: "ambiguous_agency" });
    // 没有冲突的机构不受影响
    expect(routing.resolve("3366")).toMatchObject({ mapped: true });
  });

  it("不同渠道 / 不同 projectType 的剧场永远不参与（账号与凭据不通用）", () => {
    const otherChannel = app("app-x", "x", { agencyIds: ["777"] }, { channelId: "channel-2" });
    const otherProject = app("app-y", "y", { agencyIds: ["888"] }, { projectType: 2 });
    const routing = buildCatalogRouting(MOBO, [MOBO, PLOT, otherChannel, otherProject]);
    expect(routing.resolve("777").mapped).toBe(false);
    expect(routing.resolve("888").mapped).toBe(false);
    expect(routing.routableChannelAppIds).not.toContain("app-x");
    expect(routing.routableChannelAppIds).not.toContain("app-y");
  });

  it("没配 agencyIds 的剧场（旧记录 config = {}）：什么机构都不认领，行为与改动前一致", () => {
    const legacyMobo = app("app-mobo", "moboreader", {});
    const routing = buildCatalogRouting(legacyMobo, [legacyMobo]);
    expect(routing.resolve("3366")).toMatchObject({ route: { channelAppId: "app-mobo" }, mapped: false });
    expect(routing.taskRoute.promoMode).toBe("link");
  });

  it("任务剧场自己的 promoMode 缺省 = link", () => {
    expect(buildCatalogRouting(app("a", "moboreader", {}), []).taskRoute.promoMode).toBe("link");
  });
});

describe("loadCatalogRouting（读库形状）", () => {
  it("只查同渠道、同 projectType、active 的剧场；任务剧场不存在则抛错", async () => {
    const calls: Array<{ kind: string; args: unknown }> = [];
    const db = {
      channelApp: {
        findUnique: async (args: unknown) => { calls.push({ kind: "findUnique", args }); return MOBO; },
        findMany: async (args: unknown) => { calls.push({ kind: "findMany", args }); return [MOBO, PLOT]; },
      },
    };
    const routing = await loadCatalogRouting(db as never, "app-mobo");
    expect(routing.resolve("1351").route.channelAppId).toBe("app-plot");
    expect(calls[1]!.args).toMatchObject({
      where: {
        channelId: "channel-1",
        projectType: 1,
        status: "active",
        channel: { status: "active" },
        sourceApp: { status: "active" },
      },
    });

    const missing = { channelApp: { findUnique: async () => null, findMany: async () => [] } };
    await expect(loadCatalogRouting(missing as never, "nope")).rejects.toThrow("catalog_task_app_missing");
  });
});

describe("分流统计", () => {
  it("按剧场计数；未映射的书与新机构编号分别计数；不同新机构编号最多记 20 个", () => {
    const routing = buildCatalogRouting(MOBO, [MOBO, PLOT]);
    const tally = emptyCatalogRoutingTally();
    recordCatalogRouting(tally, routing.resolve("3366"), "3366");
    recordCatalogRouting(tally, routing.resolve("1351"), "1351");
    recordCatalogRouting(tally, routing.resolve("1351"), "1351");
    recordCatalogRouting(tally, routing.resolve("9999"), "9999");
    recordCatalogRouting(tally, routing.resolve(null), null);
    expect(tally).toEqual({
      routedByChannelApp: { "app-mobo": 3, "app-plot": 2 },
      unmappedBooks: 2,
      unmappedAgencies: { "9999": 1 },
      ambiguousBooks: 0,
    });

    const many = emptyCatalogRoutingTally();
    for (let index = 0; index < MAX_TALLIED_UNMAPPED_AGENCIES + 5; index += 1) {
      recordCatalogRouting(many, routing.resolve(`x${index}`), `x${index}`);
    }
    expect(Object.keys(many.unmappedAgencies)).toHaveLength(MAX_TALLIED_UNMAPPED_AGENCIES);
    expect(many.unmappedBooks).toBe(MAX_TALLIED_UNMAPPED_AGENCIES + 5);
  });

  it("sumAgencyRouting：累加各页，丢弃不认识的形状（旧页没有这个字段）", () => {
    const total = sumAgencyRouting([
      { routedByChannelApp: { a: 2, b: 1 }, unmappedBooks: 1, unmappedAgencies: { "9999": 1 }, ambiguousBooks: 0 },
      { routedByChannelApp: { a: 3 }, unmappedBooks: 0, unmappedAgencies: {}, ambiguousBooks: 2 },
      undefined,
      null,
      "garbage",
      { routedByChannelApp: { a: -5, c: "x" }, unmappedBooks: "1" },
    ]);
    expect(total).toEqual({
      routedByChannelApp: { a: 5, b: 1 },
      unmappedBooks: 1,
      unmappedAgencies: { "9999": 1 },
      ambiguousBooks: 2,
    });
  });
});
