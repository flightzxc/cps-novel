import { SITEMAP_DAILY_FALLBACK_SCHEDULE, SITEMAP_DAILY_FALLBACK_TASK_TYPE } from "../src/lib/tasks/periodic-sweep";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  HANDLERS,
  createHandlerRegistry,
  runPromoClaimReleaseTick,
  runSchedulerOnce,
  type ScheduleDefinition,
} from "../src/lib/tasks";
import { queryActiveLocales } from "../src/lib/locale/active-locales";
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
export const SCHEDULER_HANDLERS = createHandlerRegistry({
  ...HANDLERS,
  [SITEMAP_DAILY_FALLBACK_TASK_TYPE]: {
    family: "generic", maxAttempts: 3,
    handler: async () => { throw new Error("daily fallback must be executed by the worker process"); },
  },
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
 *
 * L10N P5 (矩阵 #13): `homeCarouselActiveLocales` is the same pattern for
 * the active-locale set the cron now fans out to (one `GenericTaskItem`
 * per locale — see `buildHomeCarouselCronTaskInput`'s doc comment).
 * `main()` refreshes it via `queryActiveLocales(prisma)` — the un-cached
 * core, not the `unstable_cache`-wrapped `getActiveLocales()`, since this
 * standalone process has none of the Next.js request/build-time runtime
 * machinery that wrapper depends on (same reasoning
 * `active-locales.ts`/`queryActiveLocales`'s own doc comment gives for why
 * tests bypass it too) — using the scheduler's own already-open `prisma`
 * client, the same one `runSchedulerOnce` below uses. Defaults to `["en"]`
 * until the first tick, matching `homeCarouselConfig`'s own pre-first-tick
 * default posture.
 */
let homeCarouselConfig: HomeCarouselConfig = DEFAULT_HOME_CAROUSEL_CONFIG;
// `Object.freeze([...])`, not a bare array literal — also matches this
// file's own `locale-canonical.ts` `SITE_LOCALES` convention for a frozen
// readonly default. This is a plain default snapshot value, not a locale
// resolution table: registered as such in `tests/ui/locale-canonical.test.ts`'s
// `LOCALE_DECLARATION_EXEMPTIONS` (file `scheduler/index.ts`, identifier
// `homeCarouselActiveLocales`), the declaration-level counterpart to that
// same file's function-level `LOCALE_NAME_EXEMPTIONS`.
let homeCarouselActiveLocales: readonly string[] = Object.freeze(["en"]);

/** First production schedule ever registered by this process. */
export const HOME_CAROUSEL_SCHEDULE: ScheduleDefinition = buildHomeCarouselScheduleDefinition(
  () => homeCarouselConfig,
  () => homeCarouselActiveLocales,
);

export const SCHEDULES: readonly ScheduleDefinition[] = Object.freeze([HOME_CAROUSEL_SCHEDULE, SITEMAP_DAILY_FALLBACK_SCHEDULE]);

/**
 * 正式修复第 2 阶段第 3 步：领推广链接生命周期分片的放行 / 暂停
 * （`src/lib/tasks/promo-claim-release.ts`，纯数据库读写，不调用任何上游、
 * 不接触凭据密文）。与上面既有的首页轮播入队逻辑相互独立——任一个失败都不
 * 应该阻塞另一个，所以单独包一层 try/catch：`runPromoClaimReleaseTick`
 * 自己已经把"每个渠道账号各自的错误"都吞掉记录了，这里只兜底
 * `resolvePromoClaimLifecycleConfig` 这类在整个 tick 开始前就可能抛出的
 * 配置错误（例如环境变量被改成非法值）——记一条日志，等下一轮（60 秒后）
 * 再试，而不是让整个 scheduler 进程因为这一个功能的配置问题而崩溃退出。
 */
async function runPromoClaimReleaseTickSafely(prisma: PrismaClient): Promise<void> {
  try {
    await runPromoClaimReleaseTick(prisma, { now: new Date() });
  } catch (error) {
    console.error("promo_claim_release.tick_failed", error);
  }
}

export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    homeCarouselConfig = await getHomeCarouselConfig(prisma);
    homeCarouselActiveLocales = await queryActiveLocales(prisma);
    await runSchedulerOnce(prisma, SCHEDULER_HANDLERS, SCHEDULES);
    await runPromoClaimReleaseTickSafely(prisma);
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
