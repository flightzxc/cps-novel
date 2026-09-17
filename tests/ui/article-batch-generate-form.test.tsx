import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARTICLE_GENERATE_LEAF_MAX,
  articleGenerateBlockedReasonLabel,
  type ArticleTemplateOption,
  type NovelGenerateCandidate,
  type NovelGeneratePage,
} from "@/domain/article-generation";
import { formatDateTime } from "@/features/admin-ui/datetime";
import { SITE_LOCALE_LABELS, type SiteLocale } from "@/lib/locale/locale-canonical";

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

const DEFAULT_UPDATED_AT = "2026-01-01T00:00:00.000Z";

function novel(id: string, locale: string, title: string): NovelGenerateCandidate {
  return {
    novelId: id,
    title,
    locale,
    businessId: `biz-${id.slice(-4)}`,
    updatedAt: DEFAULT_UPDATED_AT,
    hasLiveArticle: false,
    promoReady: true,
    promoOutcome: "ready",
    canGenerateArticle: true,
  };
}

/** Builds the exact row text the component renders — title, Chinese locale
 * label (falling back to the raw code, same as the component), businessId,
 * formatted `updatedAt`, and the blocked-reason suffix when present — so
 * assertions never hand-duplicate `formatDateTime`'s own output format. */
function rowText(n: NovelGenerateCandidate): string {
  const label = SITE_LOCALE_LABELS[n.locale as SiteLocale] ?? n.locale;
  const base = `${n.title} · ${label} · ${n.businessId} · 更新于 ${formatDateTime(n.updatedAt)}`;
  return n.generateBlockedReason
    ? `${base} · ${articleGenerateBlockedReasonLabel(n.generateBlockedReason)}`
    : base;
}

/** Builds an `ArticleTemplateOption` fixture — `templateName` defaults to a
 * readable Chinese label derived from the key so option-name assertions stay
 * legible without every call site inventing its own. */
function template(templateKey: string, locale: string, version: number, templateName = `${templateKey}模板`): ArticleTemplateOption {
  return { templateKey, templateName, locale, version };
}

/** Default `localeCounts`: derived from `rows` unless a test overrides it — most tests don't care
 * about the locale chip population, but the ones below that click a chip for a locale absent from
 * the current page pass an explicit override (the chip population is the full filtered set, not
 * just the current page's rows). */
function localeCountsFromRows(rows: readonly NovelGenerateCandidate[]) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.locale, (counts.get(row.locale) ?? 0) + 1);
  return Array.from(counts, ([locale, count]) => ({ locale, count })).sort((a, b) => a.locale.localeCompare(b.locale));
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
    localeCounts: localeCountsFromRows(rows),
    ...overrides,
  };
}

const EN_PAGE = page(
  Array.from({ length: 10 }, (_, index) =>
    novel(`11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, "en", `Old ${index + 1}`),
  ),
  { total: 10 },
);

function localeChip(locale: string) {
  return screen.getByTestId(`batch-locale-chip-${locale}`);
}

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
      templates: [template("en-default", "en", 1)],
    });
    render(
      <ArticleBatchGenerateForm
        initialPage={EN_PAGE}
        templates={[template("en-default", "en", 1)]}
        canWrite
      />,
    );
    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: "old" } });
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: "" } });
    expect(screen.getByTestId("filter-dirty")).toBeTruthy();
    expect(screen.getByTestId("applied-total").textContent).toContain("10");
    expect(screen.getByText(rowText(EN_PAGE.rows[0]!))).toBeTruthy();
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
    expect(screen.getByText(rowText(EN_PAGE.rows[0]!))).toBeTruthy();
    expect(screen.getByTestId("filter-dirty")).toBeTruthy();
  });

  it("resets explicit selection when a new filter is applied, but keeps it across pagination", async () => {
    // `localeCounts` includes "ja" even though these pages' rows are all
    // "en" — the chip population comes from the full filtered set, not the
    // current page, so the operator can pick "ja" before ever seeing a ja row.
    const localeCounts = [{ locale: "en", count: 60 }, { locale: "ja", count: 1 }];
    const page1 = page([novel(ID_EN, "en", "Page one")], { total: 60, localeCounts });
    const page2 = page([novel(ID_EN_2, "en", "Page two")], { total: 60, page: 2, localeCounts });
    const jaPage = page([novel(ID_JA, "ja", "日本語")], { total: 1 });
    actions.listArticleGenerateCandidatesAction
      .mockResolvedValueOnce({ ok: true, data: page2, templates: [] })
      .mockResolvedValueOnce({ ok: true, data: page1, templates: [] })
      .mockResolvedValueOnce({
        ok: true,
        data: jaPage,
        templates: [template("ja-body", "ja", 3)],
      });

    render(
      <ArticleBatchGenerateForm
        initialPage={page1}
        templates={[template("en-default", "en", 1)]}
        canWrite
      />,
    );
    fireEvent.click(screen.getByTestId(`select-${ID_EN}`));
    expect((screen.getByTestId(`select-${ID_EN}`) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("next-page"));
    await waitFor(() => expect(screen.getByText(rowText(page2.rows[0]!))).toBeTruthy());
    fireEvent.click(screen.getByTestId("prev-page"));
    await waitFor(() => expect((screen.getByTestId(`select-${ID_EN}`) as HTMLInputElement).checked).toBe(true));

    fireEvent.click(localeChip("ja"));
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(screen.getByText(rowText(jaPage.rows[0]!))).toBeTruthy());
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
        templates={[template("en-default", "en", 1)]}
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

  it("applies a canonical filter so padded search cannot widen enqueue scope", async () => {
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
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    expect(actions.listArticleGenerateCandidatesAction.mock.calls[0][0]).toMatchObject({
      search: "Alpha",
      page: 1,
    });
    expect(screen.getByTestId("applied-total").getAttribute("data-applied-search")).toBe("Alpha");

    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: " Alpha " } });
    expect(screen.queryByTestId("filter-dirty")).toBeNull();

    fireEvent.click(screen.getByTestId("submit-filtered"));
    expect((await screen.findByTestId("batch-message")).textContent).toContain("提交结果未知");
    fireEvent.click(screen.getByTestId("submit-filtered"));
    await waitFor(() => expect(actions.enqueueArticleGenerateBatchAction).toHaveBeenCalledTimes(2));
    const frozen = actions.enqueueArticleGenerateBatchAction.mock.calls[0][0];
    expect(frozen.selection).toEqual({ scope: "all_filtered", filter: { search: "Alpha" } });
    expect(actions.enqueueArticleGenerateBatchAction.mock.calls[1][0]).toEqual(frozen);
  });

  it("clicking locale chips selects a sorted, deduped locales array regardless of click order", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: page([novel(ID_EN, "en", "Alpha book")], { total: 1 }),
      templates: [],
    });
    const withJaFacet = page([...EN_PAGE.rows], {
      total: EN_PAGE.total,
      localeCounts: [{ locale: "en", count: 10 }, { locale: "ja", count: 3 }],
    });
    render(<ArticleBatchGenerateForm initialPage={withJaFacet} templates={[]} canWrite />);

    // Click "ja" before "en" — the applied filter must still come out sorted.
    fireEvent.click(localeChip("ja"));
    fireEvent.click(localeChip("en"));
    expect(localeChip("ja").getAttribute("aria-pressed")).toBe("true");
    expect(localeChip("en").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    expect(actions.listArticleGenerateCandidatesAction.mock.calls[0][0]).toMatchObject({
      locales: ["en", "ja"],
    });
    expect(screen.getByTestId("applied-total").getAttribute("data-applied-locales")).toBe("en,ja");

    // Un-clicking "en" and re-clicking it must not duplicate the entry.
    fireEvent.click(localeChip("en"));
    fireEvent.click(localeChip("en"));
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalledTimes(2));
    expect(actions.listArticleGenerateCandidatesAction.mock.calls[1][0]).toMatchObject({
      locales: ["en", "ja"],
    });
  });

  it("fires the dirty-check guard on a locale chip change alone, and clears it back once un-clicked", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: EN_PAGE,
      templates: [],
    });
    render(<ArticleBatchGenerateForm initialPage={EN_PAGE} templates={[]} canWrite />);
    expect(screen.queryByTestId("filter-dirty")).toBeNull();

    fireEvent.click(localeChip("en"));
    expect(screen.getByTestId("filter-dirty")).toBeTruthy();
    expect((screen.getByTestId("submit-filtered") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("submit-selected") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(localeChip("en"));
    expect(screen.queryByTestId("filter-dirty")).toBeNull();

    fireEvent.click(localeChip("en"));
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    expect(screen.queryByTestId("filter-dirty")).toBeNull();
  });

  it("treats no locale chips selected as unset after apply", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: EN_PAGE,
      templates: [],
    });
    render(<ArticleBatchGenerateForm initialPage={EN_PAGE} templates={[]} canWrite />);
    fireEvent.change(screen.getByTestId("batch-search"), { target: { value: "   " } });
    expect(screen.queryByTestId("filter-dirty")).toBeNull();
    fireEvent.click(screen.getByTestId("apply-filter"));
    await waitFor(() => expect(actions.listArticleGenerateCandidatesAction).toHaveBeenCalled());
    expect(actions.listArticleGenerateCandidatesAction.mock.calls[0][0]).not.toHaveProperty("search");
    expect(actions.listArticleGenerateCandidatesAction.mock.calls[0][0]).not.toHaveProperty("locales");
    expect(screen.getByTestId("applied-total").getAttribute("data-applied-search")).toBe("");
    expect(screen.getByTestId("applied-total").getAttribute("data-applied-locales")).toBe("");
  });

  it("shows a count on each locale chip and no chip for a locale absent from the filtered set", () => {
    const withCounts = page([novel(ID_EN, "en", "Alpha")], {
      total: 1,
      localeCounts: [{ locale: "en", count: 41 }, { locale: "ja", count: 3 }],
    });
    render(<ArticleBatchGenerateForm initialPage={withCounts} templates={[]} canWrite />);
    expect(localeChip("en").textContent).toContain("41");
    expect(localeChip("ja").textContent).toContain("3");
    expect(screen.queryByTestId("batch-locale-chip-th")).toBeNull();
  });

  it("fetches ja templates when a later page's facet introduces that locale, replacing the previous set", async () => {
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: page([novel(ID_JA, "ja", "日本語")], { total: 51, page: 2 }),
      templates: [template("ja-body", "ja", 3)],
    });
    render(
      <ArticleBatchGenerateForm
        initialPage={page([novel(ID_EN, "en", "English")], { total: 51 })}
        templates={[template("en-default", "en", 1)]}
        canWrite
      />,
    );
    expect(screen.getByTestId("template-en")).toBeTruthy();
    expect(screen.queryByTestId("template-ja")).toBeNull();
    fireEvent.click(screen.getByTestId("next-page"));
    await waitFor(() => expect(screen.getByTestId("template-ja")).toBeTruthy());
    expect(screen.getByRole("option", { name: "ja-body模板（ja-body · v3）" })).toBeTruthy();
    // The "en" row is off the new page and its facet dropped out of
    // `localeCounts`, so its template row no longer renders either — the
    // template row list follows the filtered set, not an ever-growing cache.
    expect(screen.queryByTestId("template-en")).toBeNull();
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
    const blockedOne = {
      ...novel(ID_EN_2, "en", "Blocked one"),
      canGenerateArticle: false,
      promoReady: false,
      promoOutcome: "promo_link_missing" as const,
      generateBlockedReason: "promo_link_missing" as const,
    };
    actions.listArticleGenerateCandidatesAction.mockResolvedValue({
      ok: true,
      data: page([novel(ID_EN, "en", "Ready one"), blockedOne], { generatableCount: 1, nonGeneratableCount: 1, total: 2 }),
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
    await waitFor(() => expect(screen.getByText(rowText(blockedOne))).toBeTruthy());
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

  it("shows a running 已选 N / 200 indicator and blocks explicit-ids submit above the cap before any action call", () => {
    const rows = Array.from({ length: ARTICLE_GENERATE_LEAF_MAX + 10 }, (_, index) =>
      novel(`row-${index + 1}`, "en", `Book ${index + 1}`));
    render(<ArticleBatchGenerateForm initialPage={page(rows, { total: rows.length })} templates={[]} canWrite />);

    expect(screen.getByTestId("selected-count").textContent)
      .toContain(`已选 0 / ${ARTICLE_GENERATE_LEAF_MAX}`);
    expect(screen.queryByTestId("cap-over-message")).toBeNull();

    // 本页全选 pushes the selection past the cap in one click — the page
    // itself has more rows than the cap allows.
    fireEvent.click(screen.getByTestId("select-all-page"));

    expect(screen.getByTestId("selected-count").textContent)
      .toContain(`已选 ${rows.length} / ${ARTICLE_GENERATE_LEAF_MAX}`);
    expect(screen.getByTestId("cap-over-message")).toBeTruthy();
    const submitSelected = screen.getByTestId("submit-selected") as HTMLButtonElement;
    expect(submitSelected.disabled).toBe(true);

    // The disabled attribute already stops the click from reaching `onClick`
    // in a real browser/jsdom, but this also proves the internal guard in
    // `submit()` never lets an over-cap explicit-ids request through to the
    // server action, even if something upstream of `disabled` changes later.
    fireEvent.click(submitSelected);
    expect(actions.enqueueArticleGenerateBatchAction).not.toHaveBeenCalled();
    // The "按当前筛选全部入队" path submits a filter, not ids, so the cap
    // (an explicit-ids-only constraint) never touches it.
    expect((screen.getByTestId("submit-filtered") as HTMLButtonElement).disabled).toBe(false);
  });

  it("本页全选 selects only eligible rows on the page and reflects partial selection as indeterminate", () => {
    const ready1 = novel(ID_EN, "en", "Ready one");
    const ready2 = novel(ID_EN_2, "en", "Ready two");
    const blocked = {
      ...novel(ID_JA, "ja", "Blocked"),
      canGenerateArticle: false,
      promoReady: false,
      promoOutcome: "promo_link_missing" as const,
      generateBlockedReason: "promo_link_missing" as const,
    };
    render(<ArticleBatchGenerateForm initialPage={page([ready1, ready2, blocked])} templates={[]} canWrite />);
    const selectAll = screen.getByTestId("select-all-page") as HTMLInputElement;
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(false);

    fireEvent.click(selectAll);
    expect((screen.getByTestId(`select-${ID_EN}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`select-${ID_EN_2}`) as HTMLInputElement).checked).toBe(true);
    // The blocked row's own disabled checkbox already forbids this, but
    // 本页全选 must independently never add an ineligible row either.
    expect((screen.getByTestId(`select-${ID_JA}`) as HTMLInputElement).checked).toBe(false);
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);

    fireEvent.click(screen.getByTestId(`select-${ID_EN_2}`));
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);

    fireEvent.click(selectAll);
    expect((screen.getByTestId(`select-${ID_EN}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(`select-${ID_EN_2}`) as HTMLInputElement).checked).toBe(true);
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);
  });

  it("shows a 将为 N 本书目创建文章 estimate that follows the explicit selection, falling back to generatableCount when nothing is selected", () => {
    const ready1 = novel(ID_EN, "en", "Ready one");
    const ready2 = novel(ID_EN_2, "en", "Ready two");
    render(
      <ArticleBatchGenerateForm
        initialPage={page([ready1, ready2], { generatableCount: 5, nonGeneratableCount: 0, total: 2 })}
        templates={[]}
        canWrite
      />,
    );
    expect(screen.getByTestId("generate-estimate").textContent).toContain("将为 5 本书目创建文章");

    fireEvent.click(screen.getByTestId(`select-${ID_EN}`));
    expect(screen.getByTestId("generate-estimate").textContent).toContain("将为 1 本书目创建文章");

    fireEvent.click(screen.getByTestId(`select-${ID_EN_2}`));
    expect(screen.getByTestId("generate-estimate").textContent).toContain("将为 2 本书目创建文章");

    fireEvent.click(screen.getByTestId(`select-${ID_EN_2}`));
    expect(screen.getByTestId("generate-estimate").textContent).toContain("将为 1 本书目创建文章");
  });

  it("template dropdown option label includes templateName alongside the key and version", () => {
    render(
      <ArticleBatchGenerateForm
        initialPage={page([novel(ID_EN, "en", "Alpha")], { localeCounts: [{ locale: "en", count: 1 }] })}
        templates={[template("en-default", "en", 2, "英文默认模板")]}
        canWrite
      />,
    );
    expect(screen.getByTestId("template-en")).toBeTruthy();
    expect(screen.getByRole("option", { name: "英文默认模板（en-default · v2）" })).toBeTruthy();
    // The empty-value "服务默认模板" option's semantics are unchanged by this.
    expect(screen.getByRole("option", { name: "服务默认模板" })).toBeTruthy();
  });
});
