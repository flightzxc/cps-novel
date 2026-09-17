import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RebindBatchDetail,
  RebindBatchFacets,
  RebindBatchSummary,
  RebindPreviewPage,
} from "@/app/(admin)/articles/_types/rebind";

import { installDialogShim } from "./jsdom-dialog";

/**
 * C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.4/§4B.5). Same
 * "mock only the Server Action module, render the real component" discipline
 * `tests/ui/article-rebind-panel.test.tsx` (C-30A) already uses.
 *
 * The batch panel's confirm step renders `ConfirmDialog` (`@/components/ui/
 * confirm-dialog.tsx`), a real native `<dialog>` — `installDialogShim()`
 * (`./jsdom-dialog.ts`) is this repo's existing environment patch for
 * jsdom's missing `showModal()`/`close()`, deliberately opt-in per file
 * rather than global (see that module's own header) so it does not shadow
 * `tests/ui/admin-channel-accounts.test.tsx`/`admin-tag-mappings.test.tsx`'s
 * own call-counting assertions on the same platform methods.
 */
installDialogShim();
const actions = vi.hoisted(() => ({
  getRebindBatchFacetsAction: vi.fn(),
  generateRebindBatchPreviewAction: vi.fn(),
  getRebindBatchPreviewPageAction: vi.fn(),
  submitRebindBatchAction: vi.fn(),
  resumeRebindBatchAction: vi.fn(),
  getRebindBatchDetailAction: vi.fn(),
  getRebindBatchByTokenAction: vi.fn(),
}));
vi.mock("@/app/(admin)/articles/_actions", () => actions);

const { BatchRebindClient } = await import("@/app/(admin)/articles/batch-novel-rebind/_components/batch-rebind-client");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function facets(overrides: Partial<RebindBatchFacets> = {}): RebindBatchFacets {
  return {
    channels: [
      { value: "changdu", label: "畅读", count: 0 },
      { value: "beidou", label: "北斗", count: 0 },
    ],
    locales: [{ value: "en", label: "English (en)", count: 3 }],
    sourceApps: [{ value: "moboreader", label: "Moboreader (moboreader)", count: 3 }],
    selectedLocale: null,
    selectedLocaleSourceCount: null,
    sourceCeiling: 20000,
    previewAllowed: false,
    ...overrides,
  };
}

function summary(overrides: Partial<RebindBatchSummary> = {}): RebindBatchSummary {
  return {
    previewId: "11111111-1111-4111-8111-111111111111",
    sourceChannelCode: "changdu",
    targetChannelCode: "beidou",
    filters: { locale: "en" },
    sourceScanned: 3,
    matchedCount: 1,
    executableCount: 1,
    riskBlockedCount: 1,
    ambiguousCount: 1,
    skippedCount: 0,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function page(category: RebindPreviewPage["category"], overrides: Partial<RebindPreviewPage> = {}): RebindPreviewPage {
  const base: RebindPreviewPage = {
    previewId: "11111111-1111-4111-8111-111111111111",
    category,
    items: [],
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
  };
  if (category === "executable") {
    base.items = [
      {
        category: "executable",
        articleId: "article-exec-1",
        oldNovelId: "novel-old-1",
        targetNovelId: "novel-new-1",
        targetPromoLinkId: "promo-1",
        sourceApps: ["moboreader"],
        targetApps: ["moboreader"],
        findings: [],
        conflictArticle: null,
        candidateNovelIds: [],
        candidateCount: 1,
        candidatesTruncated: false,
        skipReason: null,
        articleTitle: "可执行文章",
        articleSlug: "exec-slug",
        articleAdminUrl: "/articles/article-exec-1",
        articleLocale: "en",
        oldNovelTitle: "旧书目",
        targetNovelTitle: "新书目",
        candidateNovelTitles: [],
        drifted: false,
      },
    ];
    base.total = 1;
  } else if (category === "ambiguous") {
    base.items = [
      {
        category: "ambiguous",
        articleId: "article-amb-1",
        oldNovelId: "novel-old-2",
        targetNovelId: null,
        targetPromoLinkId: null,
        sourceApps: ["moboreader"],
        targetApps: [],
        findings: [],
        conflictArticle: null,
        candidateNovelIds: ["novel-c1", "novel-c2"],
        candidateCount: 2,
        candidatesTruncated: false,
        skipReason: null,
        articleTitle: "歧义文章",
        articleSlug: "amb-slug",
        articleAdminUrl: "/articles/article-amb-1",
        articleLocale: "en",
        oldNovelTitle: "旧书目2",
        targetNovelTitle: null,
        candidateNovelTitles: ["候选甲", "候选乙"],
        drifted: false,
      },
    ];
    base.total = 1;
  }
  return { ...base, ...overrides };
}

function batchDetail(overrides: Partial<RebindBatchDetail> = {}): RebindBatchDetail {
  return {
    batchId: "rebind-20260908120000-abcd1234",
    status: "completed",
    persistedStatus: "completed",
    requestToken: "22222222-2222-4222-8222-222222222222",
    previewId: "11111111-1111-4111-8111-111111111111",
    createdBy: "admin-1",
    sourceChannelCode: "changdu",
    targetChannelCode: "beidou",
    reason: "渠道故障切换",
    acknowledgeRisks: false,
    counts: { submitted: 1, resolvable: 1, applied: 1, skipped: 0, failed: 0, pending: 0, processing: 0 },
    leaseExpiresAt: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    items: [],
    ...overrides,
  };
}

function seedPendingRecovery(token = "tok-lease-1") {
  window.sessionStorage.setItem(
    `novel-rebind:batch:pending:${token}`,
    JSON.stringify({
      requestToken: token,
      previewId: "11111111-1111-4111-8111-111111111111",
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      selectedArticleIds: ["article-exec-1"],
      reason: "r",
      acknowledgeRisks: false,
      savedAt: Date.now(),
    }),
  );
}

/**
 * Reaches a populated `batchDetail` via the "查询该次提交结果" recovery banner
 * (`rebind-batch-recovery-lookup`) instead of the full preview → select →
 * submit flow every other describe block in this file uses. Shorter, and —
 * for the lease-timer tests below, which run under `vi.useFakeTimers()` —
 * it keeps every `Date.now()` the component's effect reads under this
 * file's own control via `vi.advanceTimersByTimeAsync`, rather than
 * threading fake-timer advances through `setupToPreview`'s own chain of
 * real-timer `waitFor` polls.
 */
async function renderWithRecoveredDetail(detail: RebindBatchDetail) {
  actions.getRebindBatchFacetsAction.mockResolvedValue({ ok: true, data: facets() });
  seedPendingRecovery();
  actions.getRebindBatchByTokenAction.mockResolvedValue({ ok: true, data: detail });
  render(<BatchRebindClient />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("rebind-batch-recovery-lookup"));
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function setupToPreview(options: { executableCount?: number } = {}) {
  actions.getRebindBatchFacetsAction.mockImplementation(async (input: { sourceChannelCode: string; locale?: string }) => {
    if (!input.sourceChannelCode) return { ok: true, data: facets() };
    if (!input.locale) return { ok: true, data: facets({ selectedLocale: null }) };
    return { ok: true, data: facets({ selectedLocale: "en", selectedLocaleSourceCount: 3, previewAllowed: true }) };
  });
  render(<BatchRebindClient />);
  await waitFor(() => expect(screen.getByTestId("rebind-batch-source-channel").querySelectorAll("option").length).toBeGreaterThan(1));

  fireEvent.change(screen.getByTestId("rebind-batch-source-channel"), { target: { value: "changdu" } });
  await waitFor(() => expect(actions.getRebindBatchFacetsAction).toHaveBeenCalledWith(expect.objectContaining({ sourceChannelCode: "changdu" })));
  fireEvent.change(screen.getByTestId("rebind-batch-target-channel"), { target: { value: "beidou" } });
  fireEvent.change(screen.getByTestId("rebind-batch-locale"), { target: { value: "en" } });
  await waitFor(() => expect((screen.getByTestId("rebind-batch-generate-preview") as HTMLButtonElement).disabled).toBe(false));

  actions.generateRebindBatchPreviewAction.mockResolvedValue({ ok: true, data: summary({ executableCount: options.executableCount ?? 1 }) });
  actions.getRebindBatchPreviewPageAction.mockImplementation(async (input: { category?: RebindPreviewPage["category"] }) => ({
    ok: true,
    data: page(input.category ?? "executable"),
  }));
  fireEvent.click(screen.getByTestId("rebind-batch-generate-preview"));
  await waitFor(() => expect(screen.getByTestId("rebind-batch-category-tabs")).toBeTruthy());
  await waitFor(() => expect(screen.queryByTestId(`rebind-batch-row-${page("executable").items[0]!.articleId}`)).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BatchRebindClient · 四页签与计数", () => {
  it("四个页签均渲染，且携带 summary 里的各分类计数", async () => {
    await setupToPreview();
    expect(screen.getByTestId("rebind-batch-tab-executable").textContent).toContain("可执行");
    expect(screen.getByTestId("rebind-batch-tab-executable").textContent).toContain("1");
    expect(screen.getByTestId("rebind-batch-tab-risk_blocked").textContent).toContain("有风险/受阻");
    expect(screen.getByTestId("rebind-batch-tab-ambiguous").textContent).toContain("歧义");
    expect(screen.getByTestId("rebind-batch-tab-skipped").textContent).toContain("未匹配");
  });

  it("切换到歧义页签会重新拉取该分类的分页数据", async () => {
    await setupToPreview();
    fireEvent.click(screen.getByTestId("rebind-batch-tab-ambiguous"));
    await waitFor(() => expect(actions.getRebindBatchPreviewPageAction).toHaveBeenCalledWith(expect.objectContaining({ category: "ambiguous" })));
    await waitFor(() => expect(screen.getByTestId("rebind-batch-row-article-amb-1")).toBeTruthy());
  });
});

describe("BatchRebindClient · 🔴 歧义项不可勾选", () => {
  it("歧义页签的行内没有任何 checkbox", async () => {
    await setupToPreview();
    fireEvent.click(screen.getByTestId("rebind-batch-tab-ambiguous"));
    await waitFor(() => expect(screen.getByTestId("rebind-batch-row-article-amb-1")).toBeTruthy());
    const row = screen.getByTestId("rebind-batch-row-article-amb-1");
    expect(row.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe("BatchRebindClient · 🔴 上限约束（客户端）", () => {
  it("勾选数超过上限时禁用提交按钮并显示中文提示", async () => {
    // Render with many executable rows to exceed the 200 cap.
    actions.getRebindBatchFacetsAction.mockResolvedValue({ ok: true, data: facets({ selectedLocale: "en", selectedLocaleSourceCount: 300, previewAllowed: true }) });
    render(<BatchRebindClient />);
    await waitFor(() => expect(screen.getByTestId("rebind-batch-source-channel").querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(screen.getByTestId("rebind-batch-source-channel"), { target: { value: "changdu" } });
    fireEvent.change(screen.getByTestId("rebind-batch-target-channel"), { target: { value: "beidou" } });
    fireEvent.change(screen.getByTestId("rebind-batch-locale"), { target: { value: "en" } });

    const manyItems = Array.from({ length: 201 }, (_, index) => ({
      category: "executable" as const,
      articleId: `article-${index}`,
      oldNovelId: `novel-old-${index}`,
      targetNovelId: `novel-new-${index}`,
      targetPromoLinkId: `promo-${index}`,
      sourceApps: ["moboreader"],
      targetApps: ["moboreader"],
      findings: [],
      conflictArticle: null,
      candidateNovelIds: [],
      candidateCount: 1,
      candidatesTruncated: false,
      skipReason: null,
      articleTitle: `文章 ${index}`,
      articleSlug: `slug-${index}`,
      articleAdminUrl: `/articles/article-${index}`,
      articleLocale: "en",
      oldNovelTitle: "旧书目",
      targetNovelTitle: "新书目",
      candidateNovelTitles: [],
      drifted: false,
    }));
    actions.generateRebindBatchPreviewAction.mockResolvedValue({ ok: true, data: summary({ executableCount: 201 }) });
    actions.getRebindBatchPreviewPageAction.mockResolvedValue({ ok: true, data: { previewId: "p1", category: "executable", items: manyItems, page: 1, pageSize: 50, total: 201, totalPages: 5 } });
    fireEvent.click(screen.getByTestId("rebind-batch-generate-preview"));
    await waitFor(() => expect(screen.getByTestId("rebind-batch-select-page")).toBeTruthy());

    // The mock returns all 201 rows in one page (mirrors a real over-cap
    // preview whose executable tab still has to be scrollable/selectable);
    // "本页全选" therefore selects all 201 distinct ids in one click.
    fireEvent.click(screen.getByTestId("rebind-batch-select-page"));

    await waitFor(() => expect(screen.getByTestId("rebind-batch-selected-count").textContent).toContain("201"));
    expect(screen.getByTestId("rebind-batch-selected-count").textContent).toContain("/ 200");
    expect(screen.getByTestId("rebind-batch-cap-message").textContent).toContain("已超过单次执行上限（200 篇），请减少选择后再提交。");

    fireEvent.change(screen.getByTestId("rebind-batch-reason"), { target: { value: "渠道故障切换" } });
    expect((screen.getByTestId("rebind-batch-open-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("BatchRebindClient · 🔴 零裸 UUID", () => {
  it("批次详情渲染的批次编号是可读格式 rebind-...，页面文本中不出现任何 UUID", async () => {
    await setupToPreview();
    fireEvent.click(screen.getByTestId(`rebind-batch-checkbox-${page("executable").items[0]!.articleId}`));
    fireEvent.change(screen.getByTestId("rebind-batch-reason"), { target: { value: "渠道故障切换" } });
    actions.submitRebindBatchAction.mockResolvedValue({ ok: true, data: batchDetail() });
    fireEvent.click(screen.getByTestId("rebind-batch-open-confirm"));
    fireEvent.click(screen.getByText("提交"));
    await waitFor(() => expect(screen.getByTestId("rebind-batch-detail")).toBeTruthy());

    expect(screen.getByTestId("rebind-batch-id").textContent).toBe("rebind-20260908120000-abcd1234");
    expect(document.body.textContent ?? "").not.toMatch(UUID_RE);
  });
});

describe("BatchRebindClient · 确认对话框措辞", () => {
  it("包含「提交后按批次编号查询结果；页面报错或超时时不要重复提交，请用批次编号查询」", async () => {
    await setupToPreview();
    fireEvent.click(screen.getByTestId(`rebind-batch-checkbox-${page("executable").items[0]!.articleId}`));
    fireEvent.change(screen.getByTestId("rebind-batch-reason"), { target: { value: "渠道故障切换" } });
    fireEvent.click(screen.getByTestId("rebind-batch-open-confirm"));
    await waitFor(() => expect(screen.getByTestId("rebind-batch-confirm-body")).toBeTruthy());
    expect(screen.getByTestId("rebind-batch-confirm-body").textContent).toContain(
      "提交后按批次编号查询结果；页面报错或超时时不要重复提交，请用批次编号查询。",
    );
  });
});

describe("BatchRebindClient · 🔴 令牌先落存储再发请求", () => {
  it("sessionStorage.setItem 的调用发生在 submitRebindBatchAction 之前", async () => {
    await setupToPreview();
    fireEvent.click(screen.getByTestId(`rebind-batch-checkbox-${page("executable").items[0]!.articleId}`));
    fireEvent.change(screen.getByTestId("rebind-batch-reason"), { target: { value: "渠道故障切换" } });
    fireEvent.click(screen.getByTestId("rebind-batch-open-confirm"));

    const order: string[] = [];
    const originalSetItem = Storage.prototype.setItem.bind(window.sessionStorage);
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith("novel-rebind:batch:pending:")) order.push("sessionStorage.setItem");
      originalSetItem(key, value);
    });
    actions.submitRebindBatchAction.mockImplementation(async () => {
      order.push("submitRebindBatchAction");
      return { ok: true, data: batchDetail() };
    });

    fireEvent.click(screen.getByText("提交"));
    await waitFor(() => expect(order).toContain("submitRebindBatchAction"));
    // 🔴 The token write must precede the request — a second `setItem`
    // (superseding the pending record once the request resolves) is
    // expected AFTER the action call and is not what this assertion is
    // about, hence checking the first occurrence of each rather than full
    // sequence equality.
    expect(order.indexOf("sessionStorage.setItem")).toBeLessThan(order.indexOf("submitRebindBatchAction"));
    expect(order[0]).toBe("sessionStorage.setItem");
    setItemSpy.mockRestore();
  });
});

describe("BatchRebindClient · 续跑按钮仅在中断态出现", () => {
  it("status !== 'interrupted' 时不显示继续执行按钮", async () => {
    await setupToPreview();
    fireEvent.click(screen.getByTestId(`rebind-batch-checkbox-${page("executable").items[0]!.articleId}`));
    fireEvent.change(screen.getByTestId("rebind-batch-reason"), { target: { value: "r" } });
    actions.submitRebindBatchAction.mockResolvedValue({ ok: true, data: batchDetail({ status: "completed" }) });
    fireEvent.click(screen.getByTestId("rebind-batch-open-confirm"));
    fireEvent.click(screen.getByText("提交"));
    await waitFor(() => expect(screen.getByTestId("rebind-batch-detail")).toBeTruthy());
    expect(screen.queryByTestId("rebind-batch-resume")).toBeNull();
  });

  it("status === 'interrupted' 时显示继续执行按钮", async () => {
    await setupToPreview();
    fireEvent.click(screen.getByTestId(`rebind-batch-checkbox-${page("executable").items[0]!.articleId}`));
    fireEvent.change(screen.getByTestId("rebind-batch-reason"), { target: { value: "r" } });
    actions.submitRebindBatchAction.mockResolvedValue({ ok: true, data: batchDetail({ status: "interrupted", counts: { submitted: 2, resolvable: 2, applied: 1, skipped: 0, failed: 0, pending: 1, processing: 0 } }) });
    fireEvent.click(screen.getByTestId("rebind-batch-open-confirm"));
    fireEvent.click(screen.getByText("提交"));
    await waitFor(() => expect(screen.getByTestId("rebind-batch-detail")).toBeTruthy());
    expect(screen.getByTestId("rebind-batch-resume")).toBeTruthy();
  });
});

/**
 * 施工工单_C30单3_批量换小说分块执行_移植CPS_V2_2026-09-09.md §5.2 — W-1's own
 * test spec (items 1-7). CPS parity source: `batch-drama-switch-v2-client.
 * tsx:407-421` (lease-expiry timer) and `:424` (`canResume`). This describe
 * block runs entirely under fake timers so `renderWithRecoveredDetail`
 * (above) and every `vi.advanceTimersByTimeAsync` call below have full
 * control over what "now" the component's effect sees — none of these
 * cases wait on real wall-clock time.
 */
describe("BatchRebindClient · C-30 单 3 W-1 续跑入口补齐（租约到期定时器 + canResume）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("§5.2-1 持久态 processing 且租约未到期时，续跑按钮不渲染", async () => {
    await renderWithRecoveredDetail(
      batchDetail({
        status: "processing",
        persistedStatus: "processing",
        leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        counts: { submitted: 2, resolvable: 2, applied: 0, skipped: 0, failed: 0, pending: 2, processing: 0 },
      }),
    );
    expect(screen.getByTestId("rebind-batch-detail")).toBeTruthy();
    expect(screen.queryByTestId("rebind-batch-resume")).toBeNull();
  });

  it("§5.2-2 推进假定时器越过租约到期时刻后，续跑按钮出现", async () => {
    await renderWithRecoveredDetail(
      batchDetail({
        status: "processing",
        persistedStatus: "processing",
        leaseExpiresAt: new Date(Date.now() + 5000).toISOString(),
        counts: { submitted: 2, resolvable: 2, applied: 0, skipped: 0, failed: 0, pending: 2, processing: 0 },
      }),
    );
    expect(screen.queryByTestId("rebind-batch-resume")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByTestId("rebind-batch-resume")).toBeTruthy();
  });

  it("§5.2-3 持久态 ready 时续跑按钮渲染（覆盖「批次已建好、执行未开始」的卡死态）", async () => {
    await renderWithRecoveredDetail(
      batchDetail({
        status: "ready",
        persistedStatus: "ready",
        leaseExpiresAt: null,
        counts: { submitted: 2, resolvable: 2, applied: 0, skipped: 0, failed: 0, pending: 2, processing: 0 },
      }),
    );
    expect(screen.getByTestId("rebind-batch-resume")).toBeTruthy();
  });

  it("§5.2-4 终态（completed/partial/failed）时续跑按钮不渲染，且推进大量时间后依旧不出现（无残留的到期定时器）", async () => {
    await renderWithRecoveredDetail(
      batchDetail({ status: "completed", persistedStatus: "completed", leaseExpiresAt: null }),
    );
    expect(screen.queryByTestId("rebind-batch-resume")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000_000);
    });
    expect(screen.queryByTestId("rebind-batch-resume")).toBeNull();
  });

  it("§5.2-5 详情刷新后租约又活了：leaseExpired 被重置，续跑按钮收回", async () => {
    await renderWithRecoveredDetail(
      batchDetail({
        status: "processing",
        persistedStatus: "processing",
        leaseExpiresAt: new Date(Date.now() + 1000).toISOString(),
        counts: { submitted: 2, resolvable: 2, applied: 0, skipped: 0, failed: 0, pending: 2, processing: 0 },
      }),
    );
    expect(screen.queryByTestId("rebind-batch-resume")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId("rebind-batch-resume")).toBeTruthy();

    actions.getRebindBatchDetailAction.mockResolvedValue({
      ok: true,
      data: batchDetail({
        status: "processing",
        persistedStatus: "processing",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        counts: { submitted: 2, resolvable: 2, applied: 0, skipped: 0, failed: 0, pending: 2, processing: 0 },
      }),
    });
    await act(async () => {
      fireEvent.click(screen.getByText("刷新状态"));
      await vi.advanceTimersByTimeAsync(0);
    });
    // A second 0ms flush: the refresh's `setBatchDetail` re-runs the lease
    // effect (new `leaseExpiresAt`), which itself schedules a fresh 0ms
    // reset timer — that timer is registered by an effect flush that lands
    // just outside the first `advanceTimersByTimeAsync` window above, so it
    // needs its own tick to fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("rebind-batch-resume")).toBeNull();
  });

  it("§5.2-6 点击续跑只调用一次续跑动作，调用期间按钮禁用、二次点击不产生第二次调用", async () => {
    await renderWithRecoveredDetail(
      batchDetail({
        status: "interrupted",
        persistedStatus: "processing",
        leaseExpiresAt: null,
        counts: { submitted: 2, resolvable: 2, applied: 1, skipped: 0, failed: 0, pending: 1, processing: 0 },
      }),
    );
    expect(screen.getByTestId("rebind-batch-resume")).toBeTruthy();

    let resolveResume!: (value: { ok: true; data: RebindBatchDetail }) => void;
    const resumeGate = new Promise<{ ok: true; data: RebindBatchDetail }>((resolve) => {
      resolveResume = resolve;
    });
    actions.resumeRebindBatchAction.mockReturnValue(resumeGate);

    fireEvent.click(screen.getByTestId("rebind-batch-resume"));
    expect(actions.resumeRebindBatchAction).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("rebind-batch-resume") as HTMLButtonElement).disabled).toBe(true);

    // Disabled buttons do not dispatch `click` handlers in jsdom (matches
    // real browsers) — this is the "二次点击不产生第二次调用" half of the
    // assertion, exercised while the first call is still in flight.
    fireEvent.click(screen.getByTestId("rebind-batch-resume"));
    expect(actions.resumeRebindBatchAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveResume({ ok: true, data: batchDetail({ status: "completed", persistedStatus: "completed" }) });
      await vi.advanceTimersByTimeAsync(0);
    });
    // Same second-tick flush as §5.2-5 — the resolved detail's persisted
    // status change re-runs the lease effect, whose fresh 0ms reset timer
    // needs its own `advanceTimersByTimeAsync` window to fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(actions.resumeRebindBatchAction).toHaveBeenCalledTimes(1);
    // Terminal status now — the button leaves the DOM entirely rather than
    // merely re-enabling, which also confirms `submitting` was cleared.
    expect(screen.queryByTestId("rebind-batch-resume")).toBeNull();
  });

  it("§5.2-7 不轮询：挂载后推进大量假时间，取详情动作不会被自动调用", async () => {
    actions.getRebindBatchFacetsAction.mockResolvedValue({ ok: true, data: facets() });
    render(<BatchRebindClient />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000_000);
    });
    expect(actions.getRebindBatchDetailAction).not.toHaveBeenCalled();
  });
});
