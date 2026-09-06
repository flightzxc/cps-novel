import { describe, expect, it } from "vitest";

import {
  MOBOREADER_FOUNDATION,
  MoboreaderFoundationError,
  inspectFoundationSnapshot,
  parseCliOptions,
  registerMoboreaderFoundation,
  type FoundationSnapshot,
} from "../../../scripts/register-moboreader-foundation";

type State = {
  channels: Array<Record<string, unknown>>;
  sourceApps: Array<Record<string, unknown>>;
  channelApps: Array<Record<string, unknown>>;
  capabilities: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  nextId: number;
};

function cloneState(state: State): State {
  return structuredClone(state);
}

class FakeFoundationDb {
  state: State = { channels: [], sourceApps: [], channelApps: [], capabilities: [], audits: [], nextId: 1 };
  calls: string[] = [];
  failAudit = false;
  private transactionTail: Promise<void> = Promise.resolve();

  private id(prefix: string): string {
    const id = `${prefix}-${this.state.nextId}`;
    this.state.nextId += 1;
    return id;
  }

  private client() {
    return {
      channel: {
        findUnique: async (args: { where: { code: string } }) => {
          this.calls.push("channel.findUnique");
          return this.state.channels.find((row) => row.code === args.where.code) ?? null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
          this.calls.push("channel.create");
          const row = { id: this.id("channel"), ...args.data };
          this.state.channels.push(row);
          return row;
        },
      },
      sourceApp: {
        findUnique: async (args: { where: { code: string } }) => {
          this.calls.push("sourceApp.findUnique");
          return this.state.sourceApps.find((row) => row.code === args.where.code) ?? null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
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
          this.calls.push("channelApp.findUnique");
          const key = args.where.channelId_sourceAppId_externalAppId;
          return (
            this.state.channelApps.find(
              (row) =>
                row.channelId === key.channelId &&
                row.sourceAppId === key.sourceAppId &&
                row.externalAppId === key.externalAppId,
            ) ?? null
          );
        },
        create: async (args: { data: Record<string, unknown> }) => {
          this.calls.push("channelApp.create");
          const row = { id: this.id("app"), ...args.data };
          this.state.channelApps.push(row);
          return row;
        },
      },
      channelCapability: {
        findMany: async (args: { where: { channelAppId: string } }) => {
          this.calls.push("channelCapability.findMany");
          return this.state.capabilities.filter((row) => row.channelAppId === args.where.channelAppId);
        },
        create: async (args: { data: Record<string, unknown> }) => {
          this.calls.push("channelCapability.create");
          const row = { id: this.id("capability"), ...args.data };
          this.state.capabilities.push(row);
          return row;
        },
      },
      operationAudit: {
        findFirst: async (args: { where: { actorType: string; action: string; requestId: string } }) => {
          this.calls.push("operationAudit.findFirst");
          return (
            this.state.audits.find(
              (row) =>
                row.actorType === args.where.actorType &&
                row.action === args.where.action &&
                row.requestId === args.where.requestId,
            ) ?? null
          );
        },
        create: async (args: { data: Record<string, unknown> }) => {
          this.calls.push("operationAudit.create");
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

  readonly $transaction = async <T>(callback: (tx: ReturnType<FakeFoundationDb["client"]>) => Promise<T>) => {
    let release: () => void = () => undefined;
    const predecessor = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    const before = cloneState(this.state);
    try {
      return await callback(this.client());
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      release();
    }
  };

  asDb(): Parameters<typeof registerMoboreaderFoundation>[0] {
    return this as unknown as Parameters<typeof registerMoboreaderFoundation>[0];
  }
}

const APPLY = {
  apply: true,
  operatorId: "release-operator",
  requestId: "x4-foundation-2026-08-26",
  reason: "register the frozen production foundation",
} as const;

function completeSnapshot(status = "registered_disabled"): FoundationSnapshot {
  const channel = { id: "channel-1", ...MOBOREADER_FOUNDATION.channel };
  const sourceApp = { id: "source-1", ...MOBOREADER_FOUNDATION.sourceApp };
  const channelApp = {
    id: "app-1",
    channelId: channel.id,
    sourceAppId: sourceApp.id,
    ...MOBOREADER_FOUNDATION.channelApp,
  };
  return {
    channel,
    sourceApp,
    channelApp,
    capabilities: MOBOREADER_FOUNDATION.capabilities.map((capability, index) => ({
      id: `capability-${index}`,
      channelAppId: channelApp.id,
      status,
      ...capability,
    })),
  };
}

describe("MoboReader foundation profile", () => {
  it("freezes the requested parent identity and four disabled-on-create capability keys", () => {
    // Phase B entity fix: Channel is the changdu channel, SourceApp is the
    // moboreader theater — see 施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md §二.
    expect(MOBOREADER_FOUNDATION.channel).toMatchObject({ code: "changdu", name: "Changdu" });
    expect(MOBOREADER_FOUNDATION.sourceApp).toMatchObject({ code: "moboreader", name: "MoboReader" });
    expect(MOBOREADER_FOUNDATION.channelApp).toMatchObject({ externalAppId: "moboreader", projectType: 1 });
    expect(MOBOREADER_FOUNDATION.capabilities.map((row) => row.capabilityKey)).toEqual([
      "getlistpc",
      "getbydataid",
      "getchapterinfo",
      "claimPromo",
    ]);
  });

  it("accepts an already enabled, metadata-identical capability without downgrading it", () => {
    const snapshot = completeSnapshot();
    snapshot.capabilities[0]!.status = "enabled";
    expect(inspectFoundationSnapshot(snapshot).missing).toEqual([]);
    expect(inspectFoundationSnapshot(snapshot).capabilityStatuses.getlistpc).toBe("enabled");
  });

  it("fails closed on metadata drift", () => {
    const snapshot = completeSnapshot();
    snapshot.channelApp!.projectType = 2;
    expect(() => inspectFoundationSnapshot(snapshot)).toThrowError(MoboreaderFoundationError);
  });
});

describe("registerMoboreaderFoundation", () => {
  it("is a zero-write dry-run by default", async () => {
    const db = new FakeFoundationDb();
    const report = await registerMoboreaderFoundation(db.asDb(), { ...APPLY, apply: false });
    expect(report.mode).toBe("dry-run");
    expect(report.missing).toHaveLength(7);
    expect(db.state.channels).toHaveLength(0);
    expect(db.calls.some((call) => call.endsWith(".create"))).toBe(false);
  });

  it("creates parents and capabilities disabled, then writes a same-transaction audit", async () => {
    const db = new FakeFoundationDb();
    const report = await registerMoboreaderFoundation(db.asDb(), APPLY);
    expect(report.wrote).toBe(true);
    expect(db.state.channels).toHaveLength(1);
    expect(db.state.sourceApps).toHaveLength(1);
    expect(db.state.channelApps).toHaveLength(1);
    expect(db.state.capabilities).toHaveLength(4);
    expect(db.state.capabilities.every((row) => row.status === "registered_disabled")).toBe(true);
    expect(db.state.audits).toHaveLength(1);
    expect(db.calls.indexOf("pg_advisory_xact_lock")).toBeLessThan(db.calls.indexOf("channel.create"));
  });

  it("rolls the whole foundation back when audit insertion fails", async () => {
    const db = new FakeFoundationDb();
    db.failAudit = true;
    await expect(registerMoboreaderFoundation(db.asDb(), APPLY)).rejects.toThrow("audit insert failed");
    expect(db.state.channels).toHaveLength(0);
    expect(db.state.sourceApps).toHaveLength(0);
    expect(db.state.channelApps).toHaveLength(0);
    expect(db.state.capabilities).toHaveLength(0);
    expect(db.state.audits).toHaveLength(0);
  });

  it("replays the same committed request without another write", async () => {
    const db = new FakeFoundationDb();
    const first = await registerMoboreaderFoundation(db.asDb(), APPLY);
    const second = await registerMoboreaderFoundation(db.asDb(), APPLY);
    expect(first.wrote).toBe(true);
    expect(second).toMatchObject({ wrote: false, replayed: true, auditId: first.auditId });
    expect(db.state.audits).toHaveLength(1);
    expect(db.state.capabilities).toHaveLength(4);
  });

  it("serializes concurrent same-request invocations into one write and one replay", async () => {
    const db = new FakeFoundationDb();
    const reports = await Promise.all([
      registerMoboreaderFoundation(db.asDb(), APPLY),
      registerMoboreaderFoundation(db.asDb(), APPLY),
    ]);
    expect(reports.filter((report) => report.wrote)).toHaveLength(1);
    expect(reports.filter((report) => report.replayed)).toHaveLength(1);
    expect(db.state.channels).toHaveLength(1);
    expect(db.state.capabilities).toHaveLength(4);
    expect(db.state.audits).toHaveLength(1);
  });
});

describe("parseCliOptions", () => {
  it("requires an identified operator, stable request id, and reason", () => {
    expect(() => parseCliOptions([], {} as NodeJS.ProcessEnv)).toThrowError(MoboreaderFoundationError);
    expect(() =>
      parseCliOptions(
        ["--request-id", "stable", "--reason", "because"],
        { MOBOREADER_FOUNDATION_OPERATOR: "operator" } as unknown as NodeJS.ProcessEnv,
      ),
    ).not.toThrow();
  });
});
