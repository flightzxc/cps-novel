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
    canGenerateArticle: true,
  };
}

function page(rows: NovelGenerateCandidate[], overrides: Partial<NovelGeneratePage> = {}): NovelGeneratePage {
  const generatableCount = rows.filter((row) => row.canGenerateArticle).length;
  return {
    rows,
    total: rows.length,
    page: 1,
    pageSize: 50,
    generatableCount,
    nonGeneratableCount: rows.length - generatableCount,
    ...overrides,
  };
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
  it("keeps promo-blocked novels visible but unselectable while all_filtered stays available", () => {
    const blocked = {
      ...novel(ID_EN, "en", "Missing promo"),
      promoReady: false,
      promoOutcome: "promo_link_missing" as const,
      canGenerateArticle: false,
      generateBlockedReason: "promo_link_missing" as const,
    };
    render(<ArticleBatchGenerateForm initialPage={page([blocked])} templates={[]} canWrite />);
    expect(screen.getByText(/Missing promo.*缺少推广链接/)).toBeTruthy();
    expect((screen.getByTestId(`select-${ID_EN}`) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("submit-selected") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("submit-filtered") as HTMLButtonElement).disabled).toBe(false);
  });

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

  it("reports explicit admission counts returned by the server", async () => {
    actions.enqueueArticleGenerateBatchAction.mockResolvedValue({
      ok: true,
      taskId: "task-admission",
      duplicate: false,
      admission: {
        selectedCount: 2,
        submittedCount: 1,
        blockedCount: 1,
        blockedReasonCounts: { promo_link_not_ready: 1 },
      },
    });
    const two = page([novel(ID_EN, "en", "One"), novel(ID_EN_2, "en", "Two")]);
    render(<ArticleBatchGenerateForm initialPage={two} templates={[]} canWrite />);
    fireEvent.click(screen.getByTestId(`select-${ID_EN}`));
    fireEvent.click(screen.getByTestId(`select-${ID_EN_2}`));
    fireEvent.click(screen.getByTestId("submit-selected"));
    expect((await screen.findByTestId("batch-message")).textContent)
      .toContain("已选 2 本，实际提交 1 本，准入阻断 1 本");
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

  it("applies a canonical filter so padded search/locale cannot widen enqueue scope", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: page([novel(ID_EN, "en", "Alpha book")], { total: 1 }),
      templates: [],
    });
    actions.enqueueArticleGenerateBatchAction
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, taskId: "task-alpha", duplicate: false });

    render(<ArticleBatchGenerateForm initialPage={EN_PAGE} templates={[]} canWrite />);
    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: "Alpha " } });
    fireEvent.change(screen.getByTestId("batch-locale"), { target: { value: " en " } });
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    expect(actions.listArticleGenerateCandidatesAction.mock.calls[0][0]).toMatchObject({
      search: "Alpha",
      locale: "en",
      page: 1,
    });
    expect(screen.getByTestId("applied-total").getAttribute("data-applied-search")).toBe("Alpha");
    expect(screen.getByTestId("applied-total").getAttribute("data-applied-locale")).toBe("en");

    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: " Alpha " } });
    expect(screen.queryByTestId("filter-dirty")).toBeNull();

    fireEvent.click(screen.getByTestId("submit-filtered"));
    expect((await screen.findByTestId("batch-message")).textContent).toContain("提交结果未知");
    fireEvent.click(screen.getByTestId("submit-filtered"));
    await waitFor(() => expect(actions.enqueueArticleGenerateBatchAction).toHaveBeenCalledTimes(2));
    const frozen = actions.enqueueArticleGenerateBatchAction.mock.calls[0][0];
    expect(frozen.selection).toEqual({ scope: "all_filtered", filter: { search: "Alpha", locale: "en" } });
    expect(actions.enqueueArticleGenerateBatchAction.mock.calls[1][0]).toEqual(frozen);
  });

  it("treats blank search/locale as unset after apply", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: EN_PAGE,
      templates: [],
    });
    render(<ArticleBatchGenerateForm initialPage={EN_PAGE} templates={[]} canWrite />);
    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: "   " } });
    fireEvent.change(screen.getByTestId("batch-locale"), { target: { value: "  " } });
    expect(screen.queryByTestId("filter-dirty")).toBeNull();
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    expect(actions.listArticleGenerateCandidatesAction.mock.calls[0][0]).not.toHaveProperty("search");
    expect(actions.listArticleGenerateCandidatesAction.mock.calls[0][0]).not.toHaveProperty("locale");
    expect(screen.getByTestId("applied-total").getAttribute("data-applied-search")).toBe("");
    expect(screen.getByTestId("applied-total").getAttribute("data-applied-locale")).toBe("");
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

  it("shows the generatable/non-generatable/page split and a toggle labelled with the blocked count", () => {
    const mixed = page([novel(ID_EN, "en", "Ready one")], { generatableCount: 7, nonGeneratableCount: 3, total: 7 });
    render(<ArticleBatchGenerateForm initialPage={mixed} templates={[]} canWrite />);
    const banner = screen.getByTestId("applied-total").textContent ?? "";
    expect(banner).toContain("可生成 7 本");
    expect(banner).toContain("另有 3 本不可生成");
    expect(banner).toContain("本页 1 本");
    expect(screen.getByTestId("toggle-show-ineligible").parentElement?.textContent).toContain("显示不可生成（3 本）");
    expect((screen.getByTestId("toggle-show-ineligible") as HTMLInputElement).checked).toBe(false);
  });

  it("toggling 显示不可生成 reloads page 1 with showIneligible=true, without touching the filter or its dirty state", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: page([novel(ID_EN, "en", "Ready one"), {
        ...novel(ID_EN_2, "en", "Blocked one"),
        canGenerateArticle: false,
        promoReady: false,
        promoOutcome: "promo_link_missing" as const,
        generateBlockedReason: "promo_link_missing" as const,
      }], { generatableCount: 1, nonGeneratableCount: 1, total: 2 }),
      templates: [],
    });
    render(
      <ArticleBatchGenerateForm
        initialPage={page([], { generatableCount: 1, nonGeneratableCount: 1, total: 1 })}
        templates={[]}
        canWrite
      />,
    );
    fireEvent.click(screen.getByTestId("toggle-show-ineligible"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    expect(actions.listArticleGenerateCandidatesAction.mock.calls[0][0]).toMatchObject({
      page: 1,
      showIneligible: true,
    });
    expect(screen.queryByTestId("filter-dirty")).toBeNull();
    await waitFor(() => expect(screen.getByText("Blocked one · en · biz-1112 · 缺少推广链接")).toBeTruthy());
    expect((screen.getByTestId(`select-${ID_EN_2}`) as HTMLInputElement).disabled).toBe(true);
  });

  it("submitting all_filtered never includes showIneligible in the enqueued selection", async () => {
    const onlyOne = page([novel(ID_EN, "en", "Only one")], { total: 1 });
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({ ok: true, data: onlyOne, templates: [] });
    actions.enqueueArticleGenerateBatchAction.mockResolvedValueOnce({ ok: true, taskId: "task-toggle", duplicate: false });
    render(<ArticleBatchGenerateForm initialPage={onlyOne} templates={[]} canWrite />);
    fireEvent.click(screen.getByTestId("toggle-show-ineligible"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("submit-filtered"));
    await waitFor(() => expect(actions.enqueueArticleGenerateBatchAction).toHaveBeenCalled());
    const call = actions.enqueueArticleGenerateBatchAction.mock.calls[0][0];
    expect(JSON.stringify(call)).not.toMatch(/showIneligible/);
  });
});
