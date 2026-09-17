import { describe, expect, it, vi } from "vitest";

/**
 * C-8 (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md` §五):
 * `readSourceItemsPage`'s new `promoClaimEligible`/`promoClaimIneligibleReason`
 * projection is a page-local Prisma read (`src/app/(admin)/catalog-sync/_lib/
 * read-source-items.ts`) — this whole pattern (`readRows` in
 * `channel-accounts/page.tsx`, `read-channel-apps.ts`, `read-primary-article.ts`)
 * has no existing test harness anywhere in this codebase; every one of those
 * reads is otherwise exercised only by the real running app. This file is a
 * minimal, purpose-built fake for the exact three Prisma calls
 * `readSourceItemsPage` makes, added specifically because C-8's eligibility
 * computation is new logic that would otherwise ship with zero automated
 * coverage — the UI-level test (`tests/ui/catalog-sync-client.test.tsx`)
 * only covers how a given `{eligible, reason}` pair renders, never how it is
 * computed from the database.
 *
 * The three outcomes mirror `createPromoLinkClaimTask`'s own (already
 * tested in `tests/backend/tasks/promo-link-claim-factory.test.ts`)
 * eligibility guard exactly — this is a read-only projection of that same
 * guard, never a second judgment.
 */

const prismaMock = vi.hoisted(() => ({
  novelSourceItem: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  genericTaskItem: {
    findMany: vi.fn(),
  },
}));

vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: prismaMock }));

const { readSourceItemsPage } = await import("@/app/(admin)/catalog-sync/_lib/read-source-items");

const CHANNEL_APP_SELECT = {
  channel: { code: "moboreader", name: "Moboreader" },
  sourceApp: { code: "mobo-app-1", name: "Mobo App" },
};

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "src-1",
    title: "示例小说 A",
    description: "简介",
    coverUrl: null,
    totalChapterCount: 10,
    paidFromChapter: null,
    sourceLocale: "en",
    sourceLanguageCode: "1",
    sourceLanguageName: "English",
    status: "pending",
    novelId: null,
    lastSeenAt: null,
    channelAppId: "channel-app-1",
    channelApp: CHANNEL_APP_SELECT,
    ...overrides,
  };
}

describe("readSourceItemsPage · 领取资格投影 (C-8)", () => {
  it("status !== linked (or no novelId) -> promoClaimEligible=false, reason=source_not_linked, no cross-task overlap query needed", async () => {
    prismaMock.novelSourceItem.findMany.mockResolvedValue([
      baseRow({ id: "src-pending", status: "pending", novelId: null }),
    ]);
    prismaMock.novelSourceItem.count.mockResolvedValue(1);
    prismaMock.genericTaskItem.findMany.mockResolvedValue([]);

    const page = await readSourceItemsPage({});

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      promoClaimEligible: false,
      promoClaimIneligibleReason: "source_not_linked",
    });
    // No linked rows on this page at all -- the cross-task overlap query
    // (an extra round trip) must not fire for nothing.
    expect(prismaMock.genericTaskItem.findMany).not.toHaveBeenCalled();
  });

  it("linked + novelId set, but a pending/processing promo_link.claim.v1 GenericTaskItem already targets it -> item_already_active_elsewhere", async () => {
    prismaMock.novelSourceItem.findMany.mockResolvedValue([
      baseRow({ id: "src-linked-busy", status: "linked", novelId: "novel-1" }),
    ]);
    prismaMock.novelSourceItem.count.mockResolvedValue(1);
    prismaMock.genericTaskItem.findMany.mockResolvedValue([{ targetId: "src-linked-busy" }]);

    const page = await readSourceItemsPage({ status: "linked" });

    expect(page.items[0]).toMatchObject({
      promoClaimEligible: false,
      promoClaimIneligibleReason: "item_already_active_elsewhere",
    });
    expect(prismaMock.genericTaskItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          targetType: "novel_source_item",
          targetId: { in: ["src-linked-busy"] },
          task: { taskType: "promo_link.claim.v1", status: { in: ["pending", "processing"] } },
        }),
      }),
    );
  });

  it("linked + novelId set + no active-elsewhere hit -> promoClaimEligible=true, reason=null", async () => {
    prismaMock.novelSourceItem.findMany.mockResolvedValue([
      baseRow({ id: "src-linked-free", status: "linked", novelId: "novel-1" }),
    ]);
    prismaMock.novelSourceItem.count.mockResolvedValue(1);
    prismaMock.genericTaskItem.findMany.mockResolvedValue([]);

    const page = await readSourceItemsPage({ status: "linked" });

    expect(page.items[0]).toMatchObject({
      promoClaimEligible: true,
      promoClaimIneligibleReason: null,
    });
  });

  it("mixed page: only the linked rows are included in the cross-task overlap query's targetId list, never the not-linked ones", async () => {
    prismaMock.novelSourceItem.findMany.mockResolvedValue([
      baseRow({ id: "src-pending-1", status: "pending", novelId: null }),
      baseRow({ id: "src-linked-1", status: "linked", novelId: "novel-1" }),
      baseRow({ id: "src-linked-2", status: "linked", novelId: "novel-2" }),
    ]);
    prismaMock.novelSourceItem.count.mockResolvedValue(3);
    prismaMock.genericTaskItem.findMany.mockResolvedValue([{ targetId: "src-linked-2" }]);

    const page = await readSourceItemsPage({});

    expect(prismaMock.genericTaskItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ targetId: { in: ["src-linked-1", "src-linked-2"] } }),
      }),
    );
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get("src-pending-1")).toMatchObject({
      promoClaimEligible: false,
      promoClaimIneligibleReason: "source_not_linked",
    });
    expect(byId.get("src-linked-1")).toMatchObject({
      promoClaimEligible: true,
      promoClaimIneligibleReason: null,
    });
    expect(byId.get("src-linked-2")).toMatchObject({
      promoClaimEligible: false,
      promoClaimIneligibleReason: "item_already_active_elsewhere",
    });
  });
});
