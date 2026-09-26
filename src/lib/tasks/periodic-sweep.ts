import type { ScheduleDefinition } from "./scheduler";

export const SITEMAP_DAILY_FALLBACK_TASK_TYPE = "sitemap.daily_fallback.v1";
export type SweepCadence = { kind: "minute" } | { kind: "daily"; hour: number; minute: number };

/** Only the current minute is eligible; no historical enumeration or catch-up. */
export function buildPeriodicSweepSchedule(input: {
  scheduleKey: string;
  taskType: string;
  timezone: string;
  cadence: SweepCadence;
}): ScheduleDefinition {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: input.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  if (input.cadence.kind === "daily" && (!Number.isInteger(input.cadence.hour)
    || input.cadence.hour < 0 || input.cadence.hour > 23 || !Number.isInteger(input.cadence.minute)
    || input.cadence.minute < 0 || input.cadence.minute > 59)) throw new Error("sweep_daily_time_invalid");
  return {
    scheduleKey: input.scheduleKey,
    dueInstants(now) {
      if (input.cadence.kind === "daily") {
        const parts = formatter.formatToParts(now);
        if (Number(parts.find(p => p.type === "hour")?.value) !== input.cadence.hour
          || Number(parts.find(p => p.type === "minute")?.value) !== input.cadence.minute) return [];
      }
      return [new Date(Math.floor(now.getTime() / 60_000) * 60_000)];
    },
    build(scheduledFor) {
      return {
        scheduleKey: input.scheduleKey, scheduleRevision: 1, scheduledFor,
        timezone: input.timezone, misfirePolicy: "skip", maxCatchUpRuns: 0,
        periodicSweep: true, taskType: input.taskType,
        items: [{ targetType: "sweep_control", targetId: "global", payload: {} }],
      };
    },
  };
}
export const SITEMAP_DAILY_FALLBACK_SCHEDULE = buildPeriodicSweepSchedule({
  scheduleKey: "sitemap.daily_fallback", taskType: SITEMAP_DAILY_FALLBACK_TASK_TYPE,
  timezone: "Asia/Tokyo", cadence: { kind: "daily", hour: 4, minute: 0 },
});
