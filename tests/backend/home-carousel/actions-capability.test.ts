/**
 * B-2 (13-action capability-binding requirement, home-carousel's 3 slice):
 * `src/app/api/admin/_lib/registry.ts`'s `ADMIN_HOME_CAROUSEL_ACTIONS` locks
 * the *registry's* declared capability (`settings:manage`) for each action
 * id. Nothing in that table checks what capability string the *service
 * function body* actually hands to `requireFreshAdminServiceMutation` — a
 * copy/paste typo there (e.g. `content:view`) would still let the request
 * through the route-level `enforceCapability` check (which reads the
 * registry, not the service body) and only fail — or worse, silently pass —
 * deep inside the service. RC-4's lesson: a registry-literal test does not
 * "bite" that class of bug.
 *
 * Each test below mints a real, guard-issued authorization for the action id
 * via `requireAdminActionAccess` against the actual registry (not a stub),
 * then drives the real exported service function body. If `service.ts`'s
 * internal `auth()` helper ever asks `requireFreshAdminServiceMutation` for a
 * capability other than what the registry granted, `requireAdminServiceMutation`
 * throws `admin_capability_denied` and the call this test awaits rejects —
 * these tests go red on that mutation without any source-text scanning.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  deleteHomeCarouselManualSlot,
  enqueueHomeCarouselCompute,
  updateHomeCarouselConfig,
  upsertHomeCarouselManualSlot,
} from "@/server/home-carousel";

import { FakeHomeCarouselDb, NOW, authFixture, authorizeAction, dependencies } from "./support";

describe("home-carousel service functions ask for the capability the registry actually granted", () => {
  it("admin.home_carousel.config → updateHomeCarouselConfig succeeds under a settings:manage authorization", async () => {
    const { stores } = authFixture();
    const { authorization, requestId } = await authorizeAction(stores, "admin.home_carousel.config");
    const db = new FakeHomeCarouselDb();
    await expect(
      updateHomeCarouselConfig({ authorization, requestId, cronSchedule: "0 3 * * *", cronTimezone: "Asia/Shanghai", cronEnabled: true }, dependencies(db, stores)),
    ).resolves.toMatchObject({ cronEnabled: true });
  });

  it("admin.home_carousel.manual_upsert → upsertHomeCarouselManualSlot succeeds under a settings:manage authorization", async () => {
    const { stores } = authFixture();
    const { authorization, requestId } = await authorizeAction(stores, "admin.home_carousel.manual_upsert");
    const db = new FakeHomeCarouselDb();
    db.seedArticle({
      id: "article-1", novelId: "novel-1", locale: "en", status: "published", deletedAt: null,
      publishedAt: NOW, updatedAt: NOW,
      novel: { title: "Novel 1", status: "published", deletedAt: null, coverUrl: "https://cdn.example.com/cover.jpg" },
    });
    await expect(
      upsertHomeCarouselManualSlot({ authorization, requestId, locale: "en", position: 1, articleId: "article-1", enabled: true }, dependencies(db, stores)),
    ).resolves.toMatchObject({ position: 1, novelId: "novel-1" });
  });

  it("admin.home_carousel.compute → enqueueHomeCarouselCompute succeeds under a settings:manage authorization", async () => {
    const { stores } = authFixture();
    const { authorization, requestId } = await authorizeAction(stores, "admin.home_carousel.compute");
    const db = new FakeHomeCarouselDb();
    await expect(
      enqueueHomeCarouselCompute({ authorization, requestId, locale: "en" }, dependencies(db, stores)),
    ).resolves.toMatchObject({ status: "enqueued" });
  });

  it("admin.home_carousel.manual_upsert (reused for delete, N-5) → deleteHomeCarouselManualSlot succeeds under a settings:manage authorization", async () => {
    const { stores } = authFixture();
    const { authorization, requestId } = await authorizeAction(stores, "admin.home_carousel.manual_upsert");
    const db = new FakeHomeCarouselDb();
    const slotId = randomUUID();
    db.seedManualSlot({
      id: slotId, locale: "en", position: 1, novelId: "novel-1", articleId: "article-1", enabled: true,
      startsAt: null, endsAt: null, deletedAt: null, createdBy: "admin-1", updatedBy: "admin-1",
    });
    await expect(
      deleteHomeCarouselManualSlot({ authorization, requestId, id: slotId, locale: "en" }, dependencies(db, stores)),
    ).resolves.toMatchObject({ enabled: false });
    expect(db.manualSlots.get(slotId)?.deletedAt).toBeInstanceOf(Date);
  });
});
