import { describe, expect, it } from "vitest";
import { DEFAULT_HOME_CAROUSEL_CONFIG, HOME_CAROUSEL_SCAN_LIMIT, homeCarouselBusinessDate, normalizeHomeCarouselConfig, updateHomeCarouselConfig } from "@/server/home-carousel";
import { SiteSettingNotSeededError } from "@/server/site-settings/service";

import { FakeHomeCarouselDb, authFixture, authorizeAction, dependencies } from "./support";

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

/**
 * X8 轮 2d ⑦ fix: `updateHomeCarouselConfig` used to write
 * `tx.siteSetting.upsert(...)`. Postgres compiles `upsert` to `INSERT ...
 * ON CONFLICT (id) DO UPDATE`, which requires INSERT privilege even on the
 * path that resolves as an UPDATE — but `infra/postgres/grants.sql` gives
 * `web_app` (the role this function runs as) only column-scoped UPDATE on
 * `site_setting`; INSERT/DELETE are `migration_owner`-only. X8 reproduced
 * `permission denied for table site_setting` against the real role.
 */
describe("updateHomeCarouselConfig's site_setting write (X8 轮 2d ⑦ fix)", () => {
  it("writes via siteSetting.update, never upsert — matches web_app's grants.sql column-scoped UPDATE-only privilege on site_setting", async () => {
    const { stores } = authFixture();
    const { authorization, requestId } = await authorizeAction(stores, "admin.home_carousel.config");
    const db = new FakeHomeCarouselDb();
    await updateHomeCarouselConfig(
      { authorization, requestId, cronSchedule: "0 3 * * *", cronTimezone: "Asia/Shanghai", cronEnabled: true },
      dependencies(db, stores),
    );
    // Mutation pin: reverting to `upsert` flips this call trace back to
    // `siteSetting.upsert` — failing this assertion (in addition to the
    // per-method grants guard in `tests/backend/database/grants-returning.test.ts`,
    // which would also flag the reappeared `.upsert(` call site against a
    // table web_app holds no INSERT on).
    expect(db.calls).toContain("siteSetting.update");
    expect(db.calls).not.toContain("siteSetting.upsert");
    expect(db.carouselConfigJson).toMatchObject({ cronEnabled: true });
  });

  it("throws SiteSettingNotSeededError instead of silently creating the row when the site_setting singleton is missing (migration rolled back / seed row manually deleted), and never attempts the write", async () => {
    const { stores } = authFixture();
    const { authorization, requestId } = await authorizeAction(stores, "admin.home_carousel.config");
    const db = new FakeHomeCarouselDb();
    db.siteSettingSeeded = false;
    await expect(
      updateHomeCarouselConfig(
        { authorization, requestId, cronSchedule: "0 3 * * *", cronTimezone: "Asia/Shanghai", cronEnabled: true },
        dependencies(db, stores),
      ),
    ).rejects.toBeInstanceOf(SiteSettingNotSeededError);
    expect(db.calls).not.toContain("siteSetting.update");
    expect(db.calls).not.toContain("siteSetting.upsert");
  });
});
