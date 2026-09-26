import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createHandlerRegistry, enqueueScheduledTask, runSchedulerOnce } from "@/lib/tasks";
import { buildPeriodicSweepSchedule, SITEMAP_DAILY_FALLBACK_SCHEDULE as daily } from "@/lib/tasks/periodic-sweep";

const registry = createHandlerRegistry({ "sitemap.daily_fallback.v1": { family: "generic", handler: async () => { throw new Error("enqueue only"); } } });
// A controllable database clock for exact wall-time cases. Real roles, unique
// constraints and writes are independently exercised by worker-light-postgres.
function database(time: string, active = false) {
  let now = new Date(time);
  const buckets = new Set<string>();
  const tx = {
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      const text = sql.strings.join("");
      if (text.includes("clock_timestamp()")) return [{ now }];
      if (text.includes("INSERT INTO schedule_run")) {
        const bucket = (sql.values.find(value => value instanceof Date) as Date).toISOString();
        if (buckets.has(bucket)) return [];
        buckets.add(bucket);
        return [{ id: sql.values[0] }];
      }
      return [];
    }),
    $executeRaw: vi.fn(async () => 1),
    genericTask: {
      findFirst: vi.fn(async () => active ? { id: "in-flight" } : null),
      create: vi.fn(async () => { active = true; }),
    },
    cronRun: { create: vi.fn(async () => ({ id: "cron" })) },
    scheduleRun: { update: vi.fn() },
  };
  const db = { $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx), $queryRaw: async () => [{ now }] } as unknown as PrismaClient;
  return { db, tx, setTime: (time: string) => { now = new Date(time); } };
}

describe("daily sweep admission window", () => {
  it("04:00:30 and 04:07 share a bucket and enqueue only once", async () => {
    const { db, tx, setTime } = database("2026-09-26T19:00:30Z");
    expect(await runSchedulerOnce(db, registry, [daily])).toMatchObject([{ status: "enqueued" }]);
    setTime("2026-09-26T19:07:00Z");
    expect(await runSchedulerOnce(db, registry, [daily])).toEqual([{ status: "duplicate" }]);
    expect(tx.genericTask.create).toHaveBeenCalledTimes(1);
  });
  it("only 04:09 tick still enqueues today's 04:00 bucket", async () => {
    const { db, tx } = database("2026-09-26T19:09:00Z");
    expect(await runSchedulerOnce(db, registry, [daily])).toMatchObject([{ status: "enqueued" }]);
    expect(tx.genericTask.create).toHaveBeenCalledTimes(1);
  });
  it.each(["19:15:00", "19:20:00"])("%s UTC is outside the window and records misfire_skip", async time => {
    const { db, tx } = database(`2026-09-26T${time}Z`);
    expect(await runSchedulerOnce(db, registry, [daily])).toMatchObject([{ status: "skipped", skipReason: "misfire_skip" }]);
    expect(tx.$executeRaw.mock.calls).toHaveLength(1);
    expect(tx.genericTask.create).not.toHaveBeenCalled();
  });
  it("in-flight scans still record previous_scan_in_flight within the window", async () => {
    const { db, tx } = database("2026-09-26T19:09:00Z", true);
    expect(await runSchedulerOnce(db, registry, [daily])).toMatchObject([{ status: "skipped", skipReason: "previous_scan_in_flight" }]);
    expect(tx.genericTask.create).not.toHaveBeenCalled();
  });
  it("rechecks the database clock if a candidate crosses the end of the window", async () => {
    const { db } = database("2026-09-26T19:15:00Z");
    expect(await runSchedulerOnce(db, registry, [daily], new Date("2026-09-26T19:14:59Z"))).toMatchObject([{ status: "skipped", skipReason: "misfire_skip" }]);
  });
  it("minute scans still require exactly the current minute", async () => {
    const { db, tx } = database("2026-09-26T19:09:30Z");
    const minute = buildPeriodicSweepSchedule({ scheduleKey: "minute", taskType: "sitemap.daily_fallback.v1", timezone: "UTC", cadence: { kind: "minute" } });
    expect(await enqueueScheduledTask(db, registry, minute.build(new Date("2026-09-26T19:08:00Z")))).toMatchObject({ status: "skipped", skipReason: "misfire_skip" });
    expect(await runSchedulerOnce(db, registry, [minute])).toMatchObject([{ status: "enqueued" }]);
    expect(tx.genericTask.create).toHaveBeenCalledTimes(1);
  });
});
