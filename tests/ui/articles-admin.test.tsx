import "./setup-cleanup";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M7 admin UI bite tests (交接提示词 B-2) + N-7 (optimistic lock threaded
 * from the row/article prop into the Server Action call). Same discipline as
 * `tests/ui/templates-admin.test.tsx`: only the Server Action module and
 * `next/navigation` are replaced, the real components drive the assertions.
 *
 * 🔴 Known gap, not fixed here (out of this bite-test task's scope — see
 * lane report): `ArticleList`/`articles/page.tsx` do not actually implement
 * the locale/status/novel/template list filters the 施工规格 M7 row
 * describes; the list is an unfiltered `take: 200` query. No test below
 * asserts filtering because there is no filtering code to bite-test.
 */

const listActions = vi.hoisted(() => ({
  regenerateArticleAction: vi.fn(),
  regenerateArticlesBatchAction: vi.fn(),
}));

const editorActions = vi.hoisted(() => ({
  updateArticleAction: vi.fn(),
}));

const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/articles/_actions", () => ({ ...listActions, ...editorActions }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

import { ArticleList, type ArticleListRow } from "@/app/(admin)/articles/_components/article-list";
import { ArticleEditor } from "@/app/(admin)/articles/_components/article-editor";

const DRAFT_ROW: ArticleListRow = {
  id: "article-1",
  title: "Draft Article",
  locale: "en",
  slug: "draft-article",
  publicPageShortId: "AbCdEf12",
  status: "draft",
  summary: "A draft summary",
  templateKey: "tpl-1",
  updatedAt: "2026-09-05T02:00:00.000Z",
};

const PUBLISHED_ROW: ArticleListRow = {
  ...DRAFT_ROW,
  id: "article-2",
  title: "Published Article",
  status: "published",
  updatedAt: "2026-09-05T02:30:00.000Z",
};

beforeEach(() => {
  listActions.regenerateArticleAction.mockReset();
  listActions.regenerateArticlesBatchAction.mockReset();
  editorActions.updateArticleAction.mockReset();
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ArticleList · 列表与批量", () => {
  it("渲染标题/状态/模板，未发布文章不出现公开页链接，已发布出现", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite />);
    expect(screen.getByText("Draft Article")).toBeTruthy();
    expect(screen.getByText("Published Article")).toBeTruthy();
    expect(screen.getAllByText("公开页")).toHaveLength(1);
  });

  it("勾选行驱动已选计数，上限 50", () => {
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite />);
    expect(screen.getByText("已选择 0 / 50")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
    expect(screen.getByText("已选择 1 / 50")).toBeTruthy();
  });

  it("单行再生成：expectedUpdatedAt 取该行的 updatedAt（N-7）", async () => {
    listActions.regenerateArticleAction.mockResolvedValue({ ok: true, data: { outcome: "regenerated" } });
    render(<ArticleList rows={[DRAFT_ROW]} canWrite />);
    fireEvent.click(screen.getByText("再生成"));
    await vi.waitFor(() => expect(listActions.regenerateArticleAction).toHaveBeenCalledTimes(1));
    expect(listActions.regenerateArticleAction.mock.calls[0]![0]).toMatchObject({
      articleId: DRAFT_ROW.id,
      expectedUpdatedAt: DRAFT_ROW.updatedAt,
    });
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it("单行再生成遇到 conflict outcome 时给出可读提示", async () => {
    listActions.regenerateArticleAction.mockResolvedValue({ ok: true, data: { outcome: "conflict" } });
    render(<ArticleList rows={[DRAFT_ROW]} canWrite />);
    fireEvent.click(screen.getByText("再生成"));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("已被其他操作人修改"));
  });

  it("批量再生成调用 regenerateArticlesBatchAction 并携带已选 id", async () => {
    listActions.regenerateArticlesBatchAction.mockResolvedValue({
      ok: true,
      data: { counts: { regenerated: 1, skipped: 0, failed: 0, not_processed: 0 } },
    });
    render(<ArticleList rows={[DRAFT_ROW, PUBLISHED_ROW]} canWrite />);
    fireEvent.click(screen.getByLabelText(`选择 ${DRAFT_ROW.title}`));
    fireEvent.click(screen.getByText("批量再生成"));
    await vi.waitFor(() => expect(listActions.regenerateArticlesBatchAction).toHaveBeenCalledTimes(1));
    expect(listActions.regenerateArticlesBatchAction.mock.calls[0]![0].articleIds).toEqual([DRAFT_ROW.id]);
    await vi.waitFor(() => expect(screen.getByText(/成功 1/)).toBeTruthy());
  });

  it("canWrite=false 时批量按钮禁用", () => {
    render(<ArticleList rows={[DRAFT_ROW]} canWrite={false} />);
    expect((screen.getByText("批量再生成") as HTMLButtonElement).disabled).toBe(true);
  });
});

const ARTICLE = {
  id: "article-1",
  title: "Some Title",
  summary: "Some summary",
  body: "<p>Body content</p>",
  seoMetadata: { metaTitle: "Meta title", metaDescription: "Meta description" },
  slug: "some-slug",
  publicPageShortId: "AbCdEf12",
  updatedAt: "2026-09-05T02:00:00.000Z",
};

describe("ArticleEditor · 编辑与预览", () => {
  it("渲染 slug/shortId 只读展示与正文预览", () => {
    render(<ArticleEditor article={ARTICLE} canWrite />);
    expect(screen.getByText(/slug: some-slug/)).toBeTruthy();
    expect(screen.getByText(/shortId: AbCdEf12/)).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
  });

  it("提交时把 article.updatedAt 作为 expectedUpdatedAt 传给 updateArticleAction（N-7）", async () => {
    editorActions.updateArticleAction.mockResolvedValue({ ok: true });
    render(<ArticleEditor article={ARTICLE} canWrite />);
    fireEvent.click(screen.getByText("保存"));
    await vi.waitFor(() => expect(editorActions.updateArticleAction).toHaveBeenCalledTimes(1));
    expect(editorActions.updateArticleAction.mock.calls[0]![0]).toMatchObject({
      articleId: ARTICLE.id,
      expectedUpdatedAt: ARTICLE.updatedAt,
    });
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("已保存"));
  });

  it("conflict 错误码渲染为可读中文提示而不是裸错误码", async () => {
    editorActions.updateArticleAction.mockResolvedValue({ ok: false, code: "article_conflict" });
    render(<ArticleEditor article={ARTICLE} canWrite />);
    fireEvent.click(screen.getByText("保存"));
    await vi.waitFor(() => expect(screen.getByRole("status").textContent).toContain("已被其他操作人修改"));
  });

  it("正文编辑同步更新预览", () => {
    render(<ArticleEditor article={ARTICLE} canWrite />);
    const textarea = screen.getByDisplayValue("<p>Body content</p>") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "<p>Updated</p>" } });
    expect(screen.getByText("Updated")).toBeTruthy();
  });

  it("canWrite=false 时保存按钮禁用", () => {
    render(<ArticleEditor article={ARTICLE} canWrite={false} />);
    expect((screen.getByText("保存") as HTMLButtonElement).disabled).toBe(true);
  });
});
