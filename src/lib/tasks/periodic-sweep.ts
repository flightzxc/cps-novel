import type { ScheduleDefinition } from "./scheduler";

export const SITEMAP_DAILY_FALLBACK_TASK_TYPE = "sitemap.daily_fallback.v1";
export type SweepCadence = { kind: "minute" } | { kind: "daily"; hour: number; minute: number };

/** Minute scans are strict; daily scans have a fixed same-day bucket and a 15-minute window. */
export function buildPeriodicSweepSchedule(input: {
  scheduleKey: string;
  taskType: string;
  timezone: string;
  cadence: SweepCadence;
}): ScheduleDefinition {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: input.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  if (input.cadence.kind === "daily" && (!Number.isInteger(input.cadence.hour)
    || input.cadence.hour < 0 || input.cadence.hour > 23 || !Number.isInteger(input.cadence.minute)
    || input.cadence.minute < 0 || input.cadence.minute > 59)) throw new Error("sweep_daily_time_invalid");
  // Represent wall-clock parts as a UTC scalar to resolve the zone offset at
  // the scheduled instant, including days whose offset changes before/after it.
  const wallTime = (date: Date) => {
    const parts = formatter.formatToParts(date);
    const value = (key: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === key)?.value);
    return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"));
  };
  return {
    scheduleKey: input.scheduleKey,
    dueInstants(now) {
      if (input.cadence.kind === "daily") {
        const localNow = wallTime(now);
        const day = new Date(localNow);
        day.setUTCHours(input.cadence.hour, input.cadence.minute, 0, 0);
        const target = day.getTime();
        if (localNow < target) return [];
        let candidate = Math.floor(now.getTime() / 60_000) * 60_000 + target - localNow;
        for (let attempt = 0; attempt < 3 && wallTime(new Date(candidate)) !== target; attempt++) {
          candidate += target - wallTime(new Date(candidate));
        }
        // A nonexistent local time (DST jump) has no same-day bucket.
        if (wallTime(new Date(candidate)) !== target) return [];
        // Return expired same-day buckets too: enqueue records misfire_skip.
        return [new Date(candidate)];
      }
      return [new Date(Math.floor(now.getTime() / 60_000) * 60_000)];
    },
    build(scheduledFor) {
      return {
        scheduleKey: input.scheduleKey, scheduleRevision: 1, scheduledFor,
        timezone: input.timezone, misfirePolicy: "skip", maxCatchUpRuns: 0,
        periodicSweep: true, taskType: input.taskType,
        ...(input.cadence.kind === "daily" ? { dailySweepWindowMinutes: 15 } : {}),
        items: [{ targetType: "sweep_control", targetId: "global", payload: {} }],
      };
    },
  };
}
export const SITEMAP_DAILY_FALLBACK_SCHEDULE = buildPeriodicSweepSchedule({
  scheduleKey: "sitemap.daily_fallback", taskType: SITEMAP_DAILY_FALLBACK_TASK_TYPE,
  timezone: "Asia/Tokyo", cadence: { kind: "daily", hour: 4, minute: 0 },
});
