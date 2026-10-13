import { describe, expect, it } from "vitest";

import { MOBOREADER_FOUNDATION } from "../../../scripts/register-moboreader-foundation";
import {
  PLOTNOVEL_AUDIT_ACTIONS,
  PLOTNOVEL_THEATER,
  PlotnovelTheaterError,
  parseCliOptions,
  planPlotnovelRegistration,
  registerPlotnovelTheater,
  type RegisterTheaterOptions,
  type TheaterSnapshot,
} from "../../../scripts/register-plotnovel-theater";
import { parseTheaterPromoConfig } from "../../../src/server/publication/theater-promo-mode";

type Row = Record<string, unknown>;
type State = {
  channels: Row[];
  sourceApps: Row[];
  channelApps: Row[];
  capabilities: Row[];
  audits: Row[];
  nextId: number;
};

class FakeTheaterDb {
  state: State = { channels: [], sourceApps: [], channelApps: [], capabilities: [], audits: [], nextId: 1 };
  calls: string[] = [];
  failAudit = false;

  constructor() {
    // MoboReader 地基已经登记（生产现状：config 还是 {}）。
    this.state.channels.push({ id: "channel-1", ...MOBOREADER_FOUNDATION.channel });
    this.state.sourceApps.push({ id: "source-mobo", ...MOBOREADER_FOUNDATION.sourceApp });
    this.state.channelApps.push({
      id: "app-mobo",
      channelId: "channel-1",
      sourceAppId: "source-mobo",
      ...MOBOREADER_FOUNDATION.channelApp,
      config: {},
    });
  }

  private id(prefix: string): string {
    const id = `${prefix}-${this.state.nextId}`;
    this.state.nextId += 1;
    return id;
  }

  private client() {
    return {
      channel: {
        findUnique: async (args: { where: { code: string } }) =>
          this.state.channels.find((row) => row.code === args.where.code) ?? null,
      },
      sourceApp: {
        findUnique: async (args: { where: { code: string } }) =>
          this.state.sourceApps.find((row) => row.code === args.where.code) ?? null,
        create: async (args: { data: Row }) => {
          this.calls.push("sourceApp.create");
          const row = { id: this.id("source"), ...args.data };
          this.state.sourceApps.push(row);
          return row;
        },
      },
      channelApp: {
        findUnique: async (args: {
          where: { channelId_sourceAppId_externalAppId: { channelId: string; sourceAppId: string; externalAppId: string } };
        }) => {
          const key = args.where.channelId_sourceAppId_externalAppId;
          return this.state.channelApps.find(
            (row) => row.channelId === key.channelId && row.sourceAppId === key.sourceAppId && row.externalAppId === key.externalAppId,
          ) ?? null;
        },
        create: async (args: { data: Row }) => {
          this.calls.push("channelApp.create");
          const row = { id: this.id("app"), ...args.data };
          this.state.channelApps.push(row);
          return row;
        },
        update: async (args: { where: { id: string }; data: Row }) => {
          this.calls.push("channelApp.update");
          const row = this.state.channelApps.find((candidate) => candidate.id === args.where.id)!;
          Object.assign(row, args.data);
          return row;
        },
      },
      channelCapability: {
        findMany: async (args: { where: { channelAppId: string } }) =>
          this.state.capabilities.filter((row) => row.channelAppId === args.where.channelAppId),
        create: async (args: { data: Row }) => {
          this.calls.push("channelCapability.create");
          const row = { id: this.id("capability"), ...args.data };
          this.state.capabilities.push(row);
          return row;
        },
      },
      operationAudit: {
        findFirst: async (args: { where: { actorType: string; action: string; requestId: string } }) =>
          this.state.audits.find(
            (row) => row.actorType === args.where.actorType && row.action === args.where.action && row.requestId === args.where.requestId,
          ) ?? null,
        create: async (args: { data: Row }) => {
          if (this.failAudit) throw new Error("audit insert failed");
          const row = { id: BigInt(this.state.nextId), ...args.data };
          this.state.nextId += 1;
          this.state.audits.push(row);
          return row;
        },
      },
      $queryRaw: async () => {
        this.calls.push("pg_advisory_xact_lock");
        return [{ pg_advisory_xact_lock: null }];
      },
    };
  }

  readonly channel = this.client().channel;
  readonly sourceApp = this.client().sourceApp;
  readonly channelApp = this.client().channelApp;
  readonly channelCapability = this.client().channelCapability;

  readonly $transaction = async <T>(callback: (tx: ReturnType<FakeTheaterDb["client"]>) => Promise<T>) => {
    const before = structuredClone(this.state);
    try {
      return await callback(this.client());
    } catch (error) {
      this.state = before;
      throw error;
    }
  };

  asDb(): Parameters<typeof registerPlotnovelTheater>[0] {
    return this as unknown as Parameters<typeof registerPlotnovelTheater>[0];
  }

  get plotnovelApp(): Row | undefined {
    return this.state.channelApps.find((row) => row.externalAppId === "plotnovel");
  }

  get moboreaderApp(): Row {
    return this.state.channelApps.find((row) => row.externalAppId === "moboreader")!;
  }
}

const APPLY: RegisterTheaterOptions = {
  apply: true,
  operatorId: "release-operator",
  requestId: "v060-register-1",
  reason: "register the PlotNovel code-mode theater",
  storeLinks: {},
};

describe("PlotNovel 剧场登记：冻结内容", () => {
  it("配置内容与 Owner 拍板一致：口令码模式、机构 1351、只对英语开放；MoboReader 回填 link / 3366", () => {
    expect(PLOTNOVEL_THEATER.sourceApp).toMatchObject({ code: "plotnovel", name: "PlotNovel" });
    expect(PLOTNOVEL_THEATER.channelApp.externalAppId).toBe("plotnovel");
    expect(PLOTNOVEL_THEATER.channelApp.initialStatus).toBe("registered_disabled");
    expect(PLOTNOVEL_THEATER.config).toEqual({
      promoMode: "code",
      agencyIds: ["1351"],
      appDisplayName: "PlotNovel",
      codeModeLocales: ["en"],
    });
    expect(PLOTNOVEL_THEATER.moboreaderConfigPatch).toEqual({ promoMode: "link", agencyIds: ["3366"] });
  });
});

describe("registerPlotnovelTheater", () => {
  it("默认只读预演：什么都不写，但如实报出要建什么、要补什么", async () => {
    const db = new FakeTheaterDb();
    const report = await registerPlotnovelTheater(db.asDb(), { ...APPLY, apply: false });
    expect(report.mode).toBe("dry-run");
    expect(report.wrote).toBe(false);
    expect(report.create).toEqual([
      "source_app:plotnovel",
      "channel_app:changdu/plotnovel/plotnovel",
      "channel_capability:plotnovel/getlistpc",
      "channel_capability:plotnovel/getbydataid",
      "channel_capability:plotnovel/getchapterinfo",
      "channel_capability:plotnovel/claimPromo",
    ]);
    expect(report.moboreaderConfigPatch).toEqual({ promoMode: "link", agencyIds: ["3366"] });
    expect(db.calls.filter((call) => call.endsWith(".create") || call.endsWith(".update"))).toEqual([]);
    expect(db.state.audits).toHaveLength(0);
  });

  it("--apply：新剧场默认停用、四条能力全部 registered_disabled，config 带口令码模式与机构编号，同事务写审计", async () => {
    const db = new FakeTheaterDb();
    const report = await registerPlotnovelTheater(db.asDb(), APPLY);
    expect(report.wrote).toBe(true);

    const app = db.plotnovelApp!;
    expect(app.status).toBe("registered_disabled");
    expect(app.projectType).toBe(MOBOREADER_FOUNDATION.channelApp.projectType);
    expect(app.channelId).toBe("channel-1");
    expect(app.config).toEqual({
      promoMode: "code",
      agencyIds: ["1351"],
      appDisplayName: "PlotNovel",
      codeModeLocales: ["en"],
    });
    expect(parseTheaterPromoConfig(app.config).promoMode).toBe("code");

    expect(db.moboreaderApp.config).toEqual({ promoMode: "link", agencyIds: ["3366"] });
    expect(db.moboreaderApp.status).toBe("active");

    const capabilities = db.state.capabilities.filter((row) => row.channelAppId === app.id);
    expect(capabilities.map((row) => row.capabilityKey).sort()).toEqual(["claimPromo", "getbydataid", "getchapterinfo", "getlistpc"]);
    expect(capabilities.every((row) => row.status === "registered_disabled")).toBe(true);

    expect(db.state.audits.map((row) => row.action).sort()).toEqual(
      [PLOTNOVEL_AUDIT_ACTIONS.moboreaderConfig, PLOTNOVEL_AUDIT_ACTIONS.register].sort(),
    );
    expect(db.state.audits.every((row) => row.actorId === "release-operator" && row.requestId === "v060-register-1")).toBe(true);
    expect(db.calls.indexOf("pg_advisory_xact_lock")).toBeLessThan(db.calls.indexOf("sourceApp.create"));
  });

  it("绝不创建 enabled 的能力记录", async () => {
    const db = new FakeTheaterDb();
    await registerPlotnovelTheater(db.asDb(), APPLY);
    expect(db.state.capabilities.filter((row) => row.status === "enabled")).toHaveLength(0);
  });

  it("幂等：第二次 --apply 零写入、零审计", async () => {
    const db = new FakeTheaterDb();
    await registerPlotnovelTheater(db.asDb(), APPLY);
    const auditsAfterFirst = db.state.audits.length;
    db.calls.length = 0;
    const second = await registerPlotnovelTheater(db.asDb(), { ...APPLY, requestId: "v060-register-2" });
    expect(second.wrote).toBe(false);
    expect(db.state.audits).toHaveLength(auditsAfterFirst);
    expect(db.calls.filter((call) => call.endsWith(".create") || call.endsWith(".update"))).toEqual([]);
  });

  it("审计写不进去就整体回滚：不留半个剧场", async () => {
    const db = new FakeTheaterDb();
    db.failAudit = true;
    await expect(registerPlotnovelTheater(db.asDb(), APPLY)).rejects.toThrow("audit insert failed");
    expect(db.plotnovelApp).toBeUndefined();
    expect(db.state.sourceApps.filter((row) => row.code === "plotnovel")).toHaveLength(0);
    expect(db.state.capabilities).toHaveLength(0);
    expect(db.moboreaderApp.config).toEqual({});
  });

  it("商店链接：建时写入；之后改链接只更新 config 并各写一条审计；none 清空；相同值零写入", async () => {
    const db = new FakeTheaterDb();
    await registerPlotnovelTheater(db.asDb(), {
      ...APPLY,
      storeLinks: { appStoreUrl: "https://apps.apple.com/app/plotnovel/id123", googlePlayUrl: "https://play.google.com/store/apps/details?id=x.y" },
    });
    expect(db.plotnovelApp!.config).toMatchObject({
      appStoreUrl: "https://apps.apple.com/app/plotnovel/id123",
      googlePlayUrl: "https://play.google.com/store/apps/details?id=x.y",
    });
    expect(db.state.audits.filter((row) => row.action === PLOTNOVEL_AUDIT_ACTIONS.storeLinks)).toHaveLength(1);

    // 改一条链接
    const changed = await registerPlotnovelTheater(db.asDb(), {
      ...APPLY, requestId: "v060-links-2",
      storeLinks: { appStoreUrl: "https://apps.apple.com/app/plotnovel/id999" },
    });
    expect(changed.storeLinkChanges).toEqual({ appStoreUrl: "https://apps.apple.com/app/plotnovel/id999" });
    expect(db.plotnovelApp!.config).toMatchObject({
      appStoreUrl: "https://apps.apple.com/app/plotnovel/id999",
      googlePlayUrl: "https://play.google.com/store/apps/details?id=x.y",
    });
    expect(db.state.audits.filter((row) => row.action === PLOTNOVEL_AUDIT_ACTIONS.storeLinks)).toHaveLength(2);

    // 相同值：零写入
    const same = await registerPlotnovelTheater(db.asDb(), {
      ...APPLY, requestId: "v060-links-3",
      storeLinks: { appStoreUrl: "https://apps.apple.com/app/plotnovel/id999" },
    });
    expect(same.wrote).toBe(false);
    expect(db.state.audits.filter((row) => row.action === PLOTNOVEL_AUDIT_ACTIONS.storeLinks)).toHaveLength(2);

    // 清空
    await registerPlotnovelTheater(db.asDb(), { ...APPLY, requestId: "v060-links-4", storeLinks: { googlePlayUrl: null } });
    expect(db.plotnovelApp!.config).not.toHaveProperty("googlePlayUrl");
    expect(db.plotnovelApp!.config).toHaveProperty("appStoreUrl");
  });

  it("--set-app-status：把新剧场打开 / 关闭，各一条审计；不动能力记录", async () => {
    const db = new FakeTheaterDb();
    await registerPlotnovelTheater(db.asDb(), APPLY);
    await registerPlotnovelTheater(db.asDb(), { ...APPLY, requestId: "v060-open", setAppStatus: "active" });
    expect(db.plotnovelApp!.status).toBe("active");
    expect(db.state.capabilities.every((row) => row.status === "registered_disabled")).toBe(true);
    await registerPlotnovelTheater(db.asDb(), { ...APPLY, requestId: "v060-close", setAppStatus: "registered_disabled" });
    expect(db.plotnovelApp!.status).toBe("registered_disabled");
    expect(db.state.audits.filter((row) => row.action === PLOTNOVEL_AUDIT_ACTIONS.appStatus)).toHaveLength(2);
  });

  it("同一个 request-id 在现状仍需改动时重放：拒绝（不会悄悄覆盖）", async () => {
    const db = new FakeTheaterDb();
    await registerPlotnovelTheater(db.asDb(), APPLY);
    await expect(
      registerPlotnovelTheater(db.asDb(), { ...APPLY, setAppStatus: "active" }),
    ).resolves.toMatchObject({ wrote: true }); // 状态审计是新的 action，同 request-id 允许
    await expect(
      registerPlotnovelTheater(db.asDb(), { ...APPLY, setAppStatus: "registered_disabled" }),
    ).rejects.toMatchObject({ code: "request_replay_conflict" });
  });
});

describe("planPlotnovelRegistration：漂移一律拒绝，不悄悄覆盖", () => {
  function fullSnapshot(): TheaterSnapshot {
    const channel = { id: "c", ...MOBOREADER_FOUNDATION.channel };
    const moboSource = { id: "sm", ...MOBOREADER_FOUNDATION.sourceApp };
    const plotSource = { id: "sp", ...PLOTNOVEL_THEATER.sourceApp };
    return {
      channel,
      moboreaderSourceApp: moboSource,
      moboreaderApp: {
        id: "am", channelId: "c", sourceAppId: "sm", ...MOBOREADER_FOUNDATION.channelApp,
        config: { promoMode: "link", agencyIds: ["3366"] },
      },
      plotnovelSourceApp: plotSource,
      plotnovelApp: {
        id: "ap", channelId: "c", sourceAppId: "sp", externalAppId: "plotnovel", projectType: 1, status: "registered_disabled",
        config: { promoMode: "code", agencyIds: ["1351"], appDisplayName: "PlotNovel", codeModeLocales: ["en"] },
      },
      plotnovelCapabilities: MOBOREADER_FOUNDATION.capabilities.map((capability, index) => ({
        id: `cap-${index}`, channelAppId: "ap", status: "registered_disabled", ...capability,
      })),
    };
  }

  it("完整且一致的快照：计划为空", () => {
    const plan = planPlotnovelRegistration(fullSnapshot(), { storeLinks: {} });
    expect(plan.create).toEqual([]);
    expect(plan.moboreaderConfigPatch).toBeNull();
    expect(plan.appStatusChange).toBeNull();
  });

  it("没有 MoboReader 地基：拒绝，要求先登记地基", () => {
    const snapshot = { ...fullSnapshot(), moboreaderApp: null };
    expect(() => planPlotnovelRegistration(snapshot, { storeLinks: {} })).toThrowError(
      expect.objectContaining({ code: "foundation_missing" }),
    );
  });

  it.each([
    ["promoMode 被人改成 link", { promoMode: "link", agencyIds: ["1351"], appDisplayName: "PlotNovel", codeModeLocales: ["en"] }],
    ["agencyIds 被人改过", { promoMode: "code", agencyIds: ["1351", "9999"], appDisplayName: "PlotNovel", codeModeLocales: ["en"] }],
    ["codeModeLocales 被人加了语种", { promoMode: "code", agencyIds: ["1351"], appDisplayName: "PlotNovel", codeModeLocales: ["en", "fr"] }],
  ])("PlotNovel 的 config 漂移（%s）：拒绝", (_name, config) => {
    const snapshot = fullSnapshot();
    snapshot.plotnovelApp!.config = config;
    expect(() => planPlotnovelRegistration(snapshot, { storeLinks: {} })).toThrowError(PlotnovelTheaterError);
  });

  it("MoboReader 的 promoMode 已被改成 code：拒绝（这会让整个 MoboReader 变成口令码模式）", () => {
    const snapshot = fullSnapshot();
    snapshot.moboreaderApp!.config = { promoMode: "code", agencyIds: ["3366"] };
    expect(() => planPlotnovelRegistration(snapshot, { storeLinks: {} })).toThrowError(
      expect.objectContaining({ code: "metadata_drift" }),
    );
  });

  it("PlotNovel 的 projectType 与 MoboReader 不同：拒绝", () => {
    const snapshot = fullSnapshot();
    snapshot.plotnovelApp!.projectType = 2;
    expect(() => planPlotnovelRegistration(snapshot, { storeLinks: {} })).toThrowError(PlotnovelTheaterError);
  });
});

describe("parseCliOptions", () => {
  const env = { PLOTNOVEL_THEATER_OPERATOR: "operator" } as unknown as NodeJS.ProcessEnv;
  const base = ["--request-id", "stable", "--reason", "because"];

  it("必须有操作者、request-id、reason", () => {
    expect(() => parseCliOptions([], {} as NodeJS.ProcessEnv)).toThrowError(PlotnovelTheaterError);
    expect(() => parseCliOptions(base, env)).not.toThrow();
  });

  it("商店链接只收 https 绝对地址；none 清空；javascript: 之类一律拒绝", () => {
    expect(parseCliOptions([...base, "--app-store-url", "https://apps.apple.com/app/x/id1"], env).storeLinks)
      .toEqual({ appStoreUrl: "https://apps.apple.com/app/x/id1" });
    expect(parseCliOptions([...base, "--google-play-url", "none"], env).storeLinks).toEqual({ googlePlayUrl: null });
    for (const bad of ["javascript:alert(1)", "http://apps.apple.com/x", "apps.apple.com/x", "data:text/html,x"]) {
      expect(() => parseCliOptions([...base, "--app-store-url", bad], env)).toThrowError(PlotnovelTheaterError);
    }
  });

  it("--set-app-status 只收 active | registered_disabled", () => {
    expect(parseCliOptions([...base, "--set-app-status", "active"], env).setAppStatus).toBe("active");
    expect(() => parseCliOptions([...base, "--set-app-status", "inactive"], env)).toThrowError(PlotnovelTheaterError);
  });

  it("默认不带 --apply", () => {
    expect(parseCliOptions(base, env).apply).toBe(false);
    expect(parseCliOptions([...base, "--apply"], env).apply).toBe(true);
  });
});
