import "./setup-cleanup";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogShim } from "./jsdom-dialog";

/**
 * B-44（v0.6.4，Owner 2026-10-19 拍板）：目录同步页
 * 1. 新增"剧场"筛选（全部 / MoboReader / PlotNovel…，按 channel_app 列出）；
 * 2. 勾选陷阱照 CPS 修：筛选、排序、翻页、每页条数任一变化都清空勾选（10-15 改排序未清空，误领 133 本）；
 * 3. 领取对话框自动跳过「领取已暂停」剧场的书并提示"已跳过 N 本（PlotNovel 领取暂停）"。
 * 纯函数部分见 `tests/backend/catalog-batch/theater-filter.test.ts`。
 */

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const actions = vi.hoisted(() => ({
  readCatalogBatchContextAction: vi.fn(), enqueuePromoLinkClaimAction: vi.fn(), readCatalogBatchSummaryAction: vi.fn(),
  readPromoClaimShardEstimateAction: vi.fn(),
  applyNovelMaterializeBatchAction: vi.fn(), dryRunNovelMaterializeAction: vi.fn(), applyNovelMaterializeAction: vi.fn(),
  applyContentCreationBatchAction: vi.fn(), dryRunContentCreationAction: vi.fn(), applyContentCreationAction: vi.fn(),
}));
vi.mock("@/app/(admin)/catalog-sync/_actions", () => actions);
vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: {} }));

const { SourceItemFilters } = await import("@/app/(admin)/catalog-sync/_components/source-item-filters");
const { CatalogSyncClient } = await import("@/app/(admin)/catalog-sync/_components/catalog-sync-client");
const { PromoLinkClaimDialog } = await import("@/app/(admin)/catalog-sync/_components/promo-link-claim-dialog");
const { catalogSelectionScopeKey } = await import("@/app/(admin)/catalog-sync/_lib/read-source-items");
installDialogShim();

const MOBO = "11111111-1111-4111-8111-111111111111";
const PLOT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const THEATERS = [{ id: MOBO, label: "MoboReader" }, { id: PLOT, label: "PlotNovel" }];

beforeEach(() => {
  push.mockReset();
  Object.values(actions).forEach((action) => action.mockReset());
});

describe("B-44 · 剧场筛选", () => {
  beforeEach(() => window.history.replaceState({}, "", "/catalog-sync?status=linked"));

  it("下拉按 channel_app 列出：全部剧场 + 各剧场，默认全部", () => {
    render(<SourceItemFilters values={{ status: "linked" }} theaters={THEATERS} />);
    const select = screen.getByLabelText("剧场") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
      ["", "全部剧场"], [MOBO, "MoboReader"], [PLOT, "PlotNovel"],
    ]);
    expect(select.value).toBe("");
  });

  it("选定剧场后搜索：URL 带 channelAppId，并回到第一页", () => {
    render(<SourceItemFilters values={{ status: "linked" }} theaters={THEATERS} />);
    fireEvent.change(screen.getByLabelText("剧场"), { target: { value: PLOT } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    const url = new URL(push.mock.calls[0]![0], "https://zbcwf.novel.test");
    expect(url.searchParams.get("channelAppId")).toBe(PLOT);
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("全部剧场：URL 里不出现 channelAppId（未使用时地址与改动前一致）", () => {
    render(<SourceItemFilters values={{ status: "linked", channelAppId: MOBO }} theaters={THEATERS} />);
    expect((screen.getByLabelText("剧场") as HTMLSelectElement).value).toBe(MOBO);
    fireEvent.change(screen.getByLabelText("剧场"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(push.mock.calls[0]![0]).not.toContain("channelAppId");
  });
});

const row = (id: string, title: string, channelAppId = MOBO) => ({
  id, title, description: "", coverUrl: null, totalChapterCount: 1, paidFromChapter: null, sourceLocale: "en",
  sourceLanguageCode: "en", sourceLanguageName: "English", status: "linked" as const, novelId: "n", lastSeenAt: null,
  channelAppId, channelCode: "changdu", channelName: "畅读网文", sourceAppCode: channelAppId === PLOT ? "plotnovel" : "moboreader",
  sourceAppName: channelAppId === PLOT ? "PlotNovel" : "MoboReader", promoClaimEligible: true, promoClaimIneligibleReason: null,
});

function client(key: string, items = [row("a", "A"), row("b", "B")]) {
  return (
    <CatalogSyncClient key={key} items={items} total={500} filter={{ status: "linked" }} catalogGate={{ featureEnabled: true }}
      contentPublish="granted" promoClaimGranted promoClaimBlockedReason={null} />
  );
}
const count = () => screen.getByTestId("promo-claim-toolbar-count").textContent;

describe("B-44 · 勾选陷阱：照 CPS，排序/翻页/每页条数变化都清空勾选", () => {
  const scope = (overrides: Partial<Parameters<typeof catalogSelectionScopeKey>[0]> = {}) =>
    catalogSelectionScopeKey({ filter: { status: "linked" }, sort: undefined, page: 1, pageSize: 100, ...overrides });

  it("同一作用范围重新渲染：勾选保留（对照组）", () => {
    const view = render(client(scope()));
    fireEvent.click(screen.getByLabelText("勾选 A"));
    expect(count()).toContain("1");
    view.rerender(client(scope()));
    expect(count()).toContain("1");
  });

  it.each([
    ["改排序（10-15 事故那一步）", { sort: "source_created_desc" }],
    ["翻到第 2 页", { page: 2 }],
    ["改每页条数", { pageSize: 200 }],
    ["换剧场", { filter: { status: "linked", channelAppId: PLOT } }],
  ] as const)("%s → 勾选清空，工具栏回到 0", async (_label, overrides) => {
    const view = render(client(scope()));
    fireEvent.click(screen.getByLabelText("勾选 A"));
    fireEvent.click(screen.getByLabelText("勾选 B"));
    expect(count()).toContain("2");
    view.rerender(client(scope(overrides as never), [row("c", "C")]));
    await waitFor(() => expect(count()).toContain("0"));
  });

  it("全选模式（全部 N 条）同样在排序变化时清空", async () => {
    const view = render(client(scope()));
    fireEvent.click(screen.getByLabelText("选择当前页"));
    fireEvent.click(await screen.findByRole("button", { name: /选择符合当前筛选条件的全部 500 条/ }));
    expect(screen.getByTestId("all-filtered-selection")).toBeTruthy();
    view.rerender(client(scope({ sort: "source_created_desc" })));
    await waitFor(() => expect(screen.queryByTestId("all-filtered-selection")).toBeNull());
    expect(count()).toContain("0");
  });

  it("页面把作用范围 key 接到 CatalogSyncClient 上（含排序、页码、每页条数），不再只用筛选条件", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/(admin)/catalog-sync/page.tsx"), "utf8");
    expect(source).toContain(
      "key={catalogSelectionScopeKey({ filter: canonicalFilter, sort: filters.sort, page: page.page, pageSize: page.pageSize })}",
    );
    expect(source).not.toContain("key={JSON.stringify(canonicalFilter)}");
  });
});

const group = (channelAppId: string, sourceAppName: string, eligibleCount: number, claimCapabilityEnabled: boolean, accounts = [{ id: `acct-${sourceAppName}`, name: "Main" }]) => ({
  channelAppId, channelCode: "changdu", channelName: "畅读网文", sourceAppCode: sourceAppName.toLowerCase(), sourceAppName,
  active: true, claimCapabilityEnabled, eligibleCount, accounts,
});
const mixedContext = { submittedCount: 3, locales: [], channelGroups: [group(MOBO, "MoboReader", 2, true), group(PLOT, "PlotNovel", 1, false)] };
const ITEM_THEATERS = { a: MOBO, b: MOBO, c: PLOT };

function dialog(selection: Parameters<typeof PromoLinkClaimDialog>[0]["selection"], context: object, itemChannelAppIds: Record<string, string> = ITEM_THEATERS) {
  actions.readCatalogBatchContextAction.mockResolvedValue({ ok: true, data: context });
  return render(
    <PromoLinkClaimDialog selection={selection} itemChannelAppIds={itemChannelAppIds} promoClaimGranted promoClaimBlockedReason={null} onClose={vi.fn()} onSubmitted={vi.fn()} />,
  );
}
function okSubmit() {
  actions.enqueuePromoLinkClaimAction.mockResolvedValue({ ok: true, data: { taskId: "t1", phase: "queued" } });
  actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "t1", phase: "completed", submittedCount: 2, ineligibleCount: 0 } });
}

describe("B-44 · 领取对话框自动跳过领取暂停的剧场", () => {
  it("勾选混选：提示已跳过 1 本（PlotNovel 领取暂停），不自动提交；确认后只提交 MoboReader 的书与账户", async () => {
    okSubmit();
    dialog({ scope: "explicit_ids", ids: ["a", "b", "c"] }, mixedContext);
    expect((await screen.findByTestId("promo-claim-paused-theater-skip")).textContent).toBe("已跳过 1 本（PlotNovel 领取暂停）");
    // 单账户 + 生命周期开关关闭本来会自动提交；有被跳过的书时必须先让运营看到提示。
    await new Promise((settle) => setTimeout(settle, 30));
    expect(actions.enqueuePromoLinkClaimAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(1));
    const submitted = actions.enqueuePromoLinkClaimAction.mock.calls[0]![0];
    expect(submitted.selection).toEqual({ scope: "explicit_ids", ids: ["a", "b"] });
    expect(submitted.channelAccounts).toEqual({ [MOBO]: "acct-MoboReader" });
  });

  it("所选全在暂停剧场：照旧整单拦下，不提交", async () => {
    dialog({ scope: "explicit_ids", ids: ["c"] }, { submittedCount: 1, locales: [], channelGroups: [group(PLOT, "PlotNovel", 1, false)] });
    expect((await screen.findByRole("alert")).textContent).toBe("该渠道当前未启用推广领取能力");
    expect(screen.queryByTestId("promo-claim-paused-theater-skip")).toBeNull();
    await new Promise((settle) => setTimeout(settle, 30));
    expect(actions.enqueuePromoLinkClaimAction).not.toHaveBeenCalled();
  });

  it("全选模式、只剩一个可领取剧场：快照收窄到该剧场后提交", async () => {
    okSubmit();
    dialog({ scope: "all_filtered", filter: { status: "linked" } }, mixedContext, {});
    await screen.findByTestId("promo-claim-paused-theater-skip");
    fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(1));
    expect(actions.enqueuePromoLinkClaimAction.mock.calls[0]![0].selection).toEqual({
      scope: "all_filtered", filter: { status: "linked", channelAppId: MOBO },
    });
  });

  it("全选模式、可领取剧场不止一个且含暂停剧场：拦下并请运营先选定剧场", async () => {
    dialog({ scope: "all_filtered", filter: { status: "linked" } }, {
      ...mixedContext, channelGroups: [...mixedContext.channelGroups, group(OTHER, "OtherApp", 4, true)],
    }, {});
    expect((await screen.findByTestId("promo-claim-needs-theater")).textContent).toContain("请先在「剧场」筛选里选定一个剧场再全选");
    await new Promise((settle) => setTimeout(settle, 30));
    expect(actions.enqueuePromoLinkClaimAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "领取推广链接" })?.hasAttribute("disabled") ?? true).toBe(true);
  });

  it("多账户时只让运营为可领取的剧场选账户；预估也用收窄后的选择", async () => {
    actions.readPromoClaimShardEstimateAction.mockResolvedValue({ ok: true, data: { totalShardCount: 1, estimatedHours: 0.5, windowMinutes: 30, groups: [] } });
    dialog({ scope: "explicit_ids", ids: ["a", "c"] }, {
      ...mixedContext,
      lifecycleEnabled: true,
      channelGroups: [group(MOBO, "MoboReader", 1, true, [{ id: "m1", name: "One" }, { id: "m2", name: "Two" }]), group(PLOT, "PlotNovel", 1, false)],
    });
    await screen.findByTestId("promo-claim-paused-theater-skip");
    expect(screen.getByText("畅读网文 · MoboReader（1 条）")).toBeTruthy();
    expect(screen.queryByText(/PlotNovel（1 条）/)).toBeNull();
    fireEvent.change(screen.getByDisplayValue("选择账户"), { target: { value: "m2" } });
    await waitFor(() => expect(actions.readPromoClaimShardEstimateAction).toHaveBeenCalled());
    expect(actions.readPromoClaimShardEstimateAction.mock.calls.at(-1)![0]).toMatchObject({
      selection: { scope: "explicit_ids", ids: ["a"] }, channelAccounts: { [MOBO]: "m2" },
    });
  });

  it("经页面客户端组件：勾选 MoboReader 与 PlotNovel 各一本，提交的只有 MoboReader 那本", async () => {
    okSubmit();
    actions.readCatalogBatchContextAction.mockResolvedValue({ ok: true, data: { submittedCount: 2, locales: [], channelGroups: [group(MOBO, "MoboReader", 1, true), group(PLOT, "PlotNovel", 1, false)] } });
    render(client("k", [row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Mobo Book"), row("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Plot Book", PLOT)]));
    fireEvent.click(screen.getByLabelText("勾选 Mobo Book"));
    fireEvent.click(screen.getByLabelText("勾选 Plot Book"));
    fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    expect((await screen.findByTestId("promo-claim-paused-theater-skip")).textContent).toBe("已跳过 1 本（PlotNovel 领取暂停）");
    fireEvent.click(screen.getAllByRole("button", { name: "领取推广链接" }).at(-1)!);
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(1));
    expect(actions.enqueuePromoLinkClaimAction.mock.calls[0]![0].selection).toEqual({
      scope: "explicit_ids", ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    });
  });
});
