import "./setup-cleanup";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectAdminNovelListItem } from "@/contracts";
import { NovelsBatchPublish } from "@/app/(admin)/novels/_components/novels-batch-publish";

import { NOVEL_ID, NOVEL_ID_B, novelListItem, troubledNovelListItem } from "./fixtures/admin-content";

/**
 * `NovelsBatchPublish` — the `/novels` list's selection + batch-publish
 * toolbar (PR-C3, task item 4). Same discipline as
 * `tests/ui/novel-publish-lifecycle-panel.test.tsx`: only the Server Action
 * module and `next/navigation` are replaced.
 */

const actions = vi.hoisted(() => ({
  publishNovelsBatchAction: vi.fn(),
}));

const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/novels/_actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const NOVELS = [novelListItem(), troubledNovelListItem()].map(projectAdminNovelListItem);

beforeEach(() => {
  actions.publishNovelsBatchAction.mockReset();
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("选择 · NovelsTable 的既有 0-input 断言不受影响", () => {
  it("每行都出现选择框，选中态驱动已选计数", () => {
    render(<NovelsBatchPublish novels={NOVELS} canPublish="granted" />);
    expect(screen.getByText("已选择 0 部")).toBeTruthy();

    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    expect(screen.getByText(/已选择 1 部/)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID_B}`));
    expect(screen.getByText(/已选择 2 部/)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    expect(screen.getByText(/已选择 1 部/)).toBeTruthy();
  });

  it("清空选择按钮把计数归零", () => {
    render(<NovelsBatchPublish novels={NOVELS} canPublish="granted" />);
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    fireEvent.click(screen.getByTestId("batch-publish-clear-selection"));
    expect(screen.getByText("已选择 0 部")).toBeTruthy();
  });

  it("点表头「选择当前页」→ 计数变为本页行数；再点一次 → 归零（C-17）", () => {
    render(<NovelsBatchPublish novels={NOVELS} canPublish="granted" />);
    const header = screen.getByLabelText("选择当前页");
    fireEvent.click(header);
    expect(screen.getByText("已选择 2 部")).toBeTruthy();
    fireEvent.click(header);
    expect(screen.getByText("已选择 0 部")).toBeTruthy();
  });

  it("只勾一行时表头呈半选态；勾满后为满选态（C-17）", () => {
    render(<NovelsBatchPublish novels={NOVELS} canPublish="granted" />);
    const header = screen.getByLabelText("选择当前页") as HTMLInputElement;
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    expect(header.checked).toBe(false);
    expect(header.indeterminate).toBe(true);
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID_B}`));
    expect(header.checked).toBe(true);
    expect(header.indeterminate).toBe(false);
  });

  it("提交中（busy）时表头 checkbox 被禁用（C-17）", async () => {
    let resolveAction!: (value: unknown) => void;
    actions.publishNovelsBatchAction.mockImplementation(
      () => new Promise((resolve) => { resolveAction = resolve; }),
    );
    render(<NovelsBatchPublish novels={NOVELS} canPublish="granted" />);
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    fireEvent.click(screen.getByTestId("batch-publish-submit"));

    const header = screen.getByLabelText("选择当前页") as HTMLInputElement;
    expect(header.disabled).toBe(true);

    await act(async () => {
      resolveAction({
        ok: true,
        data: { items: [], summary: { published: 0, rejected: 0, conflict: 0, notFound: 0, noArticle: 0 } },
      });
    });
  });
});

describe("能力位闸门", () => {
  it("content:publish 被拒时提交按钮被禁用并点名缺口", () => {
    render(<NovelsBatchPublish novels={NOVELS} canPublish="denied" />);
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    const submit = screen.getByTestId("batch-publish-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/内容发布/)).toBeTruthy();
  });
});

describe("提交与逐条结果呈现", () => {
  it("提交把选中的 novelId 数组交给 publishNovelsBatchAction，结果按成功/拒绝/冲突/未找到分组统计", async () => {
    actions.publishNovelsBatchAction.mockResolvedValue({
      ok: true,
      data: {
        items: [
          { kind: "resolved", novelId: NOVEL_ID, articleId: "a1", result: { outcome: "published", articleId: "a1", novelId: NOVEL_ID, locale: "en", firstPublish: true } },
          {
            kind: "resolved",
            novelId: NOVEL_ID_B,
            articleId: "a2",
            result: {
              outcome: "rejected",
              gate: { publishable: false, reasons: ["promo_link_missing"], requiredMetadataMissing: null },
            },
          },
        ],
        summary: { published: 1, rejected: 1, conflict: 0, notFound: 0, noArticle: 0 },
      },
    });

    render(<NovelsBatchPublish novels={NOVELS} canPublish="granted" />);
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID_B}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId("batch-publish-submit"));
    });

    expect(actions.publishNovelsBatchAction).toHaveBeenCalledWith(
      expect.objectContaining({ novelIds: expect.arrayContaining([NOVEL_ID, NOVEL_ID_B]) }),
    );
    const result = await screen.findByTestId("batch-publish-result");
    expect(result.textContent).toContain("成功 1");
    expect(result.textContent).toContain("拒绝 1");
    expect(screen.getByTestId(`batch-publish-item-${NOVEL_ID}`).textContent).toContain("已发布（首次公开）");
    expect(screen.getByTestId(`batch-publish-item-${NOVEL_ID_B}`).textContent).toContain("门禁拒绝");
    expect(screen.getByTestId(`batch-publish-item-${NOVEL_ID_B}`).textContent).toContain("缺少推广链接");
    // 提交后清空选择、刷新页面
    expect(screen.getByText("已选择 0 部")).toBeTruthy();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("冲突项出现「重试冲突项」按钮，点击后只重新提交冲突的 novelId", async () => {
    actions.publishNovelsBatchAction.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          { kind: "resolved", novelId: NOVEL_ID, articleId: "a1", result: { outcome: "conflict" } },
          { kind: "resolved", novelId: NOVEL_ID_B, articleId: "a2", result: { outcome: "published", articleId: "a2", novelId: NOVEL_ID_B, locale: "en", firstPublish: false } },
        ],
        summary: { published: 1, rejected: 0, conflict: 1, notFound: 0, noArticle: 0 },
      },
    });
    actions.publishNovelsBatchAction.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          { kind: "resolved", novelId: NOVEL_ID, articleId: "a1", result: { outcome: "published", articleId: "a1", novelId: NOVEL_ID, locale: "en", firstPublish: true } },
        ],
        summary: { published: 1, rejected: 0, conflict: 0, notFound: 0, noArticle: 0 },
      },
    });

    render(<NovelsBatchPublish novels={NOVELS} canPublish="granted" />);
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID_B}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId("batch-publish-submit"));
    });

    const retry = await screen.findByTestId("batch-publish-retry-conflicts");
    await act(async () => {
      fireEvent.click(retry);
    });

    expect(actions.publishNovelsBatchAction).toHaveBeenCalledTimes(2);
    expect(actions.publishNovelsBatchAction.mock.calls[1][0]).toMatchObject({ novelIds: [NOVEL_ID] });
  });

  it("no_article 项也计入结果并单独统计，不当成失败结果处理", async () => {
    actions.publishNovelsBatchAction.mockResolvedValue({
      ok: true,
      data: {
        items: [{ kind: "no_article", novelId: NOVEL_ID }],
        summary: { published: 0, rejected: 0, conflict: 0, notFound: 0, noArticle: 1 },
      },
    });
    render(<NovelsBatchPublish novels={NOVELS} canPublish="granted" />);
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId("batch-publish-submit"));
    });
    const result = await screen.findByTestId("batch-publish-result");
    expect(result.textContent).toContain("无关联文章 1");
    expect(screen.getByTestId(`batch-publish-item-${NOVEL_ID}`).textContent).toContain("无关联文章");
  });

  it("action 返回 lifecycle_error（批量上限）时展示错误文案，不清空选择", async () => {
    actions.publishNovelsBatchAction.mockResolvedValue({
      ok: false,
      kind: "lifecycle_error",
      code: "batch_too_large",
    });
    render(<NovelsBatchPublish novels={NOVELS} canPublish="granted" />);
    fireEvent.click(screen.getByTestId(`novel-select-${NOVEL_ID}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId("batch-publish-submit"));
    });
    expect(await screen.findByText(/批量发布失败/)).toBeTruthy();
    expect(screen.getByText(/200/)).toBeTruthy();
  });
});

describe("上限 200 的前端提示", () => {
  it(
    "选择超过上限时展示提示并禁用提交按钮",
    () => {
      const many = Array.from({ length: 201 }, (_, index) =>
        projectAdminNovelListItem(
          novelListItem({ id: `24040000-0000-4000-8000-${String(index).padStart(12, "0")}` }),
        ),
      );
      render(<NovelsBatchPublish novels={many} canPublish="granted" />);
      // 201 rows × 201 re-renders is genuinely slow under jsdom (each click
      // re-renders the whole selection-driven table) — this is a real
      // rendering cost, not a hang, hence the longer per-test timeout below
      // rather than mocking the interaction away.
      for (const novel of many) {
        fireEvent.click(screen.getByTestId(`novel-select-${novel.novelId}`));
      }
      expect(screen.getByText(/超过批量发布上限（200 部）/)).toBeTruthy();
      const submit = screen.getByTestId("batch-publish-submit") as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
    },
    20000,
  );
});
