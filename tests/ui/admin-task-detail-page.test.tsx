import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSessionView } from "@/contracts";
import type { TaskDetailDto, TaskItemDto } from "@/server/task-admin";

/**
 * C-9 (`施工工单_C9_任务详情独立路由对齐CPS_2026-09-07.md`): the new
 * `/tasks/[id]` route, invoked the same way `categories-disabled-state.
 * test.tsx` invokes its own Server Component page (`await Page(...)`, then
 * `render(element)`). `@/server/task-admin` is mocked only at the two
 * functions the page calls (`getAdminTaskDetail`/`listAdminTaskItems`) —
 * `importOriginal` keeps every other export real, in particular the actual
 * `TaskAdminError` class the page's per-family probe does an `instanceof`
 * check against.
 */

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const logoutAction = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/app/(admin-auth)/_lib/logout-action", () => ({ logoutAction }));

vi.mock("@/features/admin-ui/sidebar", () => ({
  AdminSidebar: () => <nav data-testid="stub-sidebar" />,
}));

const channelAccountFindUnique = vi.hoisted(() => vi.fn());
vi.mock("@/app/api/admin/_lib/deps", () => ({
  prisma: { channelAccount: { findUnique: channelAccountFindUnique } },
}));

const requireContentPage = vi.hoisted(() => vi.fn());
vi.mock("@/app/(admin)/novels/_lib/content-page-guard", () => ({ requireContentPage }));

const SESSION: AdminSessionView = {
  identityId: "id-1",
  username: "root",
  role: "super_admin",
  twoFactorCompleted: true,
  idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  capabilities: [{ capability: "task:manage", state: "granted" }],
};

vi.mock("@/app/(admin)/_lib/page-guard", () => ({
  sessionView: () => SESSION,
  capabilityViews: () => SESSION.capabilities,
}));

const getAdminTaskDetail = vi.hoisted(() => vi.fn());
const listAdminTaskItems = vi.hoisted(() => vi.fn());
vi.mock("@/server/task-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/task-admin")>();
  return { ...actual, getAdminTaskDetail, listAdminTaskItems };
});

const { default: TaskDetailPage } = await import("@/app/(admin)/tasks/[id]/page");
const { TaskAdminError } = await import("@/server/task-admin");

const TASK_ID = "10000000-0000-4000-8000-000000000001";

function detail(overrides: Partial<TaskDetailDto> = {}): TaskDetailDto {
  return {
    family: "generic",
    taskId: TASK_ID,
    taskType: "moboreader.sync",
    status: "completed_with_errors",
    totalCount: 10,
    successCount: 7,
    failedCount: 3,
    skippedCount: 0,
    errorSummary: "redacted",
    createdAt: "2026-08-26T02:00:00.000Z",
    updatedAt: "2026-08-26T02:30:00.000Z",
    mode: "apply",
    ...overrides,
  };
}

function item(overrides: Partial<TaskItemDto> = {}): TaskItemDto {
  return {
    family: "generic",
    itemId: "60000000-0000-4000-8000-000000000001",
    taskId: TASK_ID,
    status: "failed",
    attemptCount: 2,
    leaseEpoch: "3",
    lockedUntil: null,
    errorSummary: "redacted",
    ...overrides,
  };
}

function itemsResult(items: TaskItemDto[], overrides: Record<string, unknown> = {}) {
  return {
    family: "generic" as const,
    taskId: TASK_ID,
    items,
    limit: 50,
    page: 1,
    pageSize: 50,
    total: items.length,
    totalPages: 1,
    ...overrides,
  };
}

function renderPage(searchParams: Record<string, string> = {}) {
  return TaskDetailPage({
    params: Promise.resolve({ id: TASK_ID }),
    searchParams: Promise.resolve(searchParams),
  });
}

beforeEach(() => {
  getAdminTaskDetail.mockReset();
  listAdminTaskItems.mockReset();
  channelAccountFindUnique.mockReset();
  channelAccountFindUnique.mockResolvedValue(null);
  requireContentPage.mockReset();
  requireContentPage.mockResolvedValue({ context: {}, granted: true });
  routerRefresh.mockClear();
});

describe("/tasks/[id] · 家族解析 + 404", () => {
  it("默认（无 ?family=）优先探测 generic，命中则不再探测 channel_sync", async () => {
    getAdminTaskDetail.mockImplementation(async (_db: unknown, _ctx: unknown, input: { family: string }) => {
      if (input.family === "generic") return detail();
      throw new TaskAdminError("task_admin_not_found", 404);
    });
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(getAdminTaskDetail).toHaveBeenCalledTimes(1);
    expect(getAdminTaskDetail).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ family: "generic", taskId: TASK_ID }),
    );
    expect(screen.getByText(/任务详情 #/)).toBeTruthy();
  });

  it("?family=channel_sync 命中提示族时，只探测一次 channel_sync", async () => {
    getAdminTaskDetail.mockImplementation(async (_db: unknown, _ctx: unknown, input: { family: string }) => {
      if (input.family === "channel_sync") return detail({ family: "channel_sync", taskType: "moboreader.preview_refresh.v1" });
      throw new TaskAdminError("task_admin_not_found", 404);
    });
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage({ family: "channel_sync" });
    render(element);

    expect(getAdminTaskDetail).toHaveBeenCalledTimes(1);
    expect(getAdminTaskDetail).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ family: "channel_sync" }),
    );
    expect(screen.getByText(/渠道同步/)).toBeTruthy();
  });

  it("缺省 ?family= 时，generic 探测落空后仍会回退探测 channel_sync 并成功渲染", async () => {
    getAdminTaskDetail.mockImplementation(async (_db: unknown, _ctx: unknown, input: { family: string }) => {
      if (input.family === "channel_sync") return detail({ family: "channel_sync" });
      throw new TaskAdminError("task_admin_not_found", 404);
    });
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(getAdminTaskDetail).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/任务详情 #/)).toBeTruthy();
  });

  it("两族都探测不到时调用 notFound()，而不是渲染错误页", async () => {
    getAdminTaskDetail.mockRejectedValue(new TaskAdminError("task_admin_not_found", 404));

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(listAdminTaskItems).not.toHaveBeenCalled();
  });

  it("权限不足时展示能力拒绝面板，不查询任务", async () => {
    requireContentPage.mockResolvedValue({ context: {}, granted: false });

    const element = await renderPage();
    render(element);

    expect(screen.getByTestId("content-capability-denied")).toBeTruthy();
    expect(getAdminTaskDetail).not.toHaveBeenCalled();
  });
});

describe("/tasks/[id] · 页面区块", () => {
  it("终态任务不渲染实时进度轮询组件", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({ status: "completed" }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(screen.queryByTestId("import-progress-task-id")).toBeNull();
  });

  it("非终态任务渲染实时进度轮询组件", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({ status: "processing" }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(screen.getByTestId("import-progress-task-id").textContent).toContain(TASK_ID);
  });

  it("失败/部分失败状态下渲染「重试失败项」按钮", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({ status: "failed" }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(screen.getByTestId("retry-failed-open")).toBeTruthy();
  });

  it("账号标签来自 channelAccountId → business_id", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({ channelAccountId: "40000000-0000-4000-8000-000000000001" }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));
    channelAccountFindUnique.mockResolvedValue({
      id: "40000000-0000-4000-8000-000000000001",
      businessId: "biz-001",
      accountName: "示例账号",
    });

    const element = await renderPage();
    render(element);

    const label = screen.getByTestId("task-detail-account-label");
    expect(label.textContent).toContain("示例账号");
    expect(label.textContent).toContain("biz-001");
  });

  it("状态页签与分页参数透传给 listAdminTaskItems（URL 往返）", async () => {
    getAdminTaskDetail.mockResolvedValue(detail());
    listAdminTaskItems.mockResolvedValue(itemsResult([item()], { page: 2, total: 120, totalPages: 3 }));

    const element = await renderPage({ status: "failed", page: "2" });
    render(element);

    expect(listAdminTaskItems).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ family: "generic", taskId: TASK_ID, status: "failed", page: 2 }),
    );
    expect(screen.getByTestId("task-item-status-tab-failed").className).toContain("bg-blue-600");
  });
});

describe("/tasks/[id] · catalog_scan 单位与派生审计字段", () => {
  it("目录任务汇总卡片与子项计数带「页」单位", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({ taskType: "catalog_scan", totalCount: 2000, successCount: 1800 }));
    listAdminTaskItems.mockResolvedValue(itemsResult([], { total: 2000, totalPages: 40 }));

    const element = await renderPage();
    render(element);

    expect(screen.getByText("总计（页）")).toBeTruthy();
    const itemsSection = screen.getByTestId("task-items-section");
    expect(itemsSection.textContent).toContain("2000");
    expect(itemsSection.textContent).toContain("页");
  });

  it("目录任务展示派生审计字段：上游返回 total / 实际抓取条数 / 最后一页 / 保险丝页数", async () => {
    getAdminTaskDetail.mockResolvedValue(
      detail({
        taskType: "catalog_scan",
        stopReason: "upstream_error",
        catalogScanConfig: {
          pageStart: 1, pageEnd: 100, pageSize: 20, safetyMaxPages: 2000,
          languages: ["en", "ja"], source: "manual", requestId: "req-1",
        },
        catalogScanAudit: { observedTotal: 4823, actualFetchedCount: 88, lastCompletedPage: 4 },
      }),
    );
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    const audit = screen.getByTestId("task-catalog-audit");
    expect(audit.textContent).toContain("4,823");
    expect(audit.textContent).toContain("88");
    expect(audit.textContent).toContain("upstream_error");
    expect(audit.textContent).toContain("2,000");

    const config = screen.getByTestId("task-config-summary");
    expect(config.textContent).toContain("第 1–100 页");
    expect(config.textContent).toContain("en、ja");
  });

  it("originStopReason 存在时，停止原因展示更丰富的 origin-item 行而非任务级裸码（C-10b）", async () => {
    getAdminTaskDetail.mockResolvedValue(
      detail({
        taskType: "catalog_scan",
        stopReason: "upstream_error",
        originStopReason: "upstream_error (HTTP 401) @ 第 1 页",
        catalogScanAudit: { observedTotal: 4823, actualFetchedCount: 88, lastCompletedPage: 4 },
      }),
    );
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    const audit = screen.getByTestId("task-catalog-audit");
    expect(audit.textContent).toContain("upstream_error (HTTP 401) @ 第 1 页");
  });

  it("目录任务子项行展示页号（第 N 页），非目录任务不展示该列", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({ taskType: "catalog_scan" }));
    listAdminTaskItems.mockResolvedValue(
      itemsResult([item({ pageNumber: 7 })]),
    );

    const element = await renderPage();
    render(element);

    const row = screen.getByTestId(`task-item-row-${item().itemId}`);
    expect(row.textContent).toContain("第 7 页");
  });

  it("非目录任务不展示页号列与页单位", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({ taskType: "chapter_sync" }));
    listAdminTaskItems.mockResolvedValue(itemsResult([item()]));

    const element = await renderPage();
    render(element);

    expect(screen.queryByText("总计（页）")).toBeNull();
    const row = screen.getByTestId(`task-item-row-${item().itemId}`);
    expect(row.textContent).not.toContain("第");
  });
});

describe("/tasks/[id] · C-12 bookCounts 单位切换", () => {
  const BOOK_COUNTS = {
    upstreamTotal: 89,
    fetched: 80,
    failedBooks: 20,
    pagesScanned: 5,
    pagesTotalExpected: 5,
    percent: 90,
  };

  it("bookCounts 存在时，汇总卡片展示「本」单位与派生数值，不再展示跳过卡片", async () => {
    getAdminTaskDetail.mockResolvedValue(
      detail({
        taskType: "catalog_scan",
        totalCount: 2000,
        successCount: 4,
        failedCount: 1997,
        skippedCount: 0,
        bookCounts: BOOK_COUNTS,
      }),
    );
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(screen.getByText("总计（本）")).toBeTruthy();
    expect(screen.getByText("成功（本）")).toBeTruthy();
    expect(screen.getByText("失败（本）")).toBeTruthy();
    expect(screen.getByText("89")).toBeTruthy();
    expect(screen.getByText("80")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.queryByText("总计（页）")).toBeNull();
    // The skip card itself (labeled "跳过（页）"/"跳过（本）") is gone — the
    // bare "跳过" item-status filter tab elsewhere on the page is unrelated
    // and unaffected, so this checks the parenthetical-unit label specifically.
    expect(screen.queryByText("跳过（页）")).toBeNull();
    expect(screen.queryByText("跳过（本）")).toBeNull();
  });

  it("bookCounts 存在时，任务进度条的分子/分母改为本口径", async () => {
    getAdminTaskDetail.mockResolvedValue(
      detail({
        taskType: "catalog_scan",
        status: "completed_with_errors",
        totalCount: 2000,
        successCount: 4,
        failedCount: 1997,
        skippedCount: 0,
        bookCounts: BOOK_COUNTS,
      }),
    );
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(screen.getByText("100 / 89 本")).toBeTruthy(); // (fetched 80 + failedBooks 20) / upstreamTotal 89
  });

  it("bookCounts 缺失时（尚未拿到首页），汇总卡片与进度条维持既有页口径展示", async () => {
    getAdminTaskDetail.mockResolvedValue(
      detail({ taskType: "catalog_scan", totalCount: 2000, successCount: 4, failedCount: 0, skippedCount: 0 }),
    );
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(screen.getByText("总计（页）")).toBeTruthy();
    expect(screen.queryByText("总计（本）")).toBeNull();
    expect(screen.getByText("4 / 2000")).toBeTruthy();
  });
});
