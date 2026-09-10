import { describe, expect, it } from "vitest";
import { DEFAULT_HOME_CAROUSEL_CONFIG, HOME_CAROUSEL_SCAN_LIMIT, homeCarouselBusinessDate, normalizeHomeCarouselConfig } from "@/server/home-carousel";

describe("Novel home carousel frozen config", () => {
  it("pins five slots, one new slot, fourteen days, 500 scans and revenue off", () => {
    expect(DEFAULT_HOME_CAROUSEL_CONFIG).toMatchObject({ slotCount: 5, newSlotCount: 1, newNovelWindowDays: 14, revenueEnabled: false });
    expect(HOME_CAROUSEL_SCAN_LIMIT).toBe(500);
    expect(normalizeHomeCarouselConfig({ revenueEnabled: true })).toMatchObject({ slotCount: 5, newSlotCount: 1, newNovelWindowDays: 14, revenueEnabled: false });
  });

  it("derives cron idempotency from the configured business date", () => {
    expect(homeCarouselBusinessDate(new Date("2026-09-04T16:30:00.000Z"), "Asia/Tokyo")).toBe("2026-09-05");
  });
});
