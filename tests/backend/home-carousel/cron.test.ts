import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOME_CAROUSEL_CONFIG,
  HOME_CAROUSEL_SCHEDULE_KEY,
  HOME_CAROUSEL_TASK_TYPE,
  buildHomeCarouselCronTaskInput,
  buildHomeCarouselScheduleDefinition,
  enqueueHomeCarouselCron,
  isHomeCarouselCronDue,
  normalizeHomeCarouselConfig,
  type HomeCarouselConfig,
} from "@/server/home-carousel";
import { HANDLERS, createHandlerRegistry } from "@/lib/tasks";

import { SCHEDULES } from "../../../scheduler/index";
import { FakeHomeCarouselDb, type FakeArticle } from "./support";

describe("PR6 fix B-1: the home-carousel schedule is actually registered", () => {
  it("scheduler/index.ts's SCHEDULES contains the home-carousel-daily schedule", () => {
    expect(SCHEDULES.length).toBeGreaterThan(0);
    expect(SCHEDULES.map((schedule) => schedule.scheduleKey)).toContain(HOME_CAROUSEL_SCHEDULE_KEY);
  });

  it("defaults the cron timezone to Asia/Shanghai (not the undocumented Asia/Tokyo drift)", () => {
    expect(DEFAULT_HOME_CAROUSEL_CONFIG.cronTimezone).toBe("Asia/Shanghai");
    expect(normalizeHomeCarouselConfig({}).cronTimezone).toBe("Asia/Shanghai");
  });
});

describe("isHomeCarouselCronDue", () => {
  it("matches the default '0 3 * * *' only at 03:00 Asia/Shanghai", () => {
    expect(isHomeCarouselCronDue("0 3 * * *", "Asia/Shanghai", new Date("2026-09-05T19:00:00.000Z"))).toBe(true); // 03:00 CST next day
    expect(isHomeCarouselCronDue("0 3 * * *", "Asia/Shanghai", new Date("2026-09-05T18:00:00.000Z"))).toBe(false); // 02:00 CST
    expect(isHomeCarouselCronDue("0 3 * * *", "Asia/Shanghai", new Date("2026-09-05T19:01:00.000Z"))).toBe(false); // 03:01 CST
  });

  it("treats an unparseable expression as never-due instead of throwing", () => {
    expect(isHomeCarouselCronDue("not a cron", "Asia/Shanghai", new Date())).toBe(false);
    expect(isHomeCarouselCronDue("0 3 * *", "Asia/Shanghai", new Date())).toBe(false); // only 4 fields
  });
});

describe("buildHomeCarouselScheduleDefinition", () => {
  function config(overrides: Partial<HomeCarouselConfig>): HomeCarouselConfig {
    return { ...DEFAULT_HOME_CAROUSEL_CONFIG, ...overrides };
  }

  it("cronEnabled=false yields zero due instants — no batch, no task, nothing to dedupe later", () => {
    const definition = buildHomeCarouselScheduleDefinition(() => config({ cronEnabled: false }));
    expect(definition.dueInstants(new Date("2026-09-05T19:00:00.000Z"))).toEqual([]);
  });

  it("cronEnabled=true and a matching minute yields exactly one due instant, floored to the minute", () => {
    const definition = buildHomeCarouselScheduleDefinition(() => config({ cronEnabled: true, cronSchedule: "0 3 * * *", cronTimezone: "Asia/Shanghai" }));
    const due = definition.dueInstants(new Date("2026-09-05T19:00:30.500Z"));
    expect(due).toHaveLength(1);
    expect(due[0].toISOString()).toBe("2026-09-05T19:00:00.000Z");
  });

  it("a non-matching minute yields zero due instants", () => {
    const definition = buildHomeCarouselScheduleDefinition(() => config({ cronEnabled: true, cronSchedule: "0 3 * * *", cronTimezone: "Asia/Shanghai" }));
    expect(definition.dueInstants(new Date("2026-09-05T12:00:00.000Z"))).toEqual([]);
  });

  it("build() with no getActiveLocales supplied defaults to a single en item (pre-P5 behavior)", () => {
    const definition = buildHomeCarouselScheduleDefinition(() => config({ cronTimezone: "Asia/Shanghai" }));
    const scheduledFor = new Date("2026-09-05T19:00:00.000Z");
    const input = definition.build(scheduledFor);
    expect(input.scheduleKey).toBe(HOME_CAROUSEL_SCHEDULE_KEY);
    expect(input.taskType).toBe(HOME_CAROUSEL_TASK_TYPE);
    expect(input.timezone).toBe("Asia/Shanghai");
    expect(input.items).toHaveLength(1);
    expect(input.items[0]).toMatchObject({ targetType: "home_carousel", targetId: "2026-09-06:en", payload: { locale: "en", source: "cron" } });
  });

  // L10N P5 (矩阵 #13). Mutation ① target: reverting the cron item-building
  // to hardcode `["en"]` regardless of what `getActiveLocales()` reports —
  // this is exactly the scenario that would go red.
  it("build() with active locales [en, ru] enqueues two items, one per locale, each with a locale-scoped target id", () => {
    const definition = buildHomeCarouselScheduleDefinition(
      () => config({ cronTimezone: "Asia/Shanghai" }),
      () => ["en", "ru"],
    );
    const input = definition.build(new Date("2026-09-05T19:00:00.000Z"));
    expect(input.items).toHaveLength(2);
    expect(input.items).toEqual([
      { targetType: "home_carousel", targetId: "2026-09-06:en", payload: { locale: "en", source: "cron" } },
      { targetType: "home_carousel", targetId: "2026-09-06:ru", payload: { locale: "ru", source: "cron" } },
    ]);
    expect(input.params).toEqual({ locales: ["en", "ru"] });
  });

  it("the item set really comes from getActiveLocales(), not a hardcoded default — a [ru]-only active set enqueues exactly one ru item, no en item", () => {
    const definition = buildHomeCarouselScheduleDefinition(
      () => config({ cronTimezone: "Asia/Shanghai" }),
      () => ["ru"],
    );
    const input = definition.build(new Date("2026-09-05T19:00:00.000Z"));
    expect(input.items).toHaveLength(1);
    expect(input.items[0]).toMatchObject({ targetId: "2026-09-06:ru", payload: { locale: "ru" } });
    expect(input.items.some((item) => item.payload && (item.payload as { locale?: string }).locale === "en")).toBe(false);
  });

  it("buildHomeCarouselCronTaskInput itself: empty activeLocales array falls back to [en] rather than enqueuing zero items (enqueueScheduledTask rejects an empty item list)", () => {
    const input = buildHomeCarouselCronTaskInput(
      config({ cronTimezone: "Asia/Shanghai" }),
      new Date("2026-09-05T19:00:00.000Z"),
      [],
    );
    expect(input.items).toHaveLength(1);
    expect(input.items[0]).toMatchObject({ targetId: "2026-09-06:en", payload: { locale: "en" } });
  });
});

describe("enqueueHomeCarouselCron (async convenience wrapper, shares the same builder as the ScheduleDefinition)", () => {
  it("cronEnabled=false returns skipped_disabled and never attempts a db mutation", async () => {
    const db = new FakeHomeCarouselDb();
    db.carouselConfigJson = { cronEnabled: false };
    const registry = createHandlerRegistry({ [HOME_CAROUSEL_TASK_TYPE]: { family: "generic", handler: async () => ({ status: "success" as const }) } });
    const result = await enqueueHomeCarouselCron(db.asPrismaClient(), registry, new Date("2026-09-05T19:00:00.000Z"));
    expect(result).toEqual({ status: "skipped_disabled" });
    expect(db.calls).toEqual(["siteSetting.findUnique"]);
  });

  it("an unregistered task type is rejected by the scheduler's own registry, not silently accepted", async () => {
    const db = new FakeHomeCarouselDb();
    db.carouselConfigJson = { cronEnabled: true };
    await expect(enqueueHomeCarouselCron(db.asPrismaClient(), HANDLERS, new Date("2026-09-05T19:00:00.000Z"))).rejects.toThrow(/not registered/i);
  });

  function publishedArticle(overrides: Partial<FakeArticle>): FakeArticle {
    return {
      id: overrides.id ?? "article-1",
      novelId: overrides.novelId ?? "novel-1",
      locale: overrides.locale ?? "en",
      status: "published",
      deletedAt: null,
      publishedAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      novel: { title: "T", status: "published", deletedAt: null, coverUrl: "https://example.com/c.jpg" },
      ...overrides,
    };
  }

  // L10N P5 (矩阵 #13, F): resolves the live active-locale set via
  // queryActiveLocales(db) before building the task input — a real ru
  // article in the fake db must actually be read (not just the always-en
  // default assumed without looking).
  it("resolves the live active-locale set before enqueueing (queryActiveLocales runs ahead of the scheduler write)", async () => {
    const db = new FakeHomeCarouselDb();
    db.carouselConfigJson = { cronEnabled: true };
    db.seedArticle(publishedArticle({ id: "article-en", novelId: "novel-en", locale: "en" }));
    db.seedArticle(publishedArticle({ id: "article-ru", novelId: "novel-ru", locale: "ru" }));
    const registry = createHandlerRegistry({
      [HOME_CAROUSEL_TASK_TYPE]: { family: "generic", handler: async () => ({ status: "success" as const }) },
    });

    // This fake's `$transaction`/`genericTask` double does not implement
    // the scheduler's own raw-SQL `schedule_run`/`cron_run` machinery
    // (`enqueueScheduledTask`, `@/lib/tasks/scheduler.ts`) — that surface
    // is exercised only against a real database
    // (`tests/integration/tasks/p1-07-postgres.test.ts`). This test only
    // needs to prove `queryActiveLocales` actually ran (`db.calls` records
    // it) ahead of the write attempt, not that the write itself succeeds
    // against this narrower fake — so the rejection past that point is
    // swallowed rather than asserted on.
    await enqueueHomeCarouselCron(db.asPrismaClient(), registry, new Date("2026-09-05T19:00:00.000Z")).catch(() => {});

    expect(db.calls).toContain("article.groupBy");
  });
});
