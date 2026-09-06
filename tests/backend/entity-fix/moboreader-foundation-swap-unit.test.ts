import { describe, expect, it } from "vitest";

import {
  FoundationSwapError,
  applyFoundationSwap,
  assertFoundationInvariantsPreserved,
  planFoundationSwap,
  rollbackFoundationSwap,
  type FoundationSnapshot,
} from "../../../scripts/entity-fix/moboreader-foundation-swap";
import { parseDirection } from "../../../scripts/entity-fix/moboreader-foundation-swap-dry-run";

/**
 * Fast, always-running coverage for the Phase B entity-fix core logic
 * (`施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md` §二), against a
 * hand-rolled in-memory fake -- no Postgres required. The real,
 * Postgres-gated integration coverage (actual `$transaction`, actual unique
 * constraints, actual foreign-key tables) lives in
 * `tests/integration/entity-fix/moboreader-foundation-swap.test.ts`; this
 * file exists so the resolve/guard/snapshot logic itself is exercised on
 * every `npm run test:backend`, not only when a disposable Postgres is
 * available.
 */

type Row = { id: string; code: string; name: string };

type FakeState = {
  channels: Row[];
  sourceApps: Row[];
  channelAccounts: { id: string; channelId: string }[];
  channelApps: { id: string; channelId: string; sourceAppId: string; externalAppId: string }[];
  novelSourceItems: { channelAppId: string }[];
  promoLinks: { channelAppId: string }[];
  catalogScanTasks: { channelAccountId: string }[];
  channelSyncTasks: { channelAccountId: string }[];
  genericTasks: { channelAccountId: string }[];
};

function defaultState(): FakeState {
  return {
    channels: [{ id: "channel-1", code: "moboreader", name: "MoboReader" }],
    sourceApps: [{ id: "source-1", code: "changdu", name: "Changdu" }],
    channelAccounts: [
      { id: "account-1", channelId: "channel-1" },
      { id: "account-2", channelId: "channel-1" },
      { id: "account-3", channelId: "channel-1" },
    ],
    channelApps: [{ id: "app-1", channelId: "channel-1", sourceAppId: "source-1", externalAppId: "moboreader" }],
    novelSourceItems: [{ channelAppId: "app-1" }, { channelAppId: "app-1" }],
    promoLinks: [{ channelAppId: "app-1" }],
    catalogScanTasks: [{ channelAccountId: "account-1" }],
    channelSyncTasks: [{ channelAccountId: "account-2" }],
    genericTasks: [{ channelAccountId: "account-3" }, { channelAccountId: "account-3" }],
  };
}

/**
 * Deep-clones the state so mutations inside a "transaction" cannot leak into
 * a caller's reference before the fake decides whether to commit.
 */
function clone(state: FakeState): FakeState {
  return JSON.parse(JSON.stringify(state)) as FakeState;
}

/** Structural fake matching exactly the shape `planFoundationSwap`/`runFoundationSwap` call. */
function fakeDb(state: FakeState) {
  const inFilter = <T>(values: readonly T[]) => (value: T) => values.includes(value);

  return {
    channel: {
      async findMany(args: { where: { code: { in: string[] } } }) {
        return state.channels.filter((row) => args.where.code.in.includes(row.code));
      },
      async findUniqueOrThrow(args: { where: { id: string } }) {
        const row = state.channels.find((candidate) => candidate.id === args.where.id);
        if (!row) throw new Error(`channel ${args.where.id} not found`);
        return row;
      },
      async updateMany(args: { where: { id: string; code: string }; data: { code: string; name: string } }) {
        const matches = state.channels.filter(
          (row) => row.id === args.where.id && row.code === args.where.code,
        );
        for (const row of matches) {
          row.code = args.data.code;
          row.name = args.data.name;
        }
        return { count: matches.length };
      },
    },
    sourceApp: {
      async findMany(args: { where: { code: { in: string[] } } }) {
        return state.sourceApps.filter((row) => args.where.code.in.includes(row.code));
      },
      async findUniqueOrThrow(args: { where: { id: string } }) {
        const row = state.sourceApps.find((candidate) => candidate.id === args.where.id);
        if (!row) throw new Error(`sourceApp ${args.where.id} not found`);
        return row;
      },
      async updateMany(args: { where: { id: string; code: string }; data: { code: string; name: string } }) {
        const matches = state.sourceApps.filter(
          (row) => row.id === args.where.id && row.code === args.where.code,
        );
        for (const row of matches) {
          row.code = args.data.code;
          row.name = args.data.name;
        }
        return { count: matches.length };
      },
    },
    channelAccount: {
      async findMany(args: { where: { channelId: string } }) {
        return state.channelAccounts
          .filter((row) => row.channelId === args.where.channelId)
          .map((row) => ({ id: row.id }));
      },
    },
    channelApp: {
      async findMany(args: { where: { channelId: string; sourceAppId: string } }) {
        return state.channelApps
          .filter((row) => row.channelId === args.where.channelId && row.sourceAppId === args.where.sourceAppId)
          .map((row) => ({ id: row.id, externalAppId: row.externalAppId }));
      },
    },
    novelSourceItem: {
      async count(args: { where: { channelAppId: { in: string[] } } }) {
        return state.novelSourceItems.filter((row) => inFilter(args.where.channelAppId.in)(row.channelAppId)).length;
      },
    },
    promoLink: {
      async count(args: { where: { channelAppId: { in: string[] } } }) {
        return state.promoLinks.filter((row) => inFilter(args.where.channelAppId.in)(row.channelAppId)).length;
      },
    },
    catalogScanTask: {
      async count(args: { where: { channelAccountId: { in: string[] } } }) {
        return state.catalogScanTasks.filter((row) => inFilter(args.where.channelAccountId.in)(row.channelAccountId))
          .length;
      },
    },
    channelSyncTask: {
      async count(args: { where: { channelAccountId: { in: string[] } } }) {
        return state.channelSyncTasks.filter((row) => inFilter(args.where.channelAccountId.in)(row.channelAccountId))
          .length;
      },
    },
    genericTask: {
      async count(args: { where: { channelAccountId: { in: string[] } } }) {
        return state.genericTasks.filter((row) => inFilter(args.where.channelAccountId.in)(row.channelAccountId))
          .length;
      },
    },
  };
}

/** Adds `$transaction` on top of {@link fakeDb}, committing the clone only if the callback resolves. */
function fakeTransactionalDb(state: FakeState) {
  const readSide = fakeDb(state);
  return {
    ...readSide,
    async $transaction<T>(callback: (tx: ReturnType<typeof fakeDb>) => Promise<T>): Promise<T> {
      const staged = clone(state);
      const tx = fakeDb(staged);
      const result = await callback(tx);
      Object.assign(state, staged);
      return result;
    },
  };
}

describe("planFoundationSwap (read-only)", () => {
  it("reports the current rows, the direction's target, and readyToRun=true in the expected pre-state", async () => {
    const plan = await planFoundationSwap(fakeDb(defaultState()) as never, "apply");
    expect(plan.channel).toMatchObject({ id: "channel-1", code: "moboreader", name: "MoboReader" });
    expect(plan.channel.target).toEqual({ code: "changdu", name: "Changdu" });
    expect(plan.sourceApp).toMatchObject({ id: "source-1", code: "changdu", name: "Changdu" });
    expect(plan.sourceApp.target).toEqual({ code: "moboreader", name: "MoboReader" });
    expect(plan.readyToRun).toBe(true);
  });

  it("readyToRun=false when the database is already past this direction (no write attempted -- read-only)", async () => {
    const state = defaultState();
    state.channels[0]!.code = "changdu";
    state.channels[0]!.name = "Changdu";
    state.sourceApps[0]!.code = "moboreader";
    state.sourceApps[0]!.name = "MoboReader";
    const plan = await planFoundationSwap(fakeDb(state) as never, "apply");
    expect(plan.readyToRun).toBe(false);
  });

  it("reports foreign-key counts and the exact channelAccountId set", async () => {
    const plan = await planFoundationSwap(fakeDb(defaultState()) as never, "apply");
    expect(plan.snapshot.channelAccountIds).toEqual(["account-1", "account-2", "account-3"]);
    expect(plan.snapshot.counts).toEqual({
      channelAccounts: 3,
      channelApps: 1,
      novelSourceItems: 2,
      promoLinks: 1,
      catalogScanTasks: 1,
      channelSyncTasks: 1,
      genericTasks: 2,
    });
    expect(plan.snapshot.channelAppExternalAppIds).toEqual(["moboreader"]);
  });

  it("rejects with row_not_found when zero rows match either candidate code", async () => {
    const state = defaultState();
    state.channels[0]!.code = "something-else";
    await expect(planFoundationSwap(fakeDb(state) as never, "apply")).rejects.toMatchObject({
      code: "row_not_found",
    });
  });

  it("rejects with multiple_rows_found when more than one row matches", async () => {
    const state = defaultState();
    state.channels.push({ id: "channel-2", code: "changdu", name: "Duplicate" });
    await expect(planFoundationSwap(fakeDb(state) as never, "apply")).rejects.toMatchObject({
      code: "multiple_rows_found",
    });
  });
});

describe("runFoundationSwap (apply / rollback share this)", () => {
  it("apply: swaps code/name, targets by id (not code), and leaves every foreign-key count and the account-id set untouched", async () => {
    const state = defaultState();
    const db = fakeTransactionalDb(state);
    const report = await applyFoundationSwap(db as never);

    expect(report.channelId).toBe("channel-1");
    expect(report.sourceAppId).toBe("source-1");
    expect(state.channels[0]).toEqual({ id: "channel-1", code: "changdu", name: "Changdu" });
    expect(state.sourceApps[0]).toEqual({ id: "source-1", code: "moboreader", name: "MoboReader" });
    // id unchanged on both rows.
    expect(report.before.channel.id).toBe(report.after.channel.id);
    expect(report.before.sourceApp.id).toBe(report.after.sourceApp.id);
    // Foreign-key counts identical before/after -- nothing else was touched.
    expect(report.after.counts).toEqual(report.before.counts);
    expect(report.after.channelAccountIds).toEqual(report.before.channelAccountIds);
    expect(report.after.channelAppExternalAppIds).toEqual(["moboreader"]);
  });

  it("rollback: reverses apply exactly, round-tripping back to the original values", async () => {
    const state = defaultState();
    const db = fakeTransactionalDb(state);
    await applyFoundationSwap(db as never);
    const rolledBack = await rollbackFoundationSwap(db as never);

    expect(state.channels[0]).toEqual({ id: "channel-1", code: "moboreader", name: "MoboReader" });
    expect(state.sourceApps[0]).toEqual({ id: "source-1", code: "changdu", name: "Changdu" });
    expect(rolledBack.after.counts).toEqual(rolledBack.before.counts);
  });

  it("rejects (and writes nothing) when zero rows match", async () => {
    const state = defaultState();
    state.sourceApps[0]!.code = "something-else";
    const db = fakeTransactionalDb(state);
    await expect(applyFoundationSwap(db as never)).rejects.toMatchObject({ code: "row_not_found" });
    // Unchanged -- the rejected resolve happened before any write.
    expect(state.channels[0]!.code).toBe("moboreader");
  });

  it("rejects (and writes nothing) when more than one row matches", async () => {
    const state = defaultState();
    state.sourceApps.push({ id: "source-2", code: "moboreader", name: "Duplicate" });
    const db = fakeTransactionalDb(state);
    await expect(applyFoundationSwap(db as never)).rejects.toMatchObject({ code: "multiple_rows_found" });
    expect(state.channels[0]!.code).toBe("moboreader");
  });

  it("rejects with unexpected_current_state when the database is not in this direction's expected pre-state (refuses a second, accidental apply)", async () => {
    const state = defaultState();
    const db = fakeTransactionalDb(state);
    await applyFoundationSwap(db as never);
    // Running "apply" again: channel.code is now "changdu", not "moboreader".
    await expect(applyFoundationSwap(db as never)).rejects.toMatchObject({ code: "unexpected_current_state" });
    // Still exactly the post-first-apply state -- the second attempt wrote nothing.
    expect(state.channels[0]).toEqual({ id: "channel-1", code: "changdu", name: "Changdu" });
  });

  it("a pre-existing row already holding the target code is caught by multiple_rows_found at resolve time, not a separate collision check", async () => {
    // There is no independent "does the target code collide" guard (see the
    // module-header note on `runFoundationSwap`) -- with exactly two known
    // candidate codes swapping places, a row already sitting on either one
    // is inherently caught by resolveSingleFoundationRow's own >1-match
    // rejection before a collision could ever be checked separately.
    const state = defaultState();
    state.channels.push({ id: "channel-3", code: "changdu", name: "Some other channel" });
    const db = fakeTransactionalDb(state);
    await expect(applyFoundationSwap(db as never)).rejects.toMatchObject({ code: "multiple_rows_found" });
    expect(state.channels[0]!.code).toBe("moboreader");
    expect(state.channels[1]!.code).toBe("changdu");
  });

  it("targets the UPDATE by id, not by a bare code match -- a same-code row elsewhere in a different id is never touched", async () => {
    // Regression guard for "must be WHERE id = $id, never WHERE code = $code
    // alone": simulate a fake whose updateMany would (incorrectly) match by
    // code only, and confirm the real call always also passes id.
    const state = defaultState();
    const db = fakeTransactionalDb(state);
    let sawIdConstraint = false;
    const originalTransaction = db.$transaction.bind(db);
    db.$transaction = (async (callback: Parameters<typeof originalTransaction>[0]) =>
      originalTransaction(async (tx) => {
        const originalUpdateMany = tx.channel.updateMany.bind(tx.channel);
        tx.channel.updateMany = (async (args: Parameters<typeof originalUpdateMany>[0]) => {
          sawIdConstraint = sawIdConstraint || Object.prototype.hasOwnProperty.call(args.where, "id");
          return originalUpdateMany(args);
        }) as typeof tx.channel.updateMany;
        return callback(tx);
      })) as typeof db.$transaction;

    await applyFoundationSwap(db as never);
    expect(sawIdConstraint).toBe(true);
  });
});

describe("assertFoundationInvariantsPreserved", () => {
  function snapshot(overrides: Partial<FoundationSnapshot> = {}): FoundationSnapshot {
    return {
      channel: { id: "channel-1", code: "moboreader", name: "MoboReader" },
      sourceApp: { id: "source-1", code: "changdu", name: "Changdu" },
      channelAppExternalAppIds: ["moboreader"],
      channelAccountIds: ["account-1", "account-2", "account-3"],
      counts: {
        channelAccounts: 3,
        channelApps: 1,
        novelSourceItems: 2,
        promoLinks: 1,
        catalogScanTasks: 1,
        channelSyncTasks: 1,
        genericTasks: 2,
      },
      ...overrides,
    };
  }

  it("passes when before/after are identical", () => {
    const before = snapshot();
    const after = snapshot();
    expect(() => assertFoundationInvariantsPreserved(before, after)).not.toThrow();
  });

  it("throws FoundationSwapError when channel.id changed", () => {
    const before = snapshot();
    const after = snapshot({ channel: { ...before.channel, id: "channel-2" } });
    expect(() => assertFoundationInvariantsPreserved(before, after)).toThrow(FoundationSwapError);
  });

  it("throws when the channelAccountId set changed", () => {
    const before = snapshot();
    const after = snapshot({ channelAccountIds: ["account-1", "account-2"] });
    expect(() => assertFoundationInvariantsPreserved(before, after)).toThrow(/channelAccountIds set changed/);
  });

  it("throws when any foreign-key count changed", () => {
    const before = snapshot();
    const after = snapshot({ counts: { ...before.counts, promoLinks: 2 } });
    expect(() => assertFoundationInvariantsPreserved(before, after)).toThrow(/foreign-key counts changed/);
  });

  it("throws when channelApp.externalAppId drifted away from moboreader", () => {
    const before = snapshot();
    const after = snapshot({ channelAppExternalAppIds: ["something-else"] });
    expect(() => assertFoundationInvariantsPreserved(before, after)).toThrow(/externalAppId drifted/);
  });
});

describe("parseDirection (dry-run CLI arg parsing)", () => {
  it("defaults to apply when --direction is absent", () => {
    expect(parseDirection([])).toBe("apply");
  });

  it("accepts --direction apply and --direction rollback", () => {
    expect(parseDirection(["--direction", "apply"])).toBe("apply");
    expect(parseDirection(["--direction", "rollback"])).toBe("rollback");
  });

  it("throws on an unrecognized direction value", () => {
    expect(() => parseDirection(["--direction", "sideways"])).toThrow();
  });
});
