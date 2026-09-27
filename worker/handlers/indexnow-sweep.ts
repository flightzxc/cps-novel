import { isIndexNowDeliveryEnabled, isIndexNowDeliveryWriteAllowed } from "../../src/lib/flags";
import { sweepDueIndexNowDeliveries } from "../../src/lib/indexnow/sweep";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { INDEXNOW_SWEEP_MAX_DELIVERIES, INDEXNOW_SWEEP_TASK_TYPE } from "../../src/lib/tasks/indexnow-sweep";

export function createIndexNowSweepHandler(env: NodeJS.ProcessEnv = process.env): TaskHandler {
  return async () => ({
    status: "success",
    protectedWrite: async tx => {
      if (!isIndexNowDeliveryEnabled(env) || !isIndexNowDeliveryWriteAllowed(env)) {
        return { status: "success", result: { recovered: 0, swept: 0, skippedAlreadyLive: 0 } };
      }
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const result = await sweepDueIndexNowDeliveries(tx, {
        now: clock.now, maxDeliveries: INDEXNOW_SWEEP_MAX_DELIVERIES,
      }, env);
      return { status: "success", result: { ...result } };
    },
  });
}

export function createIndexNowSweepWorkerHandlers() {
  return createHandlerRegistry({
    [INDEXNOW_SWEEP_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler: createIndexNowSweepHandler() },
  });
}
