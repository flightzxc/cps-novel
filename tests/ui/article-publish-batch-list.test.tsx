import "./setup-cleanup";

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installDialogShim } from "./jsdom-dialog";

installDialogShim();

/**
 * 文章列表「全选当前筛选 → 后台批量发布（N 篇）」（2026-10-06）。
 *
 * 要点：①只勾当页（没进入跨页全选）时没有这个入口，同步「批量发布」逐字走原路径；
 * ②全选当前筛选后出现「后台批量发布（N 篇）」，点击只调用 enqueue action（带筛选快照与
 * 「暂不抓试读」选项），不走同步循环；③同步按钮在跨页模式下仍是原来的逐批同步循环。
 */

const listActions = vi.hoisted(() => ({
  regenerateArticleAction: vi.fn(),
  regenerateArticlesBatchAction: vi.fn(),
  publishArticleAction: vi.fn(),
  withdrawArticleAction: vi.fn(),
  publishArticlesBatchAction: vi.fn(),
  publishArticlesByFilterChunkAction: vi.fn(),
  enqueueArticlePublishBatchAction: vi.fn(),
}));
const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/articles/_actions", () => listActions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

import { ArticleList, type ArticleListRow } from "@/app/(admin)/articles/_components/article-list";

const ROW: ArticleListRow = {
  id: "article-1", title: "Draft Article", locale: "en", slug: "draft-article", publicPageShortId: "AbCdEf12",
  status: "draft", summary: null, templateKey: "tpl-1", updatedAt: "2026-09-05T02:00:00.000Z",
};
const ROW2: ArticleListRow = { ...ROW, id: "article-2", title: "Draft Article 2", slug: "draft-article-2", publicPageShortId: "XyZ98765" };
const FILTERS = { status: "draft", locale: "en" } as const;

function renderList(props: Partial<Parameters<typeof ArticleList>[0]> = {}) {
  return render(
    <ArticleList
      rows={[ROW, ROW2]}
      canWrite
      publicOrigin="https://novel.test"
      total={29_000}
      filters={FILTERS}
      filterSignature={JSON.stringify(FILTERS)}
      {...props}
    />,
  );
}

function selectAllMatching() {
  fireEvent.click(screen.getByLabelText("选择当前页"));
  fireEvent.click(screen.getByTestId("articles-select-all-matching"));
}

beforeEach(() => {
  for (const action of Object.values(listActions)) action.mockReset();
  routerRefresh.mockReset();
});

describe("ArticleList · 后台批量发布", () => {
  it("只勾当前页（没进入跨页全选）：没有后台批量发布入口，同步批量发布走显式 id 的原路径", async () => {
    listActions.publishArticlesBatchAction.mockResolvedValue({ ok: true, data: { results: [] } });
    renderList();
    fireEvent.click(screen.getByLabelText(`选择 ${ROW.title}`));
    expect(screen.queryByTestId("articles-batch-publish-task")).toBeNull();
    expect(screen.queryByTestId("articles-batch-publish-task-skip-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("articles-batch-publish"));
    await vi.waitFor(() => expect(listActions.publishArticlesBatchAction).toHaveBeenCalledTimes(1));
    expect(listActions.publishArticlesBatchAction.mock.calls[0]![0].articleIds).toEqual([ROW.id]);
    expect(listActions.enqueueArticlePublishBatchAction).not.toHaveBeenCalled();
  });

  it("勾满当前页但还没点「选择全部」：仍然没有后台入口", () => {
    renderList();
    fireEvent.click(screen.getByLabelText("选择当前页"));
    expect(screen.getByTestId("articles-select-all-matching")).toBeTruthy();
    expect(screen.queryByTestId("articles-batch-publish-task")).toBeNull();
  });

  it("全选当前筛选后出现「后台批量发布（N 篇）」，默认不勾「暂不抓试读」", () => {
    renderList();
    selectAllMatching();
    expect(screen.getByTestId("articles-batch-publish-task").textContent).toBe("后台批量发布（29000 篇）");
    const skip = screen.getByTestId("articles-batch-publish-task-skip-preview") as HTMLInputElement;
    expect(skip.checked).toBe(false);
    expect(screen.getByTestId("articles-background-publish-controls").textContent).toContain("发布时暂不抓试读");
  });

  it("点击提交：只调用 enqueue action（筛选快照 + 默认 skipPreview=false + 新的 requestId），不走同步循环，成功后给任务链接并清空选择", async () => {
    listActions.enqueueArticlePublishBatchAction.mockResolvedValue({
      ok: true, data: { taskId: "11111111-1111-4111-8111-111111111111", duplicate: false, draftCount: 28_500 },
    });
    renderList();
    selectAllMatching();
    fireEvent.click(screen.getByTestId("articles-batch-publish-task"));
    await vi.waitFor(() => expect(screen.getByTestId("articles-publish-task-queued")).toBeTruthy());
    expect(listActions.enqueueArticlePublishBatchAction).toHaveBeenCalledTimes(1);
    const input = listActions.enqueueArticlePublishBatchAction.mock.calls[0]![0];
    expect(input.filters).toEqual(FILTERS);
    expect(input.skipPreview).toBe(false);
    expect(typeof input.requestId).toBe("string");
    expect(input.requestId.length).toBeGreaterThan(8);
    expect("articleIds" in input).toBe(false); // 前端从不发送 id 列表
    expect(listActions.publishArticlesByFilterChunkAction).not.toHaveBeenCalled();
    expect(listActions.publishArticlesBatchAction).not.toHaveBeenCalled();
    const banner = screen.getByTestId("articles-publish-task-queued");
    expect(banner.textContent).toContain("待发布草稿 28500 篇");
    expect(screen.getByTestId("articles-publish-task-link").getAttribute("href"))
      .toBe("/tasks/11111111-1111-4111-8111-111111111111?family=generic");
    expect(routerRefresh).toHaveBeenCalled();
    expect(screen.queryByTestId("articles-all-matching-banner")).toBeNull(); // 选择已清空
  });

  it("勾选「发布时暂不抓试读」后 skipPreview=true 随请求下传", async () => {
    listActions.enqueueArticlePublishBatchAction.mockResolvedValue({
      ok: true, data: { taskId: "t-1", duplicate: false, draftCount: 3 },
    });
    renderList();
    selectAllMatching();
    fireEvent.click(screen.getByTestId("articles-batch-publish-task-skip-preview"));
    fireEvent.click(screen.getByTestId("articles-batch-publish-task"));
    await vi.waitFor(() => expect(listActions.enqueueArticlePublishBatchAction).toHaveBeenCalledTimes(1));
    expect(listActions.enqueueArticlePublishBatchAction.mock.calls[0]![0].skipPreview).toBe(true);
  });

  it.each([
    ["no_draft_in_filter", "当前筛选条件下没有草稿可发布"],
    ["selection_too_large", "超过一次后台任务的上限（50000 篇）"],
    ["filter_status_not_draft", "只处理草稿"],
  ])("提交被拒（%s）：给出中文原因并说明没有文章被改动，不展示任务链接", async (code, text) => {
    listActions.enqueueArticlePublishBatchAction.mockResolvedValue({ ok: false, kind: "invalid_input", code });
    renderList();
    selectAllMatching();
    fireEvent.click(screen.getByTestId("articles-batch-publish-task"));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("后台批量发布未提交"));
    expect(screen.getByRole("status").textContent).toContain(text);
    expect(screen.getByRole("status").textContent).toContain("没有文章被改动");
    expect(screen.queryByTestId("articles-publish-task-queued")).toBeNull();
  });

  it("重复请求（duplicate）如实说明是已提交过的任务", async () => {
    listActions.enqueueArticlePublishBatchAction.mockResolvedValue({
      ok: true, data: { taskId: "t-2", duplicate: true, draftCount: 3 },
    });
    renderList();
    selectAllMatching();
    fireEvent.click(screen.getByTestId("articles-batch-publish-task"));
    await vi.waitFor(() => expect(screen.getByTestId("articles-publish-task-queued")).toBeTruthy());
    expect(screen.getByTestId("articles-publish-task-queued").textContent).toContain("已提交过后台批量发布任务");
  });

  it("canWrite=false 时后台批量发布按钮禁用", () => {
    renderList({ canWrite: false });
    selectAllMatching();
    expect((screen.getByTestId("articles-batch-publish-task") as HTMLButtonElement).disabled).toBe(true);
  });

  it("跨页模式下，原来的同步「批量发布」按钮仍然走逐批同步循环（不改动）", async () => {
    listActions.publishArticlesByFilterChunkAction.mockResolvedValue({
      ok: true, data: { results: [], resolvedCount: 0, nextCursor: null },
    });
    renderList();
    selectAllMatching();
    fireEvent.click(screen.getByTestId("articles-batch-publish"));
    await vi.waitFor(() => expect(listActions.publishArticlesByFilterChunkAction).toHaveBeenCalledTimes(1));
    expect(listActions.publishArticlesByFilterChunkAction.mock.calls[0]![0].filters).toEqual(FILTERS);
    expect(listActions.enqueueArticlePublishBatchAction).not.toHaveBeenCalled();
  });

  it("筛选条件变化会清掉跨页全选，后台入口随之消失（不能拿旧筛选去提交）", () => {
    const { rerender } = renderList();
    selectAllMatching();
    expect(screen.getByTestId("articles-batch-publish-task")).toBeTruthy();
    const changed = { status: "draft", locale: "ko" } as const;
    rerender(
      <ArticleList rows={[ROW, ROW2]} canWrite publicOrigin="https://novel.test" total={29_000}
        filters={changed} filterSignature={JSON.stringify(changed)} />,
    );
    expect(screen.queryByTestId("articles-batch-publish-task")).toBeNull();
  });
});
