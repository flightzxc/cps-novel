import { isIndexNowDeliveryEnabled, isIndexNowDeliveryWriteAllowed } from "../flags";
import { buildPeriodicSweepSchedule } from "./periodic-sweep";
import type { ScheduleDefinition } from "./scheduler";

export const INDEXNOW_SWEEP_TASK_TYPE = "indexnow.sweep.v1";
export const INDEXNOW_SWEEP_MAX_DELIVERIES = 200;

export function buildIndexNowSweepSchedule(env: NodeJS.ProcessEnv = process.env): ScheduleDefinition {
  const schedule = buildPeriodicSweepSchedule({
    scheduleKey: "indexnow.sweep", taskType: INDEXNOW_SWEEP_TASK_TYPE,
    timezone: "Asia/Tokyo", cadence: { kind: "minute" },
  });
  return {
    ...schedule,
    dueInstants(now) {
      if (!isIndexNowDeliveryEnabled(env) || !isIndexNowDeliveryWriteAllowed(env)) return [];
      return schedule.dueInstants(now);
    },
  };
}

export const INDEXNOW_SWEEP_SCHEDULE = buildIndexNowSweepSchedule();
