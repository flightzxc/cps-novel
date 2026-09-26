import { describe, expect, it } from "vitest";
import { buildPeriodicSweepSchedule, SITEMAP_DAILY_FALLBACK_SCHEDULE } from "@/lib/tasks/periodic-sweep";
import { createSitemapDailyFallbackHandler } from "../../../worker/handlers/sitemap-daily-fallback";
import { SCHEDULES, SCHEDULER_HANDLERS } from "../../../scheduler";
import type { TaskHandlerContext } from "@/lib/tasks";

describe("periodic sweep schedules", () => {
  it("registers the real schedule and an enqueue-only placeholder", async () => {
    expect(SCHEDULES).toContain(SITEMAP_DAILY_FALLBACK_SCHEDULE);
    const registration = SCHEDULER_HANDLERS["sitemap.daily_fallback.v1"];
    expect(registration.family).toBe("generic");
    await expect(registration.handler({} as TaskHandlerContext)).rejects.toThrow("worker process");
  });
  it("keeps Tokyo's same-day 04:00 bucket, including expired candidates for skip recording", () => {
    const bucket = new Date("2026-09-26T19:00:00Z");
    for (const time of ["2026-09-26T19:00:30Z", "2026-09-26T19:07:00Z", "2026-09-26T19:09:00Z", "2026-09-26T19:20:00Z"]) {
      expect(SITEMAP_DAILY_FALLBACK_SCHEDULE.dueInstants(new Date(time))).toEqual([bucket]);
    }
    for (const time of ["2026-09-26T18:59:59Z", "2026-09-27T15:00:00Z", "2026-09-29T18:00:00Z"]) {
      expect(SITEMAP_DAILY_FALLBACK_SCHEDULE.dueInstants(new Date(time))).toEqual([]);
    }
    expect(SITEMAP_DAILY_FALLBACK_SCHEDULE.dueInstants(new Date("2026-09-29T19:09:00Z"))).toEqual([new Date("2026-09-29T19:00:00Z")]);
    expect(SITEMAP_DAILY_FALLBACK_SCHEDULE.build(bucket)).toMatchObject({ misfirePolicy: "skip", periodicSweep: true, dailySweepWindowMinutes: 15, maxCatchUpRuns: 0, taskType: "sitemap.daily_fallback.v1" });
  });
  it("resolves the offset at the daily bucket when daylight saving changes later that day", () => {
    const schedule = buildPeriodicSweepSchedule({ scheduleKey: "dst", taskType: "scan", timezone: "America/New_York", cadence: { kind: "daily", hour: 0, minute: 0 } });
    expect(schedule.dueInstants(new Date("2026-03-08T12:00:00Z"))).toEqual([new Date("2026-03-08T05:00:00Z")]);
  });
  it("supports minute scans without enumerating history", () => {
    const schedule = buildPeriodicSweepSchedule({ scheduleKey: "scan", taskType: "scan", timezone: "UTC", cadence: { kind: "minute" } });
    expect(schedule.dueInstants(new Date("2026-09-26T00:01:42Z"))).toEqual([new Date("2026-09-26T00:01:00Z")]);
  });
  it.each([["false", "false"], ["true", "false"], ["false", "true"]])("closed gates %s/%s complete successfully without database writes", async (feature, write) => {
    const outcome = await createSitemapDailyFallbackHandler({ NODE_ENV: "test", FEATURE_SITEMAP_AUTO_REFRESH: feature, SITEMAP_AUTO_REFRESH_ALLOW_WRITE: write })({ lease: { workerId: "light" } } as TaskHandlerContext);
    const result = await outcome.protectedWrite!({} as never);
    expect(result).toMatchObject({ status: "success", result: { decision: "write_gate_closed" } });
  });
});
