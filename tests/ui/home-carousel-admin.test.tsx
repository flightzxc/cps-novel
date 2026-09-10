import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/home-carousel` admin page (N-5/N-6). Follows
 * `tests/ui/novel-publish-lifecycle-panel.test.tsx`'s discipline: only the
 * Server Action module and `next/navigation` are replaced — the component's
 * own branching (which buttons render, whether `window.confirm` gates the
 * delete, the position dropdown bound to `config.slotCount`) goes through
 * the real `CarouselManager`.
 */

const actions = vi.hoisted(() => ({
  saveCarouselConfigAction: vi.fn(),
  saveManualCarouselSlotAction: vi.fn(),
  enqueueCarouselComputeAction: vi.fn(),
  deleteManualCarouselSlotAction: vi.fn(),
}));
const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/home-carousel/_actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

import { CarouselManager } from "@/app/(admin)/home-carousel/_components/carousel-manager";

const CONFIG = { slotCount: 5, newSlotCount: 1, newNovelWindowDays: 14, cronSchedule: "0 3 * * *", cronTimezone: "Asia/Shanghai", cronEnabled: true };
const SLOTS = [{ id: "slot-1", position: 1, articleId: "article-1", enabled: true, title: "Novel One" }];
const ARTICLES = [{ id: "article-1", title: "Novel One" }, { id: "article-2", title: "Novel Two" }];
const LATEST_BATCH = { id: "batch-1234", status: "success", triggerSource: "cron", createdAt: new Date("2026-09-05T03:00:00.000Z"), finishedAt: new Date("2026-09-05T03:00:05.000Z") };
const CANDIDATES = [{ id: "cand-1", rank: 1, source: "new_novel", title: "Fresh Novel" }, { id: "cand-2", rank: 2, source: "recency", title: "Recent Novel" }];
const SERVING = [{ id: "serve-1", position: 1, source: "manual", title: "Novel One" }, { id: "serve-2", position: 2, source: "recency", title: "Latest Pick" }];
const CHANGE_LOG = [{ id: "1", action: "manual.create", actorType: "admin", actorId: "admin-1", createdAt: "2026-09-05T03:00:00.000Z" }];

function renderManager(overrides: Partial<Parameters<typeof CarouselManager>[0]> = {}) {
  return render(
    <CarouselManager
      config={overrides.config ?? CONFIG}
      slots={overrides.slots ?? SLOTS}
      articles={overrides.articles ?? ARTICLES}
      latestBatch={overrides.latestBatch === undefined ? LATEST_BATCH : overrides.latestBatch}
      candidates={overrides.candidates ?? CANDIDATES}
      serving={overrides.serving ?? SERVING}
      changeLog={overrides.changeLog ?? CHANGE_LOG}
    />,
  );
}

beforeEach(() => {
  actions.saveCarouselConfigAction.mockReset().mockResolvedValue({ ok: true, data: CONFIG });
  actions.saveManualCarouselSlotAction.mockReset().mockResolvedValue({ ok: true, data: {} });
  actions.enqueueCarouselComputeAction.mockReset().mockResolvedValue({ ok: true, data: { status: "enqueued", taskId: "task-1" } });
  actions.deleteManualCarouselSlotAction.mockReset().mockResolvedValue({ ok: true, data: {} });
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CarouselManager · three read-only blocks (N-6)", () => {
  it("renders the latest-batch candidates block, ranked", () => {
    renderManager();
    expect(screen.getByText("最新批候选")).toBeTruthy();
    expect(screen.getByText(/1\. Fresh Novel/)).toBeTruthy();
    expect(screen.getByText(/2\. Recent Novel/)).toBeTruthy();
  });

  it("renders the serving preview block, positioned and sourced", () => {
    renderManager();
    expect(screen.getByText("Serving 预览")).toBeTruthy();
    expect(screen.getByText(/1\. Novel One（人工位）/)).toBeTruthy();
    expect(screen.getByText(/2\. Latest Pick（最近更新）/)).toBeTruthy();
  });

  it("renders the change log block, most-recent read-only", () => {
    renderManager();
    expect(screen.getByText(/Change Log/)).toBeTruthy();
    expect(screen.getByText(/manual\.create/)).toBeTruthy();
  });

  it("shows empty states when there is nothing yet (no compute has ever run)", () => {
    renderManager({ latestBatch: null, candidates: [], serving: [], changeLog: [] });
    expect(screen.getByText("暂无候选，尚未运行过计算")).toBeTruthy();
    expect(screen.getByText("当前无 serving 快照，前台将回落到最近更新")).toBeTruthy();
    expect(screen.getByText("暂无记录")).toBeTruthy();
  });
});

describe("CarouselManager · manual slot CRUD (N-5)", () => {
  it("adds a manual slot with the selected position and article", async () => {
    renderManager();
    const positionSelect = screen.getByLabelText("位置") as HTMLSelectElement;
    fireEvent.change(positionSelect, { target: { value: "2" } });
    const articleSelect = screen.getByLabelText("已发布文章") as HTMLSelectElement;
    fireEvent.change(articleSelect, { target: { value: "article-2" } });
    fireEvent.click(screen.getByText("添加人工位"));
    await waitFor(() => expect(actions.saveManualCarouselSlotAction).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "en", position: 2, articleId: "article-2", enabled: true }),
    ));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it("toggles a slot's enabled state without deleting it", async () => {
    renderManager();
    fireEvent.click(screen.getByText("停用"));
    await waitFor(() => expect(actions.saveManualCarouselSlotAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "slot-1", enabled: false }),
    ));
    expect(actions.deleteManualCarouselSlotAction).not.toHaveBeenCalled();
  });

  it("deletes a slot only after the operator confirms", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    renderManager();
    fireEvent.click(screen.getByText("删除"));
    expect(window.confirm).toHaveBeenCalled();
    expect(actions.deleteManualCarouselSlotAction).not.toHaveBeenCalled();
  });

  it("deletes a slot when the operator confirms", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderManager();
    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(actions.deleteManualCarouselSlotAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "slot-1", locale: "en" }),
    ));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it("bounds the position dropdown to config.slotCount, not a hardcoded 5", () => {
    renderManager({ config: { ...CONFIG, slotCount: 3 }, slots: [] });
    const positionSelect = screen.getByLabelText("位置") as HTMLSelectElement;
    const options = [...positionSelect.options].map((option) => option.value);
    expect(options).toEqual(["1", "2", "3"]);
  });
});

describe("CarouselManager · config form (schedule/timezone/enabled)", () => {
  it("submits the cron schedule, timezone and enabled flag as entered", async () => {
    renderManager();
    fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "0 4 * * *" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Asia/Tokyo" } });
    const checkbox = screen.getByLabelText("启用 cron") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText("保存配置"));
    await waitFor(() => expect(actions.saveCarouselConfigAction).toHaveBeenCalledWith(
      expect.objectContaining({ cronSchedule: "0 4 * * *", cronTimezone: "Asia/Tokyo", cronEnabled: false }),
    ));
  });

  it("enqueues an immediate recompute independent of the config form", async () => {
    renderManager();
    fireEvent.click(screen.getByText("入队重新计算"));
    await waitFor(() => expect(actions.enqueueCarouselComputeAction).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "en" }),
    ));
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toContain("enqueued");
  });
});
