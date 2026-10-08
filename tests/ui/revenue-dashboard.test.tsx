import "./setup-cleanup";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSessionView } from "@/contracts";
import { addDays } from "@/app/(admin)/revenue/_lib/dates";
import type { RevenueBatchRow, RevenueDashboardView, RevenueDayRow } from "@/server/revenue";

/**
 * `/revenue` 页面（server component）：按 `tests/ui/admin-task-detail-page.test.tsx` 的做法直接
 * `await Page(...)` 再 `render`。只替换页面真正依赖的外部边界：
 *   - `@/server/revenue` 的 `loadRevenueDashboard`（其余导出保持真的，尤其是 `defaultRevenueRange`）；
 *   - 页面守卫 / 会话投影 / 侧栏 / 登出 action / prisma 依赖；
 *   - `_actions`（同步表单 import 它；这里不触发任何提交，见 `revenue-forms.test.tsx`）。
 * 组件、文案、数值格式化、日期校验全部是真的。
 *
 * 变异目标：
 *   ④ 去掉「pending 超过 10 分钟未被 worker 认领」的条件分支 → "worker 认领提示" 的用例必须变红；
 *   ⑤ 去掉页面的权限判断（无权限也发起查询）→ "无权限不调用 loadRevenueDashboard" 必须变红。
 */

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
  usePathname: () => "/revenue",
}));

vi.mock("@/app/(admin-auth)/_lib/logout-action", () => ({ logoutAction: vi.fn(() => Promise.resolve()) }));
vi.mock("@/features/admin-ui/sidebar", () => ({ AdminSidebar: () => <nav data-testid="stub-sidebar" /> }));
vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: { __brand: "prisma-stub" } }));
vi.mock("@/app/(admin)/revenue/_actions", () => ({ enqueueRevenueSyncAction: vi.fn() }));

const requireContentPage = vi.hoisted(() => vi.fn());
vi.mock("@/app/(admin)/novels/_lib/content-page-guard", () => ({ requireContentPage }));

const SESSION: AdminSessionView = {
  identityId: "id-1",
  username: "ops",
  role: "analyst",
  twoFactorCompleted: true,
  idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  capabilities: [{ capability: "revenue:view", state: "granted" }],
};
vi.mock("@/app/(admin)/_lib/page-guard", () => ({
  sessionView: () => SESSION,
  capabilityViews: () => SESSION.capabilities,
}));

const loadRevenueDashboard = vi.hoisted(() => vi.fn());
vi.mock("@/server/revenue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/revenue")>();
  return { ...actual, loadRevenueDashboard };
});

const { default: RevenuePage } = await import("@/app/(admin)/revenue/page");
const { defaultRevenueRange } = await import("@/server/revenue");
const { revenueMethodologyText } = await import("@/app/(admin)/revenue/_components/methodology-note");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ACCOUNT_ID = "20000000-0000-4000-8000-000000000001";
const TASK_ID = "30000000-0000-4000-8000-0000000000aa";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function isoAhead(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const REPORTED: RevenueDayRow = {
  date: "2026-10-07",
  coverage: "reported",
  activeUsers: 12345,
  newUsers: 3000,
  newUserRatio: "0.2827",
  shareIncomeUsd: "28.8750",
};
const NO_UPSTREAM: RevenueDayRow = {
  date: "2026-10-06",
  coverage: "no_upstream_row",
  activeUsers: 0,
  newUsers: 0,
  newUserRatio: null,
  shareIncomeUsd: "0.0000",
};
const NOT_SYNCED: RevenueDayRow = {
  date: "2026-10-05",
  coverage: "not_synced",
  activeUsers: null,
  newUsers: null,
  newUserRatio: null,
  shareIncomeUsd: null,
};

function batch(overrides: Partial<RevenueBatchRow> = {}): RevenueBatchRow {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    createdAt: "2026-10-08T01:00:00.000Z",
    finishedAt: "2026-10-08T01:00:30.000Z",
    beginDate: "2026-10-02",
    endDate: "2026-10-08",
    status: "completed",
    detailRowCount: 6,
    totalRowCount: 1,
    reconciliationStatus: "matched",
    upstreamStarId: "star-9001",
    credentialFingerprintPrefix: "ab12cd34",
    errorCode: null,
    errorMessage: null,
    genericTaskId: TASK_ID,
    ...overrides,
  };
}

function view(overrides: Partial<RevenueDashboardView> = {}): RevenueDashboardView {
  const days = [REPORTED, NO_UPSTREAM, NOT_SYNCED];
  return {
    account: { id: ACCOUNT_ID, label: "ch***@qq.com", novelAppCount: 1 },
    range: { dateFrom: "2026-10-05", dateTo: "2026-10-07", dayCount: 3 },
    summary: {
      shareIncomeUsdTotal: "28.8750",
      newUsersTotal: 3000,
      avgActiveUsers: "6172.50",
      reportedDays: 1,
      noUpstreamRowDays: 1,
      notSyncedDays: 1,
    },
    days,
    batches: [batch()],
    activeTask: null,
    credential: { status: "active", expiresAt: isoAhead(20 * DAY) },
    lastSuccessfulSyncAt: "2026-10-08T01:00:30.000Z",
    ...overrides,
  };
}

async function renderPage(searchParams: Record<string, string | string[]> = {}) {
  const element = await RevenuePage({ searchParams: Promise.resolve(searchParams) });
  return render(element);
}

function syncSubmit(): HTMLButtonElement {
  return within(screen.getByTestId("revenue-sync-form")).getByRole("button", { name: /发起同步|提交中/ }) as HTMLButtonElement;
}

beforeEach(() => {
  loadRevenueDashboard.mockReset();
  loadRevenueDashboard.mockResolvedValue(view());
  requireContentPage.mockReset();
  requireContentPage.mockResolvedValue({ context: {}, granted: true });
  routerRefresh.mockClear();
});

describe("/revenue · 守卫与口径说明", () => {
  it("用 revenue:view 守卫自己的路径", async () => {
    await renderPage();
    expect(requireContentPage).toHaveBeenCalledWith("/revenue", "revenue:view");
  });

  it("口径说明条常驻页面顶部，文案逐字固定（账号级 · 该账号下全部网文应用合计 · 当前 N 个应用）", async () => {
    await renderPage();
    const note = screen.getByTestId("revenue-methodology-note");
    expect(note.textContent).toBe(
      "账号级 · 该畅读账号下全部网文应用合计（当前 1 个应用）· 仅网文（projectType=1）· 达人凭证 · 北京时间日期。"
        + "上游次日可查，近几天会被上游回补，建议每次同步至少覆盖最近 7 天。"
        + "暂不支持按书、按推广码拆分。",
    );
    expect(revenueMethodologyText(1)).toBe(note.textContent);
    // 页面上没有按书 / 按推广码的占位图表或假数据
    expect(document.querySelector("svg")).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("口径说明条的应用数跟着读服务走（2 个应用写“当前 2 个应用”）；没有可用账号时不编数字", async () => {
    loadRevenueDashboard.mockResolvedValue(view({ account: { id: ACCOUNT_ID, label: "ch***@qq.com", novelAppCount: 2 } }));
    await renderPage();
    expect(screen.getByTestId("revenue-methodology-note").textContent).toContain("该畅读账号下全部网文应用合计（当前 2 个应用）");
    expect(revenueMethodologyText(2)).toBe(screen.getByTestId("revenue-methodology-note").textContent);
  });

  it("没有可用账号：口径说明条仍在，但不写“当前 N 个应用”", async () => {
    loadRevenueDashboard.mockResolvedValue(view({ account: null }));
    await renderPage();
    const text = screen.getByTestId("revenue-methodology-note").textContent ?? "";
    expect(text).toContain("账号级 · 该畅读账号下全部网文应用合计 · 仅网文（projectType=1）");
    expect(text).not.toContain("当前");
    expect(revenueMethodologyText(null)).toBe(text);
  });

  it("无权限：渲染缺少能力位面板，且不调用 loadRevenueDashboard（变异目标⑤）", async () => {
    requireContentPage.mockResolvedValue({ context: {}, granted: false });

    await renderPage();

    const denied = screen.getByTestId("content-capability-denied");
    expect(denied.textContent).toContain("revenue:view");
    expect(loadRevenueDashboard).not.toHaveBeenCalled();
    expect(screen.queryByTestId("revenue-summary")).toBeNull();
    expect(screen.queryByTestId("revenue-daily")).toBeNull();
    expect(screen.queryByTestId("revenue-sync-form")).toBeNull();
  });
});

describe("/revenue · 区间参数", () => {
  it("没给 from/to：用 defaultRevenueRange()，无提示", async () => {
    await renderPage();
    const expected = defaultRevenueRange();
    expect(loadRevenueDashboard).toHaveBeenCalledTimes(1);
    expect(loadRevenueDashboard).toHaveBeenCalledWith(expect.anything(), {
      dateFrom: expected.dateFrom,
      dateTo: expected.dateTo,
    });
    expect(screen.queryByTestId("revenue-range-fallback-notice")).toBeNull();
  });

  it("合法 from/to：原样交给读服务", async () => {
    const today = defaultRevenueRange().dateTo;
    const from = addDays(today, -9);
    const to = addDays(today, -2);
    await renderPage({ from, to });
    expect(loadRevenueDashboard).toHaveBeenCalledWith(expect.anything(), { dateFrom: from, dateTo: to });
    expect(screen.queryByTestId("revenue-range-fallback-notice")).toBeNull();
  });

  it("恰好 92 天（含今天）可以", async () => {
    const today = defaultRevenueRange().dateTo;
    const from = addDays(today, -91);
    await renderPage({ from, to: today });
    expect(loadRevenueDashboard).toHaveBeenCalledWith(expect.anything(), { dateFrom: from, dateTo: today });
    expect(screen.queryByTestId("revenue-range-fallback-notice")).toBeNull();
  });

  // 都用相对"今天"的日期构造，免得测试随日历变化而失真。
  const BAD_RANGES: ReadonlyArray<readonly [string, (today: string) => Record<string, string>]> = [
    ["格式错误", (today) => ({ from: "2026-9-1", to: today })],
    ["反向", (today) => ({ from: today, to: addDays(today, -5) })],
    ["跨度 93 天", (today) => ({ from: addDays(today, -92), to: today })],
    ["只给了一端", (today) => ({ from: addDays(today, -5) })],
    ["结束日期晚于今天", (today) => ({ from: addDays(today, -5), to: addDays(today, 1) })],
  ];

  it.each(BAD_RANGES)("%s：回落默认区间并提示，读服务只收到合法区间", async (_label, build) => {
    await renderPage(build(defaultRevenueRange().dateTo));
    const expected = defaultRevenueRange();
    expect(loadRevenueDashboard).toHaveBeenCalledTimes(1);
    expect(loadRevenueDashboard).toHaveBeenCalledWith(expect.anything(), {
      dateFrom: expected.dateFrom,
      dateTo: expected.dateTo,
    });
    const notice = screen.getByTestId("revenue-range-fallback-notice");
    expect(notice.textContent).toContain("所选区间无效");
    expect(notice.textContent).toContain(expected.dateFrom);
    expect(notice.textContent).toContain(expected.dateTo);
  });
});

describe("/revenue · 每日明细三态", () => {
  it("reported：显示数值（千分位 / 百分比两位 / 金额两位），状态列没有任何标记", async () => {
    await renderPage();
    const row = screen.getByTestId("revenue-day-2026-10-07");
    expect(row.getAttribute("data-coverage")).toBe("reported");
    const cells = within(row).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toEqual(["2026-10-07", "12,345", "3,000", "28.27%", "28.88", ""]);
    expect(row.textContent).not.toContain("上游无记录");
    expect(row.textContent).not.toContain("未同步");
  });

  it("no_upstream_row：灰字「上游无记录」，数值列是 0（不是 —）", async () => {
    await renderPage();
    const row = screen.getByTestId("revenue-day-2026-10-06");
    expect(row.getAttribute("data-coverage")).toBe("no_upstream_row");
    const cells = within(row).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toEqual(["2026-10-06", "0", "0", "—", "0.00", "上游无记录"]);
    expect(within(row).getByText("上游无记录").className).toContain("text-gray-400");
  });

  it("not_synced：状态「未同步」，数值列全是 —（绝不显示 0）", async () => {
    await renderPage();
    const row = screen.getByTestId("revenue-day-2026-10-05");
    expect(row.getAttribute("data-coverage")).toBe("not_synced");
    const cells = within(row).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toEqual(["2026-10-05", "—", "—", "—", "—", "未同步"]);
    expect(row.textContent).not.toMatch(/\b0\b/);
  });

  it("行顺序跟读服务一致（日期倒序），覆盖区间每一天", async () => {
    await renderPage();
    const rows = within(screen.getByTestId("revenue-daily")).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "revenue-day-2026-10-07",
      "revenue-day-2026-10-06",
      "revenue-day-2026-10-05",
    ]);
  });

  it("已报告日的金额缺失（null）显示 —，不是 0.00", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ days: [{ ...REPORTED, shareIncomeUsd: null, newUserRatio: null, activeUsers: null }] }),
    );
    await renderPage();
    const cells = within(screen.getByTestId("revenue-day-2026-10-07"))
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells.slice(1, 5)).toEqual(["—", "3,000", "—", "—"]);
  });
});

describe("/revenue · 指标卡", () => {
  it("四张卡：分成收入合计 / 新用户合计 / 日均激活用户 / 数据覆盖", async () => {
    await renderPage();
    expect(within(screen.getByTestId("revenue-card-income")).getByText("28.88")).toBeTruthy();
    expect(screen.getByTestId("revenue-card-income").textContent).toContain("分成收入合计（US$）");
    expect(within(screen.getByTestId("revenue-card-new-users")).getByText("3,000")).toBeTruthy();
    expect(within(screen.getByTestId("revenue-card-avg-active")).getByText("6,172.50")).toBeTruthy();
    expect(screen.getByTestId("revenue-card-coverage").textContent).toContain(
      "上游有记录 1 天 / 上游无记录 1 天 / 未同步 1 天",
    );
  });

  it("有未同步天：卡片下方提示「区间内有 K 天未同步，合计偏小」", async () => {
    await renderPage();
    expect(screen.getByTestId("revenue-not-synced-notice").textContent).toBe("区间内有 1 天未同步，合计偏小。");
  });

  it("没有未同步天：不提示", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ summary: { ...view().summary, notSyncedDays: 0 }, days: [REPORTED, NO_UPSTREAM] }),
    );
    await renderPage();
    expect(screen.queryByTestId("revenue-not-synced-notice")).toBeNull();
  });

  it("整个区间都没被同步覆盖：合计显示 —（不是 0.00 / 0），并提示偏小", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({
        summary: {
          shareIncomeUsdTotal: "0.0000",
          newUsersTotal: 0,
          avgActiveUsers: null,
          reportedDays: 0,
          noUpstreamRowDays: 0,
          notSyncedDays: 3,
        },
        days: [NOT_SYNCED],
      }),
    );
    await renderPage();
    expect(within(screen.getByTestId("revenue-card-income")).getByText("—")).toBeTruthy();
    expect(within(screen.getByTestId("revenue-card-new-users")).getByText("—")).toBeTruthy();
    expect(within(screen.getByTestId("revenue-card-avg-active")).getByText("—")).toBeTruthy();
    expect(screen.getByTestId("revenue-not-synced-notice").textContent).toContain("3 天未同步");
  });

  it("全是「上游无记录」时合计是真实的 0.00 / 0（确实覆盖了、确实没有活动）", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({
        summary: {
          shareIncomeUsdTotal: "0.0000",
          newUsersTotal: 0,
          avgActiveUsers: "0.00",
          reportedDays: 0,
          noUpstreamRowDays: 3,
          notSyncedDays: 0,
        },
        days: [NO_UPSTREAM],
      }),
    );
    await renderPage();
    expect(within(screen.getByTestId("revenue-card-income")).getByText("0.00")).toBeTruthy();
    expect(within(screen.getByTestId("revenue-card-new-users")).getByText("0")).toBeTruthy();
    expect(within(screen.getByTestId("revenue-card-avg-active")).getByText("0.00")).toBeTruthy();
  });
});

describe("/revenue · 同步概览与凭证提示", () => {
  it("展示脱敏账号、最近批次状态与时间、最近成功同步、StarId、凭证指纹前缀", async () => {
    await renderPage();
    const overview = screen.getByTestId("revenue-sync-overview");
    expect(within(overview).getByTestId("revenue-overview-account").textContent).toContain("ch***@qq.com");
    expect(within(overview).getByTestId("revenue-overview-latest-batch").textContent).toContain("完成");
    expect(within(overview).getByTestId("revenue-overview-latest-batch").textContent).toContain("2026/10/08 09:00");
    expect(within(overview).getByTestId("revenue-overview-last-success").textContent).toContain("2026/10/08 09:00");
    expect(within(overview).getByTestId("revenue-overview-star-id").textContent).toContain("star-9001");
    expect(within(overview).getByTestId("revenue-overview-credential-prefix").textContent).toContain("ab12cd34");
    expect(within(overview).getByTestId("revenue-overview-credential").textContent).toContain("有效");
  });

  it("凭证 3 天内到期：黄色提示「凭证将于 X 到期，请到渠道账号页续期」", async () => {
    const expiresAt = isoAhead(2 * DAY);
    loadRevenueDashboard.mockResolvedValue(view({ credential: { status: "active", expiresAt } }));
    await renderPage();
    const notice = screen.getByTestId("revenue-credential-notice");
    expect(notice.getAttribute("data-tone")).toBe("warning");
    expect(notice.textContent).toContain("凭证将于");
    expect(notice.textContent).toContain("到期，请到渠道账号页续期");
    expect(within(notice).getByRole("link").getAttribute("href")).toBe("/channel-accounts");
  });

  it("凭证还有 4 天以上：不提示", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ credential: { status: "active", expiresAt: isoAhead(4 * DAY) } }),
    );
    await renderPage();
    expect(screen.queryByTestId("revenue-credential-notice")).toBeNull();
  });

  it("凭证已过期 / 非有效状态 / 未配置：红色提示", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ credential: { status: "active", expiresAt: isoAgo(HOUR) } }),
    );
    const first = await renderPage();
    expect(screen.getByTestId("revenue-credential-notice").getAttribute("data-tone")).toBe("danger");
    expect(screen.getByTestId("revenue-credential-notice").textContent).toContain("已于");
    first.unmount();

    loadRevenueDashboard.mockResolvedValue(
      view({ credential: { status: "invalid", expiresAt: isoAhead(10 * DAY) } }),
    );
    const second = await renderPage();
    expect(screen.getByTestId("revenue-credential-notice").getAttribute("data-tone")).toBe("danger");
    expect(screen.getByTestId("revenue-credential-notice").textContent).toContain("没有有效的达人凭证");
    second.unmount();

    loadRevenueDashboard.mockResolvedValue(view({ credential: null }));
    await renderPage();
    expect(screen.getByTestId("revenue-credential-notice").textContent).toContain("还没有配置达人凭证");
  });

  it("没有最近批次：概览不假装有 StarId / 指纹前缀", async () => {
    loadRevenueDashboard.mockResolvedValue(view({ batches: [], lastSuccessfulSyncAt: null }));
    await renderPage();
    expect(screen.getByTestId("revenue-overview-latest-batch").textContent).toContain("还没有同步过");
    expect(screen.getByTestId("revenue-overview-last-success").textContent).toContain("从未成功");
    expect(screen.getByTestId("revenue-overview-star-id").textContent).toBe("最近批次的 StarId—");
  });

  it("没有唯一可用账号：说明原因、每天都是未同步、同步按钮禁用", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({
        account: null,
        batches: [],
        credential: null,
        lastSuccessfulSyncAt: null,
        days: [NOT_SYNCED],
        summary: {
          shareIncomeUsdTotal: "0.0000",
          newUsersTotal: 0,
          avgActiveUsers: null,
          reportedDays: 0,
          noUpstreamRowDays: 0,
          notSyncedDays: 3,
        },
      }),
    );
    await renderPage();
    expect(screen.getByTestId("revenue-overview-no-account").textContent).toContain("没有找到唯一可用的海阅渠道账号");
    expect(screen.getByTestId("revenue-sync-no-account")).toBeTruthy();
    expect(syncSubmit().disabled).toBe(true);
  });
});

describe("/revenue · 同步面板与活跃任务", () => {
  it("没有活跃任务：按钮可用，默认区间 = 最近 7 天（结束于今天）", async () => {
    await renderPage();
    const today = defaultRevenueRange().dateTo;
    expect(syncSubmit().disabled).toBe(false);
    expect(screen.queryByTestId("revenue-active-task")).toBeNull();
    expect((screen.getByLabelText("同步结束日期") as HTMLInputElement).value).toBe(today);
    const begin = (screen.getByLabelText("同步开始日期") as HTMLInputElement).value;
    const spanDays = (Date.parse(today) - Date.parse(begin)) / DAY + 1;
    expect(spanDays).toBe(7);
  });

  it("有活跃任务：按钮禁用，并显示「已有同步任务排队中」+ 任务链接", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ activeTask: { id: TASK_ID, status: "pending", createdAt: isoAgo(60 * 1000) } }),
    );
    await renderPage();

    expect(syncSubmit().disabled).toBe(true);
    const banner = screen.getByTestId("revenue-active-task");
    expect(banner.textContent).toContain("已有同步任务排队中");
    const link = within(banner).getByRole("link");
    expect(link.getAttribute("href")).toBe(`/tasks/${TASK_ID}`);
    expect(link.textContent).toContain("#30000000");
  });

  it("活跃任务在执行中：显示「执行中」", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ activeTask: { id: TASK_ID, status: "processing", createdAt: isoAgo(60 * 1000) } }),
    );
    await renderPage();
    expect(screen.getByTestId("revenue-active-task").textContent).toContain("已有同步任务执行中");
    expect(syncSubmit().disabled).toBe(true);
  });

  it("pending 超过 10 分钟：黄色提示「未被 worker 认领」+ 白名单任务类型 + 需中止的说明（变异目标④）", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ activeTask: { id: TASK_ID, status: "pending", createdAt: isoAgo(11 * 60 * 1000) } }),
    );
    await renderPage();

    const warning = screen.getByTestId("revenue-worker-claim-warning");
    expect(warning.textContent).toContain(
      "任务排队超过 10 分钟仍未被 worker 认领。请确认生产环境主通道 WORKER_TASK_ALLOWLIST 已包含 changdu.revenue_sync.v1。",
    );
    // 漏配白名单的后果与出路也要说出来：之后每次发起都被挡住，需到任务中心中止该任务。
    expect(warning.textContent).toContain("已有同步任务");
    expect(warning.textContent).toContain("任务中心中止");
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.className).toContain("amber");
    // 按钮仍然是禁用的。
    expect(syncSubmit().disabled).toBe(true);
  });

  it("pending 才 2 分钟：没有 worker 认领提示", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ activeTask: { id: TASK_ID, status: "pending", createdAt: isoAgo(2 * 60 * 1000) } }),
    );
    await renderPage();
    expect(screen.getByTestId("revenue-active-task")).toBeTruthy();
    expect(screen.queryByTestId("revenue-worker-claim-warning")).toBeNull();
  });

  it("processing 很久也不是「未被认领」：没有该提示", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ activeTask: { id: TASK_ID, status: "processing", createdAt: isoAgo(5 * HOUR) } }),
    );
    await renderPage();
    expect(screen.queryByTestId("revenue-worker-claim-warning")).toBeNull();
  });
});

describe("/revenue · 同步记录", () => {
  it("状态中文（完成 / 部分异常 / 失败）、对账、StarId、任务链接", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({
        batches: [
          batch({ id: "b-completed" }),
          batch({
            id: "b-partial",
            status: "partial_failed",
            reconciliationStatus: "mismatched",
            errorCode: "total_row_mismatch",
            errorMessage: "明细合计与总计行不一致",
            genericTaskId: null,
          }),
          batch({
            id: "b-failed",
            status: "failed",
            detailRowCount: 0,
            reconciliationStatus: null,
            upstreamStarId: null,
            errorCode: "credential_not_star_scope",
            errorMessage: "凭证不是达人口径",
          }),
          batch({ id: "b-nototal", reconciliationStatus: "not_applicable" }),
        ],
      }),
    );
    await renderPage();

    const completed = screen.getByTestId("revenue-batch-b-completed");
    expect(completed.textContent).toContain("完成");
    expect(completed.textContent).toContain("一致");
    expect(completed.textContent).toContain("star-9001");
    expect(completed.textContent).toContain("2026-10-02 ~ 2026-10-08");
    expect(within(completed).getByRole("link").getAttribute("href")).toBe(`/tasks/${TASK_ID}`);

    const partial = screen.getByTestId("revenue-batch-b-partial");
    expect(partial.textContent).toContain("部分异常");
    expect(partial.textContent).toContain("不一致");
    expect(partial.textContent).toContain("total_row_mismatch");
    expect(within(partial).queryByRole("link")).toBeNull();

    const failed = screen.getByTestId("revenue-batch-b-failed");
    expect(failed.textContent).toContain("失败");
    expect(failed.textContent).toContain("credential_not_star_scope");

    expect(screen.getByTestId("revenue-batch-b-nototal").textContent).toContain("无总计行");
  });

  it("completed 批次带提示信息时不当失败渲染（只按批次状态着色）", async () => {
    loadRevenueDashboard.mockResolvedValue(
      view({ batches: [batch({ id: "b-note", status: "completed", errorMessage: "丢弃 2 行坏日期" })] }),
    );
    await renderPage();
    const row = screen.getByTestId("revenue-batch-b-note");
    expect(row.getAttribute("data-status")).toBe("completed");
    const message = within(row).getByTestId("revenue-batch-message");
    expect(message.textContent).toBe("丢弃 2 行坏日期");
    expect(message.parentElement?.className).toContain("text-gray-500");
    expect(message.parentElement?.className).not.toContain("text-red");
    expect(within(row).getByText("完成")).toBeTruthy();
  });

  it("错误信息过长会截断，完整内容放 title", async () => {
    const long = "x".repeat(200);
    loadRevenueDashboard.mockResolvedValue(
      view({ batches: [batch({ id: "b-long", status: "failed", errorMessage: long })] }),
    );
    await renderPage();
    const message = within(screen.getByTestId("revenue-batch-b-long")).getByTestId("revenue-batch-message");
    expect(message.textContent).toBe(`${"x".repeat(80)}…`);
    expect(message.getAttribute("title")).toBe(long);
  });

  it("没有任何批次：给出空态指引", async () => {
    loadRevenueDashboard.mockResolvedValue(view({ batches: [] }));
    await renderPage();
    expect(screen.getByTestId("revenue-batches").textContent).toContain("还没有同步记录");
  });
});

describe("/revenue · 不泄露敏感信息", () => {
  it("整页渲染结果里没有 token / 密文 / 完整指纹 / 推广码字样", async () => {
    await renderPage();
    const html = document.body.innerHTML.toLowerCase();
    for (const forbidden of ["encrypted", "ciphertext", "token", "secret", "promo_code", "promocode"]) {
      expect(html, `页面不应出现 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("/revenue · 多网文应用的合计提示（账号级口径）", () => {
  it("1 个应用：指标卡上方没有合计提示", async () => {
    await renderPage();
    expect(screen.queryByTestId("revenue-multi-app-hint")).toBeNull();
  });

  it("2 个应用：指标卡上方出现灰字提示，说明是合计、按应用拆分需另行接入上游“授权产品”维度", async () => {
    loadRevenueDashboard.mockResolvedValue(view({ account: { id: ACCOUNT_ID, label: "ch***@qq.com", novelAppCount: 2 } }));
    await renderPage();
    const hint = screen.getByTestId("revenue-multi-app-hint");
    expect(hint.textContent).toBe('上游收益接口不区分应用，以下为 2 个网文应用的合计；按应用拆分需另行接入上游"授权产品"维度。');
    // 在指标卡之前（同一个 section 里排在卡片网格前面），且是灰字而不是告警色。
    const summary = screen.getByTestId("revenue-summary");
    expect(summary.contains(hint)).toBe(true);
    expect(hint.compareDocumentPosition(screen.getByTestId("revenue-card-income")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hint.className).toContain("text-gray-500");
  });

  it("没有可用账号：不显示合计提示", async () => {
    loadRevenueDashboard.mockResolvedValue(view({ account: null }));
    await renderPage();
    expect(screen.queryByTestId("revenue-multi-app-hint")).toBeNull();
  });
});
