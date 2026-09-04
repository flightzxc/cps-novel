import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { HANDLERS, createHandlerRegistry, runSchedulerOnce, type ScheduleDefinition } from "../src/lib/tasks";
import {
  DEFAULT_HOME_CAROUSEL_CONFIG,
  HOME_CAROUSEL_TASK_TYPE,
  buildHomeCarouselScheduleDefinition,
  getHomeCarouselConfig,
  type HomeCarouselConfig,
} from "../src/server/home-carousel";

/**
 * PR6 fix (B-1): P1-07 shipped the scheduler runtime with `SCHEDULES` frozen
 * empty and no production handler registered in `HANDLERS` — `runSchedulerOnce`
 * ran every tick but had nothing to do, and `enqueueHomeCarouselCron` had zero
 * callers, despite three docs claiming the cron was "already registered".
 *
 * The scheduler process only enqueues GenericTasks; it never executes task
 * handlers — `home_carousel.compute.v1`'s real handler is registered in the
 * separate Worker process's own registry and only runs there (see
 * `createWorkerHandlers` at the Worker entrypoint; this file intentionally
 * imports nothing from that module tree, preserving the scheduler's
 * existing process-isolation boundary). This entry exists solely so
 * `enqueueScheduledTask`'s `requireHandler` family check (must be `generic`)
 * can resolve the task type against *this* process's registry; its
 * `handler` must never actually execute — if it does, that is a wiring bug,
 * not a degraded-but-working path.
 */
const SCHEDULER_HANDLERS = createHandlerRegistry({
  ...HANDLERS,
  [HOME_CAROUSEL_TASK_TYPE]: {
    family: "generic",
    maxAttempts: 3,
    handler: async () => {
      throw new Error("home_carousel.compute.v1 must be executed by the worker process, not the scheduler");
    },
  },
});

/**
 * `ScheduleDefinition.dueInstants`/`.build` are synchronous by contract
 * (src/lib/tasks/scheduler.ts) and take no db handle, so the cron
 * expression/timezone/enabled flag stored in `SiteSetting.carouselConfigJson`
 * can only reach them through a closed-over snapshot. `main()` refreshes this
 * once per tick, immediately before calling `runSchedulerOnce`; until the
 * first tick (e.g. a test importing this module directly) it holds the
 * documented default (`cronEnabled: true`, `"0 3 * * *"`, `Asia/Shanghai`).
 */
let homeCarouselConfig: HomeCarouselConfig = DEFAULT_HOME_CAROUSEL_CONFIG;

/** First production schedule ever registered by this process. */
export const HOME_CAROUSEL_SCHEDULE: ScheduleDefinition = buildHomeCarouselScheduleDefinition(() => homeCarouselConfig);

export const SCHEDULES: readonly ScheduleDefinition[] = Object.freeze([HOME_CAROUSEL_SCHEDULE]);

export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    homeCarouselConfig = await getHomeCarouselConfig(prisma);
    await runSchedulerOnce(prisma, SCHEDULER_HANDLERS, SCHEDULES);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
