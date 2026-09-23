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
    isLifecyclePromoClaimShard: false,
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
    expect(screen.queryByTestId("task-detail-static-summary")).toBeNull();
    expect(screen.queryByTestId("task-detail-static-progress")).toBeNull();
  });

  it("失败/部分失败状态下渲染「重试失败项」按钮", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({ status: "failed" }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(screen.getByTestId("retry-failed-open")).toBeTruthy();
  });

  it("finalize 单独失败时渲染正式重新收尾入口，不伪造失败页数", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "catalog_scan",
      status: "completed_with_errors",
      failedCount: 0,
      catalogFinalize: { status: "failed", attemptCount: 3, generation: 1, retryable: true },
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    const element = await renderPage();
    render(element);

    expect(screen.getByTestId("retry-catalog-finalize-open")).toBeTruthy();
    expect(screen.queryByTestId("retry-failed-open")).toBeNull();
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

  it("目录父任务显示子任务链接和中文未提交原因，且不提供重试", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "batch.materialize.v1",
      status: "completed_with_errors",
      catalogBatch: {
        phase: "completed_with_errors",
        submittedCount: 4,
        ineligibleCount: 1,
        blockedCount: 2,
        blockedReasonCounts: { active_scope_conflict: 2, internal_reason: 9 },
        childTasks: [{ taskId: "20000000-0000-4000-8000-000000000001", taskType: "promo_link_claim", status: "pending" }],
      },
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.queryByTestId("retry-failed-open")).toBeNull();
    expect(screen.getByTestId("catalog-batch-blocked-explanation").textContent).toContain("当前范围已有进行中的任务：2 条");
    expect(screen.getByTestId("catalog-batch-blocked-explanation").textContent).not.toContain("internal_reason");
    expect(screen.getByText(/状态不符合／未找到 1 条/)).toBeTruthy();
    const link = screen.getByText("查看子任务") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("family=generic");
  });

  it("小说纳入父任务显示两类 locale 阻断中文文案，未知 reason key 仍不泄露", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "batch.materialize.v1",
      status: "completed_with_errors",
      catalogBatch: {
        phase: "completed_with_errors",
        submittedCount: 1,
        ineligibleCount: 0,
        blockedCount: 5,
        blockedReasonCounts: { missing_locale: 2, unsupported_locale: 3, internal_reason: 9 },
        childTasks: [],
      },
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    const explanation = screen.getByTestId("catalog-batch-blocked-explanation");
    expect(explanation.textContent).toContain("来源语言缺失：2 条");
    expect(explanation.textContent).toContain("来源语言暂不受产品支持：3 条");
    expect(explanation.textContent).not.toContain("internal_reason");
  });

  it("文章批量父任务显示 article.generate.v1 子任务入口，且不提供整父重试", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "article.generate.batch.v1",
      status: "processing",
      catalogBatch: {
        phase: "executing",
        submittedCount: 400,
        ineligibleCount: null,
        alreadyLinkedCount: null,
        blockedCount: 0,
        blockedReasonCounts: {},
        childTasks: [{ taskId: "20000000-0000-4000-8000-000000000001", taskType: "article.generate.v1", status: "pending" }],
      },
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.queryByTestId("retry-failed-open")).toBeNull();
    expect(screen.getByText("article.generate.v1 · 待处理")).toBeTruthy();
    const link = screen.getByText("查看子任务") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/tasks/20000000-0000-4000-8000-000000000001?family=generic");
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
    failedPages: 1,
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

    expect(screen.getByText("80 / 89 本")).toBeTruthy();
  });

  it("终态失败书数未知时显示“未知”与失败页数，进度仍按真实成功书数计算", async () => {
    getAdminTaskDetail.mockResolvedValue(
      detail({
        taskType: "catalog_scan",
        status: "completed_with_errors",
        bookCounts: {
          upstreamTotal: 97320,
          fetched: 97300,
          failedBooks: null,
          failedPages: 123,
          pagesScanned: 1096,
          pagesTotalExpected: 974,
          percent: 99.97,
        },
      }),
    );
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.getByText("未知")).toBeTruthy();
    expect(screen.getByText("123 页失败")).toBeTruthy();
    expect(screen.getByText("97,300 / 97,320 本")).toBeTruthy();
    expect(screen.queryByText("0 本")).toBeNull();
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

/**
 * 阶段2 第4步（施工任务 3.5，旧路径缺陷修复）：非生命周期的目录批次父任务，
 * 在自身原始状态（`parentRawStatus`）已经是自然终态（completed/
 * completed_with_errors/failed）但仍有未完成子任务时，不能显示会 409 的
 * 暂停/恢复/中止按钮——2026-09-23 Owner 实际遇到：父批次 bfae6a25 已完成，
 * 真正在跑的是子任务，点击"中止"返回 409。
 */
describe("/tasks/[id] · 旧路径缺陷修复：批次自身已完成但仍有子任务在运行", () => {
  it("parentRawStatus=completed 且有未完成子任务时，不渲染暂停/恢复/中止按钮，改为提示到子任务列表", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "batch.materialize.v1",
      status: "processing", // 派生后的展示状态——正确反映"仍有子任务在跑"。
      parentRawStatus: "completed", // 批次自身原始列值——已经是终态，旧代码会拿它去调 pause/abort 导致 409。
      catalogBatch: {
        phase: "executing",
        submittedCount: 2,
        ineligibleCount: 0,
        blockedCount: 0,
        blockedReasonCounts: {},
        childTasks: [{ taskId: "20000000-0000-4000-8000-000000000001", taskType: "promo_link.claim.v1", status: "pending" }],
      },
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.queryByTestId("task-pause-open")).toBeNull();
    expect(screen.queryByTestId("task-abort-open")).toBeNull();
    expect(screen.queryByTestId("task-resume-open")).toBeNull();
    expect(screen.getByTestId("parent-batch-active-children-note")).toBeTruthy();
  });

  it("parentRawStatus=completed 但所有子任务都已终态时，不显示提示（也没有按钮可点，因为 completed 本来就不满足单任务按钮的可点性）", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "batch.materialize.v1",
      status: "completed",
      parentRawStatus: "completed",
      catalogBatch: {
        phase: "completed",
        submittedCount: 2,
        ineligibleCount: 0,
        blockedCount: 0,
        blockedReasonCounts: {},
        childTasks: [{ taskId: "20000000-0000-4000-8000-000000000001", taskType: "promo_link.claim.v1", status: "completed" }],
      },
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.queryByTestId("parent-batch-active-children-note")).toBeNull();
    expect(screen.queryByTestId("task-abort-open")).toBeNull(); // completed 本就不满足单任务按钮的可点性。
  });

  it("parentRawStatus 是 pending/processing（批次自己还没走完）时，即使有未完成子任务，也正常显示单任务控制按钮，不显示提示", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "batch.materialize.v1",
      status: "processing",
      parentRawStatus: "processing",
      catalogBatch: {
        phase: "materializing",
        submittedCount: null,
        ineligibleCount: null,
        blockedCount: 0,
        blockedReasonCounts: {},
        childTasks: [],
      },
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.queryByTestId("parent-batch-active-children-note")).toBeNull();
    expect(screen.getByTestId("task-pause-open")).toBeTruthy();
  });

  it("非批次任务（没有 catalogBatch）完全不受影响：parentRawStatus 缺失时按钮沿用 detail.status 判定，逐字不变", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({ status: "processing" }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.getByTestId("task-pause-open")).toBeTruthy();
    expect(screen.queryByTestId("parent-batch-active-children-note")).toBeNull();
  });
});

/**
 * 阶段2 第4步（施工任务 3.5）：生命周期批次改用批次级暂停/恢复/中止控制
 * （`PromoClaimBatchControlButtons`），并渲染分片列表——不是通用的单任务
 * `TaskControlButtons`/子任务链接列表。
 */
describe("/tasks/[id] · 生命周期批次：批次级控制 + 分片列表", () => {
  function lifecycleDetail(overrides: Partial<TaskDetailDto> = {}): TaskDetailDto {
    return detail({
      taskType: "batch.materialize.v1",
      status: "processing",
      parentRawStatus: "completed",
      catalogBatch: {
        phase: "executing",
        submittedCount: 2,
        ineligibleCount: 0,
        blockedCount: 0,
        blockedReasonCounts: {},
        childTasks: [
          { taskId: "30000000-0000-4000-8000-000000000001", taskType: "promo_link.claim.v1", status: "pending" },
          { taskId: "30000000-0000-4000-8000-000000000002", taskType: "promo_link.claim.v1", status: "disabled" },
        ],
        promoClaimLifecycle: {
          shardPlan: { windowMinutes: 90, shardSizeMin: 50, shardSizeMax: 1000, shardCount: 2, shardSize: 1 },
          shards: [
            {
              taskId: "30000000-0000-4000-8000-000000000001", shardIndex: 0, status: "pending",
              releaseCount: 1, missedDeadlineCount: 0,
              releasedAt: "2026-09-23T09:00:00.000Z", deadlineAt: "2026-09-23T10:30:00.000Z",
              totalCount: 1, claimedCount: 0, withCodeCount: 0, manualReviewCount: 0, failedCount: 0, skippedCount: 0, remainingCount: 1,
            },
            {
              taskId: "30000000-0000-4000-8000-000000000002", shardIndex: 1, status: "disabled",
              releaseCount: 0, missedDeadlineCount: 0,
              totalCount: 1, claimedCount: 0, withCodeCount: 0, manualReviewCount: 0, failedCount: 0, skippedCount: 0, remainingCount: 1,
              holdKind: "awaiting_release",
            },
          ],
          counts: { total: 2, claimed: 0, withCode: 0, manualReview: 0, failed: 0, skipped: 0, remaining: 2 },
          etaMinutes: 120,
        },
      },
      ...overrides,
    });
  }

  it("渲染批次级暂停按钮而不是通用单任务按钮；分片列表包含计数、放行次数与截止时间", async () => {
    getAdminTaskDetail.mockResolvedValue(lifecycleDetail());
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.getByTestId("promo-claim-batch-pause-open")).toBeTruthy();
    expect(screen.queryByTestId("task-pause-open")).toBeNull();
    expect(screen.queryByTestId("task-abort-open")).toBeNull();
    expect(screen.queryByTestId("parent-batch-active-children-note")).toBeNull();
    expect(screen.queryByTestId("catalog-batch-child-tasks")).toBeNull(); // 改用富信息分片列表，不重复渲染通用子任务列表。

    const shardList = screen.getByTestId("promo-claim-shard-list");
    expect(shardList.textContent).toContain("已领取");
    expect(shardList.textContent).toContain("已有推广码");
    expect(shardList.textContent).toContain("人工核对");
    expect(shardList.textContent).toContain("跳过"); // F1：新增独立的"跳过"卡片，不再并进"已领取"。
    expect(screen.getAllByTestId("promo-claim-shard-row")).toHaveLength(2);
    expect(screen.getByTestId("promo-claim-eta").textContent).toContain("2.0 小时");
  });

  it("批次处于 system_hold:approval_expired 时显示重新批准按钮；恢复方式说明中文可见", async () => {
    getAdminTaskDetail.mockResolvedValue(lifecycleDetail({
      parentRawStatus: "disabled",
      taskControl: { kind: "system_hold", source: "system", at: "2026-09-23T09:00:00.000Z", reasonCode: "approval_expired" },
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.getByTestId("promo-claim-batch-reapprove-open")).toBeTruthy();
    expect(screen.queryByTestId("promo-claim-batch-pause-open")).toBeNull(); // 已经是 disabled，暂停按钮不出现。
    expect(screen.getByTestId("system-hold-recovery-hint").textContent).toContain("重新批准");
  });

  it("批次处于 system_hold:deadline_missed_twice 且 reason=unsafe_to_auto_retry 时，说明存在已尝试或已调用过领取接口的条目", async () => {
    getAdminTaskDetail.mockResolvedValue(lifecycleDetail({
      parentRawStatus: "disabled",
      taskControl: {
        kind: "system_hold", source: "system", at: "2026-09-23T09:00:00.000Z",
        reasonCode: "deadline_missed_twice", reason: "unsafe_to_auto_retry",
      },
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.getByTestId("system-hold-recovery-hint").textContent).toContain("禁止自动重试");
    expect(screen.queryByTestId("promo-claim-batch-reapprove-open")).toBeNull(); // 只有 approval_expired 才显示重新批准。
  });
});

/**
 * 阶段2 第4步（Opus 复核 2026-09-24 F2）：生命周期分片自己的任务详情页
 * （/tasks/<shardId>，taskType=promo_link.claim.v1）——单任务的"暂停"/
 * "恢复"必须隐藏并引导到批次页面，"中止"仍然可用。
 */
describe("/tasks/[id] · 生命周期分片自己的详情页：暂停/恢复隐藏，引导到批次页面", () => {
  it("分片处于 pending 时：隐藏暂停按钮、显示引导说明；中止按钮仍然可用", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "promo_link.claim.v1",
      status: "pending",
      isLifecyclePromoClaimShard: true,
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.queryByTestId("task-pause-open")).toBeNull();
    expect(screen.queryByTestId("task-resume-open")).toBeNull();
    expect(screen.getByTestId("task-abort-open")).toBeTruthy();
    expect(screen.getByTestId("lifecycle-shard-control-redirect-note").textContent).toContain("批次详情页");
  });

  it("分片处于 paused 时：隐藏恢复按钮、显示引导说明；中止按钮仍然可用", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "promo_link.claim.v1",
      status: "paused",
      isLifecyclePromoClaimShard: true,
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.queryByTestId("task-resume-open")).toBeNull();
    expect(screen.getByTestId("task-abort-open")).toBeTruthy();
    expect(screen.getByTestId("lifecycle-shard-control-redirect-note")).toBeTruthy();
  });

  it("非生命周期的 promo_link.claim.v1 任务（旧路径子任务）：正常显示暂停按钮，不显示引导说明", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "promo_link.claim.v1",
      status: "pending",
      isLifecyclePromoClaimShard: false,
    }));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));

    render(await renderPage());

    expect(screen.getByTestId("task-pause-open")).toBeTruthy();
    expect(screen.queryByTestId("lifecycle-shard-control-redirect-note")).toBeNull();
  });
});
