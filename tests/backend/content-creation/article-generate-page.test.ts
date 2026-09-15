import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { NovelGenerateCandidate, NovelGeneratePage, PinnedNovelResult } from "@/domain/article-generation";

const listNovels = vi.fn();
const loadPinned = vi.fn();

vi.mock("@/server/content-creation", () => ({
  listNovelsForArticleGenerate: (...args: unknown[]) => listNovels(...args),
  loadPinnedNovelForArticleGenerate: (...args: unknown[]) => loadPinned(...args),
}));

const { loadArticleGeneratePage, pinnedGenerateError, selectedGenerateTarget } = await import(
  "@/app/(admin)/articles/generate/_lib/load-generate-page"
);

const candidate = (id: string, title = id): NovelGenerateCandidate => ({
  novelId: id,
  title,
  locale: "en",
  businessId: `biz-${id}`,
  hasLiveArticle: false,
  promoReady: true,
  promoOutcome: "ready",
  canGenerateArticle: true,
});

const page = (rows: NovelGenerateCandidate[], total = rows.length): NovelGeneratePage => ({
  rows,
  total,
  page: 1,
  pageSize: 80,
});

describe("loadArticleGeneratePage", () => {
  it("keeps pinned and page separate and never selects page[0] on a failed pin", async () => {
    const firstPage = page([candidate("page-1", "Page One"), candidate("page-2", "Page Two")], 81);
    listNovels.mockResolvedValue(firstPage);
    loadPinned.mockResolvedValue({ status: "missing" } satisfies PinnedNovelResult);

    const model = await loadArticleGeneratePage({} as PrismaClient, {
      novelId: "00000000-0000-4000-8000-000000000201",
      search: "zzz",
    });
    expect(listNovels).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ search: "zzz", page: 1, pageSize: 80, eligibleOnly: false }),
    );
    expect(loadPinned).toHaveBeenCalledWith({}, "00000000-0000-4000-8000-000000000201");
    expect(model.page.total).toBe(81);
    expect(model.page.rows).toHaveLength(2);
    expect(selectedGenerateTarget(model)).toBeNull();
    expect(pinnedGenerateError(model.pinned)).toContain("不存在");
  });

  it("pins a found novel even when it is outside the current search page", async () => {
    const pinned = candidate("pinned-1", "Pinned");
    listNovels.mockResolvedValue(page([candidate("page-1")], 80));
    loadPinned.mockResolvedValue({ status: "found", novel: pinned } satisfies PinnedNovelResult);

    const model = await loadArticleGeneratePage({} as PrismaClient, { novelId: pinned.novelId, search: "other" });
    expect(selectedGenerateTarget(model)).toEqual(pinned);
    expect(model.page.rows.some((row) => row.novelId === pinned.novelId)).toBe(false);
    expect(pinnedGenerateError(model.pinned)).toBeNull();
  });

  it("leaves the form unselected when no novelId is provided", async () => {
    listNovels.mockResolvedValue(page([candidate("page-1")], 1));
    loadPinned.mockResolvedValue({ status: "absent" } satisfies PinnedNovelResult);

    const model = await loadArticleGeneratePage({} as PrismaClient, {});
    expect(selectedGenerateTarget(model)).toBeNull();
    expect(pinnedGenerateError(model.pinned)).toBeNull();
  });
});
