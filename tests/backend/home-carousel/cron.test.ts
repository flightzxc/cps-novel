import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOME_CAROUSEL_CONFIG,
  HOME_CAROUSEL_SCHEDULE_KEY,
  HOME_CAROUSEL_TASK_TYPE,
  buildHomeCarouselScheduleDefinition,
  enqueueHomeCarouselCron,
  isHomeCarouselCronDue,
  normalizeHomeCarouselConfig,
  type HomeCarouselConfig,
} from "@/server/home-carousel";
import { HANDLERS, createHandlerRegistry } from "@/lib/tasks";

import { SCHEDULES } from "../../../scheduler/index";
import { FakeHomeCarouselDb } from "./support";

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

  it("build() produces a ScheduledTaskInput targeting home_carousel.compute.v1 with the configured timezone and cron:<businessDate> item target", () => {
    const definition = buildHomeCarouselScheduleDefinition(() => config({ cronTimezone: "Asia/Shanghai" }));
    const scheduledFor = new Date("2026-09-05T19:00:00.000Z");
    const input = definition.build(scheduledFor);
    expect(input.scheduleKey).toBe(HOME_CAROUSEL_SCHEDULE_KEY);
    expect(input.taskType).toBe(HOME_CAROUSEL_TASK_TYPE);
    expect(input.timezone).toBe("Asia/Shanghai");
    expect(input.items).toHaveLength(1);
    expect(input.items[0]).toMatchObject({ targetType: "home_carousel", targetId: "2026-09-06", payload: { locale: "en", source: "cron" } });
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
});
