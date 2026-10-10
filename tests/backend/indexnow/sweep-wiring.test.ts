import { beforeEach, describe, expect, it } from "vitest";
import { buildIndexNowSweepSchedule, INDEXNOW_SWEEP_SCHEDULE, INDEXNOW_SWEEP_TASK_TYPE } from "@/lib/tasks/indexnow-sweep";
import * as sweepTaskModule from "@/lib/tasks/indexnow-sweep";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";
import { SCHEDULES, SCHEDULER_HANDLERS } from "../../../scheduler";
import { createIndexNowSweepHandler } from "../../../worker/handlers/indexnow-sweep";
import type { TaskHandlerContext } from "@/lib/tasks";
import { FakeIndexNowDb, installTestSiteUrl } from "./fake-db";
import { seedDueRows } from "./helpers";

installTestSiteUrl();
beforeEach(() => invalidateSiteSettingCache());

const now = new Date("2026-09-27T01:03:42Z");
const env = { NODE_ENV: "test", FEATURE_INDEXNOW_DELIVERY: "true", INDEXNOW_DELIVERY_ALLOW_WRITE: "true" } as const;
describe("IndexNow minute sweep wiring", () => {
  it.each([["false", "false"], ["false", "true"], ["true", "false"], [undefined, undefined], ["TRUE", "true"], [" true", "true"], ["true", "1"]])("closed gates %s/%s have no bucket and no database access", async (feature, write) => {
    const closed = { ...env, FEATURE_INDEXNOW_DELIVERY: feature, INDEXNOW_DELIVERY_ALLOW_WRITE: write };
    expect(buildIndexNowSweepSchedule(closed).dueInstants(now)).toEqual([]);
    const outcome = await createIndexNowSweepHandler(closed)({} as TaskHandlerContext);
    expect(await outcome.protectedWrite!({} as never)).toMatchObject({ result: { recovered: 0, created: 0 } });
  });
  it("open gates emit only the current minute and skip missed buckets", () => {
    const schedule = buildIndexNowSweepSchedule(env);
    expect(schedule.dueInstants(now)).toEqual([new Date("2026-09-27T01:03:00Z")]);
    expect(schedule.dueInstants(new Date("2026-09-29T01:05:59Z"))).toEqual([new Date("2026-09-29T01:05:00Z")]);
    expect(schedule.build(now)).toMatchObject({ taskType: INDEXNOW_SWEEP_TASK_TYPE, periodicSweep: true, misfirePolicy: "skip", maxCatchUpRuns: 0 });
  });
  it("registers the production schedule and throwing scheduler placeholder", async () => {
    expect(SCHEDULES).toContain(INDEXNOW_SWEEP_SCHEDULE);
    expect(SCHEDULER_HANDLERS[INDEXNOW_SWEEP_TASK_TYPE].family).toBe("generic");
    await expect(SCHEDULER_HANDLERS[INDEXNOW_SWEEP_TASK_TYPE].handler({} as TaskHandlerContext)).rejects.toThrow("worker process");
  });
  it("reads database time inside the fenced callback and creates at most ONE batch task per scan (the old 200-row budget is gone)", async () => {
    expect("INDEXNOW_SWEEP_MAX_DELIVERIES" in sweepTaskModule).toBe(false);
    const fake = new FakeIndexNowDb().setNow(now);
    seedDueRows(fake, 300, { baseMs: now.getTime() - 3_600_000 });
    // A row that is only due in the future of the DATABASE clock must not count.
    seedDueRows(fake, 1, { prefix: "later", status: "retry_wait", overrides: { nextAttemptAt: new Date(now.getTime() + 60_000) } });
    const outcome = await createIndexNowSweepHandler(env)({} as TaskHandlerContext);
    expect(fake.genericTasks.size).toBe(0);
    const result = await outcome.protectedWrite!(fake.asTransactionClient());
    expect(result).toMatchObject({ status: "success", result: { recovered: 0, created: 1 } });
    expect(fake.genericTasks.size).toBe(1);
    expect(fake.genericTaskItems.size).toBe(1);
  });
});
