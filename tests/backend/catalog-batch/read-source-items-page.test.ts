import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  novelSourceItem: { findMany: vi.fn(), count: vi.fn() },
  genericTaskItem: { findMany: vi.fn() },
  // B-4: `readSourceItemsPage` now unconditionally resolves the
  // promo-link-status ID sets (for the "领取资格" column) before building
  // its `where` clause -- these two stub to "nothing claimed / nothing in
  // manual review" by default so every pre-existing test in this file (none
  // of which cares about promo-link status) is unaffected.
  promoLink: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: prismaMock }));

const { readSourceItemsPage } = await import("@/app/(admin)/catalog-sync/_lib/read-source-items");

describe("catalog source page query contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.novelSourceItem.findMany.mockResolvedValue([]);
    prismaMock.novelSourceItem.count.mockResolvedValue(0);
    prismaMock.promoLink.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);
  });

  it("defaults to page 1 with 100 rows and a deterministic last-seen/id order", async () => {
    const page = await readSourceItemsPage({});

    expect(page).toMatchObject({ page: 1, pageSize: 100, total: 0, totalPages: 1 });
    expect(prismaMock.novelSourceItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 0,
      take: 100,
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    }));
  });

  it.each([
    ["50", 50],
    ["100", 100],
    ["200", 200],
  ])("accepts the supported page size %s", async (pageSize, expected) => {
    await readSourceItemsPage({ page: "2", pageSize });

    expect(prismaMock.novelSourceItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: expected,
      take: expected,
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    }));
  });

  it.each([undefined, "", "49", "101", "not-a-number"])(
    "falls back to 100 for unsupported page size %s",
    async (pageSize) => {
      await readSourceItemsPage({ pageSize });
      expect(prismaMock.novelSourceItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    },
  );
});
