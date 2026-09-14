import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NovelGenerateCandidate, NovelGeneratePage } from "@/domain/article-generation";

const actions = vi.hoisted(() => ({
  listArticleGenerateCandidatesAction: vi.fn(),
  enqueueArticleGenerateBatchAction: vi.fn(),
}));

vi.mock("@/app/(admin)/articles/_actions", () => actions);

const { ArticleBatchGenerateForm } = await import(
  "@/app/(admin)/articles/batch-generate/_components/batch-generate-form"
);

const ID_EN = "11111111-1111-4111-8111-111111111111";
const ID_EN_2 = "11111111-1111-4111-8111-111111111112";
const ID_JA = "22222222-2222-4222-8222-222222222222";

function novel(id: string, locale: string, title: string): NovelGenerateCandidate {
  return {
    novelId: id,
    title,
    locale,
    businessId: `biz-${id.slice(-4)}`,
    hasLiveArticle: false,
    promoReady: true,
    promoOutcome: "ready",
  };
}

function page(rows: NovelGenerateCandidate[], overrides: Partial<NovelGeneratePage> = {}): NovelGeneratePage {
  return { rows, total: rows.length, page: 1, pageSize: 50, ...overrides };
}

const EN_PAGE = page(
  Array.from({ length: 10 }, (_, index) =>
    novel(`11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, "en", `Old ${index + 1}`),
  ),
  { total: 10 },
);

beforeEach(() => {
  actions.listArticleGenerateCandidatesAction.mockReset();
  actions.enqueueArticleGenerateBatchAction.mockReset();
});

describe("ArticleBatchGenerateForm (R2-02 / R2-03 / R2-04)", () => {
  it("keeps the applied 10-book list when search is cleared without applying", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: EN_PAGE,
      templates: [{ templateKey: "en-default", locale: "en", version: 1 }],
    });
    render(
      <ArticleBatchGenerateForm
        initialPage={EN_PAGE}
        templates={[{ templateKey: "en-default", locale: "en", version: 1 }]}
        canWrite
      />,
    );
    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: "old" } });
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: "" } });
    expect(screen.getByTestId("filter-dirty")).toBeTruthy();
    expect(screen.getByTestId("applied-total").textContent).toContain("10");
    expect(screen.getByText("Old 1 · en · biz-0001")).toBeTruthy();
    expect((screen.getByTestId("submit-filtered") as HTMLButtonElement).disabled).toBe(true);
    expect(actions.enqueueArticleGenerateBatchAction).not.toHaveBeenCalled();
  });

  it("keeps the previous page when apply fails", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: false,
      kind: "access_denied",
      code: "article_generate_list_denied",
    });
    render(<ArticleBatchGenerateForm initialPage={EN_PAGE} templates={[]} canWrite />);
    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: "ghost" } });
    fireEvent.click(screen.getByTestId("apply-filter"));
    expect((await screen.findByTestId("batch-message")).textContent).toContain("已保留当前筛选与页码");
    expect(screen.getByTestId("applied-total").textContent).toContain("10");
    expect(screen.getByText("Old 1 · en · biz-0001")).toBeTruthy();
    expect(screen.getByTestId("filter-dirty")).toBeTruthy();
  });

  it("resets explicit selection when a new filter is applied, but keeps it across pagination", async () => {
    const page1 = page([novel(ID_EN, "en", "Page one")], { total: 60 });
    const page2 = page([novel(ID_EN_2, "en", "Page two")], { total: 60, page: 2 });
    const jaPage = page([novel(ID_JA, "ja", "日本語")], { total: 1 });
    actions.listArticleGenerateCandidatesAction
      .mockResolvedValueOnce({ ok: true, data: page2, templates: [] })
      .mockResolvedValueOnce({ ok: true, data: page1, templates: [] })
      .mockResolvedValueOnce({
        ok: true,
        data: jaPage,
        templates: [{ templateKey: "ja-body", locale: "ja", version: 3 }],
      });

    render(
      <ArticleBatchGenerateForm
        initialPage={page1}
        templates={[{ templateKey: "en-default", locale: "en", version: 1 }]}
        canWrite
      />,
    );
    fireEvent.click(screen.getByTestId(`select-${ID_EN}`));
    expect((screen.getByTestId(`select-${ID_EN}`) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("next-page"));
    await waitFor(() => expect(screen.getByText("Page two · en · biz-1112")).toBeTruthy());
    fireEvent.click(screen.getByTestId("prev-page"));
    await waitFor(() => expect((screen.getByTestId(`select-${ID_EN}`) as HTMLInputElement).checked).toBe(true));

    fireEvent.change(screen.getByTestId("batch-locale"), { target: { value: "ja" } });
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(screen.getByText("日本語 · ja · biz-2222")).toBeTruthy());
    expect((screen.getByTestId(`select-${ID_JA}`) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("submit-selected") as HTMLButtonElement).disabled).toBe(true);
  });

  it("replays the frozen payload after an unknown result and rotates requestId only after success", async () => {
    actions.enqueueArticleGenerateBatchAction
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, taskId: "task-1", duplicate: false })
      .mockResolvedValueOnce({ ok: true, taskId: "task-2", duplicate: false });

    render(
      <ArticleBatchGenerateForm
        initialPage={page([novel(ID_EN, "en", "Only one")], { total: 1 })}
        templates={[{ templateKey: "en-default", locale: "en", version: 1 }]}
        canWrite
      />,
    );
    fireEvent.change(screen.getByTestId("template-en"), { target: { value: "en-default" } });
    fireEvent.click(screen.getByTestId("submit-filtered"));
    expect((await screen.findByTestId("batch-message")).textContent).toContain("提交结果未知");
    expect((screen.getByTestId("batch-search") as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("submit-filtered"));
    await waitFor(() => expect(actions.enqueueArticleGenerateBatchAction).toHaveBeenCalledTimes(2));
    const first = actions.enqueueArticleGenerateBatchAction.mock.calls[0][0];
    const replay = actions.enqueueArticleGenerateBatchAction.mock.calls[1][0];
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      selection: { scope: "all_filtered", filter: {} },
      templateKeysByLocale: { en: "en-default" },
    });
    await waitFor(() => expect(screen.getByText("查看任务")).toBeTruthy());

    fireEvent.click(screen.getByTestId(`select-${ID_EN}`));
    fireEvent.click(screen.getByTestId("submit-selected"));
    await waitFor(() => expect(actions.enqueueArticleGenerateBatchAction).toHaveBeenCalledTimes(3));
    const secondRound = actions.enqueueArticleGenerateBatchAction.mock.calls[2][0];
    expect(secondRound.requestId).not.toBe(first.requestId);
    expect(secondRound.selection).toEqual({ scope: "explicit_ids", novelIds: [ID_EN] });
  });

  it("shows request_replay_mismatch without rotating the request", async () => {
    actions.enqueueArticleGenerateBatchAction.mockResolvedValue({
      ok: false,
      kind: "invalid_input",
      code: "request_replay_mismatch",
    });
    render(
      <ArticleBatchGenerateForm
        initialPage={page([novel(ID_EN, "en", "Only one")], { total: 1 })}
        templates={[]}
        canWrite
      />,
    );
    fireEvent.click(screen.getByTestId("submit-filtered"));
    expect((await screen.findByTestId("batch-message")).textContent).toContain("request_replay_mismatch");
    fireEvent.click(screen.getByTestId("submit-filtered"));
    await waitFor(() => expect(actions.enqueueArticleGenerateBatchAction).toHaveBeenCalledTimes(2));
    expect(actions.enqueueArticleGenerateBatchAction.mock.calls[0][0].requestId)
      .toBe(actions.enqueueArticleGenerateBatchAction.mock.calls[1][0].requestId);
  });

  it("fetches and caches ja templates when a later page introduces that locale", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: page([novel(ID_JA, "ja", "日本語")], { total: 51, page: 2 }),
      templates: [{ templateKey: "ja-body", locale: "ja", version: 3 }],
    });
    render(
      <ArticleBatchGenerateForm
        initialPage={page([novel(ID_EN, "en", "English")], { total: 51 })}
        templates={[{ templateKey: "en-default", locale: "en", version: 1 }]}
        canWrite
      />,
    );
    expect(screen.getByTestId("template-en")).toBeTruthy();
    expect(screen.queryByTestId("template-ja")).toBeNull();
    fireEvent.click(screen.getByTestId("next-page"));
    await waitFor(() => expect(screen.getByTestId("template-ja")).toBeTruthy());
    expect(screen.getByRole("option", { name: "ja-body · v3" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "en-default · v1" })).toBeTruthy();
  });
});
