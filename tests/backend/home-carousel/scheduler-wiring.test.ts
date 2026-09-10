import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/**
 * L10N P5.1 (Opus 复核 NON_BLOCKING, 矩阵 #13 收尾): Opus's mutation pass on
 * `scheduler/index.ts` found that *every* backend test still passed after
 * either (a) reverting `main()`'s per-tick
 * `homeCarouselActiveLocales = await queryActiveLocales(prisma)` refresh to
 * a hardcoded constant, or (b) deleting the second closure parameter off
 * `buildHomeCarouselScheduleDefinition(...)` entirely (which silently falls
 * back to that function's own `() => ["en"]` default — see
 * `src/server/home-carousel/service.ts`'s doc comment on that default).
 * Neither existing suite (`tests/backend/home-carousel/cron.test.ts`,
 * `tests/backend/locale/active-locales.test.ts`) exercises `scheduler/
 * index.ts`'s own wiring — they test `buildHomeCarouselScheduleDefinition`
 * and `queryActiveLocales` in isolation, each already given a fresh,
 * correctly-wired closure by the test itself, so a regression in how
 * `scheduler/index.ts` connects the two would go undetected by either.
 *
 * This file closes that gap two ways, matching the two existing structural-
 * assertion precedents in this repo (`tests/backend/home-carousel/
 * cron.test.ts:20`'s "SCHEDULES contains …" and `tests/backend/runtime/
 * x8-production-like-contract.test.ts`'s `readFileSync` + `toMatch` source
 * checks; CPS's own analog is `3a76877:tests/home-carousel-cron.test.ts:20`
 * `assert.match(instrumentationSource, /runCarouselCronTick/)`):
 *
 * 1. A source-text structural check ("结构断言" below) that `main()` still
 *    calls the live `queryActiveLocales(` core and that the module-level
 *    `HOME_CAROUSEL_SCHEDULE` construction still passes
 *    `buildHomeCarouselScheduleDefinition` a second closure argument
 *    referencing the `homeCarouselActiveLocales` snapshot variable — this
 *    alone goes red on mutation ① (delete the second closure parameter) and
 *    on any rewrite of mutation ② that removes the `queryActiveLocales(`
 *    call text itself.
 * 2. A behavior-level check ("行为断言" below) that actually drives
 *    `scheduler/index.ts`'s exported `main()` against a fake
 *    `queryActiveLocales` returning a locale set that is NOT the pre-tick
 *    default (`["en"]`), then reads the module-level `HOME_CAROUSEL_
 *    SCHEDULE.build(...)` — built once at module-eval time, closing over
 *    the *live* `let homeCarouselActiveLocales` binding, so it reflects
 *    whatever `main()` last assigned — and asserts the built task items
 *    carry the fake locale, not `en`. This is the strictly stronger check:
 *    it catches mutation ② even if some future rewrite keeps the literal
 *    substring `queryActiveLocales(` in the source (e.g. calls it but
 *    discards the result) — a case (1) alone would miss.
 *
 * `@prisma/client`, `@/lib/locale/active-locales`, `@/lib/tasks`, and
 * `@/server/home-carousel` are mocked so this test never opens a real
 * database connection — `main()`'s only real callers of `prisma` are
 * `getHomeCarouselConfig`/`queryActiveLocales`/`runSchedulerOnce`, all
 * three mocked below (the latter two selectively, via `importOriginal`
 * spreads, so every other export — `HANDLERS`, `createHandlerRegistry`,
 * `buildHomeCarouselScheduleDefinition`, `DEFAULT_HOME_CAROUSEL_CONFIG`,
 * etc. — stays real).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const SCHEDULER_SOURCE_PATH = "scheduler/index.ts";
const schedulerSource = readFileSync(resolve(repoRoot, SCHEDULER_SOURCE_PATH), "utf8");

describe("结构断言：scheduler/index.ts 源码里活跃语种真的接了线", () => {
  it("main() 调用的是活体 queryActiveLocales(prisma)，不是把结果丢弃或换成常量", () => {
    // Matches the actual assignment statement, not a bare substring — this
    // file's own header comment (above) also *mentions*
    // "queryActiveLocales(prisma)" in prose, so a naive `toContain` would
    // stay green even if mutation ② replaced the real call with a literal
    // (e.g. `homeCarouselActiveLocales = ["en"];`) and left the now-stale
    // comment behind. Requiring the exact `homeCarouselActiveLocales =
    // await queryActiveLocales(prisma)` assignment rules that out.
    expect(schedulerSource).toMatch(/homeCarouselActiveLocales\s*=\s*await\s*queryActiveLocales\(prisma\)/);
  });

  it("buildHomeCarouselScheduleDefinition(...) 仍然带着第二个引用 homeCarouselActiveLocales 的闭包参数", () => {
    // Mutation ① target: deleting this second argument silently falls back
    // to `buildHomeCarouselScheduleDefinition`'s own default
    // `() => ["en"]` (service.ts) — every existing test that builds its own
    // schedule definition supplies its own closures and would stay green.
    expect(schedulerSource).toMatch(
      /buildHomeCarouselScheduleDefinition\(\s*\(\)\s*=>\s*homeCarouselConfig\s*,\s*\(\)\s*=>\s*homeCarouselActiveLocales\s*,?\s*\)/,
    );
  });
});

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    $disconnect: vi.fn(async () => {}),
  })),
}));

vi.mock("@/lib/locale/active-locales", () => ({
  // Deliberately NOT "en" (the pre-first-tick default both
  // `homeCarouselActiveLocales` and `buildHomeCarouselScheduleDefinition`'s
  // own fallback closure use) — if `main()` stopped actually consulting
  // this fake, the behavior-level assertion below would still see "en".
  queryActiveLocales: vi.fn(async () => ["ru"]),
}));

vi.mock("@/lib/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tasks")>();
  return {
    ...actual,
    // The scheduler's own raw-SQL schedule_run/cron_run machinery
    // (@/lib/tasks/scheduler.ts) only works against a real Postgres
    // connection (tests/integration/tasks/p1-07-postgres.test.ts) — this
    // test only needs `main()` to run to completion so it can inspect the
    // module-level HOME_CAROUSEL_SCHEDULE afterwards, not to exercise the
    // actual scheduler-run/lease machinery.
    runSchedulerOnce: vi.fn(async () => {}),
  };
});

vi.mock("@/server/home-carousel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/home-carousel")>();
  return {
    ...actual,
    getHomeCarouselConfig: vi.fn(async () => actual.DEFAULT_HOME_CAROUSEL_CONFIG),
  };
});

describe("行为断言：main() 刷新后的快照真的驱动了 HOME_CAROUSEL_SCHEDULE.build()", () => {
  it("queryActiveLocales 返回 [ru] 时，main() 之后 build() 产出 ru 条目、不产出 en 条目", async () => {
    vi.resetModules();
    const mod = await import("../../../scheduler/index");

    await mod.main();

    const input = mod.HOME_CAROUSEL_SCHEDULE.build(new Date("2026-09-05T19:00:00.000Z"));
    const locales = input.items.map((item) => (item.payload as { locale?: string } | undefined)?.locale);

    expect(locales).toContain("ru");
    expect(locales).not.toContain("en");
  });
});
