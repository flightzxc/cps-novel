import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSessionView } from "@/contracts";
import type { TaskDetailDto, TaskItemDto } from "@/server/task-admin";

/**
 * 文章后台批量发布批次的任务详情页（2026-10-06）。harness 与 `admin-task-detail-page.test.tsx`
 * 相同：只 mock `getAdminTaskDetail`/`listAdminTaskItems`，其它导出保持真实。
 *
 * 要点：①发布批次的父任务页本身就有整批「暂停/恢复/中止」（服务端级联），而不是像建稿批次
 * 那样提示"到子任务列表逐个操作"；②「重试失败项」对发布批次可见（建稿批次不可见）；
 * ③「发布结果」一节按拒绝原因汇总，并展示试读与站点地图收尾情况。
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


const BATCH_TYPE = "article.publish.batch.v1";

function publishBatch(overrides: Partial<TaskDetailDto> = {}): TaskDetailDto {
  return detail({
    taskType: BATCH_TYPE,
    status: "processing",
    parentRawStatus: "completed",
    totalCount: 1000,
    successCount: 600,
    failedCount: 0,
    skippedCount: 0,
    catalogBatch: {
      phase: "executing",
      submittedCount: 1000,
      ineligibleCount: null,
      alreadyLinkedCount: null,
      blockedCount: 0,
      blockedReasonCounts: {},
      childTasks: [
        { taskId: "c1", taskType: "article.publish.v1", status: "processing" },
        { taskId: "c2", taskType: "article.publish.v1", status: "pending" },
      ],
    },
    articlePublishBatch: {
      skipPreview: false,
      publishedCount: 600,
      rejectedCount: 0,
      otherFailedCount: 0,
      notDraftCount: 0,
      notFoundCount: 0,
      abortedUnattemptedCount: 0,
      unfinishedCount: 400,
      rejectedReasonCounts: {},
      preview: { skippedBookCount: null, dispatchedChildCount: 3, taskGroupCount: 3 },
      sitemapRefresh: null,
    },
    ...overrides,
  } as Partial<TaskDetailDto>);
}

async function renderBatch(overrides: Partial<TaskDetailDto> = {}) {
  getAdminTaskDetail.mockResolvedValue(publishBatch(overrides));
  listAdminTaskItems.mockResolvedValue(itemsResult([]));
  render(await renderPage());
}

describe("/tasks/[id] · 文章后台批量发布批次", () => {
  it("运行中：父任务页直接给整批「暂停」「中止」，不出现「到子任务列表逐个操作」的提示", async () => {
    await renderBatch();
    expect(screen.getByTestId("task-pause-open")).toBeTruthy();
    expect(screen.getByTestId("task-abort-open")).toBeTruthy();
    expect(screen.queryByTestId("task-resume-open")).toBeNull();
    expect(screen.queryByTestId("parent-batch-active-children-note")).toBeNull();
  });

  it("整批暂停后：给「恢复」「中止」，没有「暂停」", async () => {
    await renderBatch({ status: "paused" });
    expect(screen.getByTestId("task-resume-open")).toBeTruthy();
    expect(screen.getByTestId("task-abort-open")).toBeTruthy();
    expect(screen.queryByTestId("task-pause-open")).toBeNull();
  });

  it("已中止 / 已完成：没有任何整批控制按钮", async () => {
    await renderBatch({ status: "cancelled" });
    expect(screen.queryByTestId("task-pause-open")).toBeNull();
    expect(screen.queryByTestId("task-resume-open")).toBeNull();
    expect(screen.queryByTestId("task-abort-open")).toBeNull();
  });

  it("批次进度文案只说草稿篇数与子任务数，不套用目录批次的「已纳入/状态不符合」口径", async () => {
    await renderBatch();
    const text = document.body.textContent ?? "";
    expect(text).toContain("共 1,000 篇草稿");
    expect(text).toContain("共 2 个");
    expect(text).not.toContain("已纳入");
    expect(text).not.toContain("状态不符合");
  });

  it("有失败条目（完成但有异常）：显示「重试失败项」；发布结果按发布检查拒绝原因汇总，并提示重试不会重复发布", async () => {
    await renderBatch({
      status: "completed_with_errors",
      failedCount: 5,
      articlePublishBatch: {
        skipPreview: false,
        publishedCount: 995,
        rejectedCount: 5,
        otherFailedCount: 0,
        notDraftCount: 0,
        notFoundCount: 0,
        abortedUnattemptedCount: 0,
        unfinishedCount: 0,
        rejectedReasonCounts: { promo_link_not_ready: 3, required_metadata_missing: 2 },
        preview: { skippedBookCount: null, dispatchedChildCount: 5, taskGroupCount: 5 },
        sitemapRefresh: { status: "queued", triggerCount: 1, triggeredAt: "2026-10-06T10:00:00.000Z" },
      },
    });
    expect(screen.getByTestId("retry-failed-open")).toBeTruthy();
    const reasons = screen.getByTestId("article-publish-batch-rejected-reasons").textContent ?? "";
    expect(screen.getByTestId("article-publish-batch-reason-promo_link_not_ready").textContent).toContain("3 篇");
    expect(screen.getByTestId("article-publish-batch-reason-required_metadata_missing").textContent).toContain("2 篇");
    expect(reasons).toContain("不会被重复发布");
    expect(screen.getByTestId("article-publish-batch-counts").textContent).toContain("已发布 995 篇");
    expect(screen.getByTestId("article-publish-batch-counts").textContent).toContain("发布检查未通过 5 篇");
    expect(screen.getByTestId("article-publish-batch-sitemap").textContent).toContain("已触发");
  });

  it("勾了「暂不抓试读」：说明跳过，并展示父任务结果里记录的跳过本数", async () => {
    await renderBatch({
      status: "completed",
      articlePublishBatch: {
        skipPreview: true,
        publishedCount: 400,
        rejectedCount: 0,
        otherFailedCount: 0,
        notDraftCount: 0,
        notFoundCount: 0,
        abortedUnattemptedCount: 0,
        unfinishedCount: 0,
        rejectedReasonCounts: {},
        preview: { skippedBookCount: 400, dispatchedChildCount: 0, taskGroupCount: 0 },
        sitemapRefresh: null,
      },
    });
    const preview = screen.getByTestId("article-publish-batch-preview").textContent ?? "";
    expect(preview).toContain("暂不抓试读");
    expect(preview).toContain("400 本书");
    expect(screen.queryByTestId("article-publish-batch-rejected-reasons")).toBeNull();
  });

  it("没有失败条目时不显示「重试失败项」", async () => {
    await renderBatch({ status: "completed", failedCount: 0 });
    expect(screen.queryByTestId("retry-failed-open")).toBeNull();
  });

  it("不会误伤别的任务类型：建稿批次（article.generate.batch.v2）父任务仍然提示去子任务列表操作、没有重试失败项", async () => {
    getAdminTaskDetail.mockResolvedValue(detail({
      taskType: "article.generate.batch.v2",
      status: "processing",
      parentRawStatus: "completed",
      failedCount: 2,
      catalogBatch: {
        phase: "executing", submittedCount: 10, ineligibleCount: null, alreadyLinkedCount: null,
        blockedCount: 0, blockedReasonCounts: {},
        childTasks: [{ taskId: "g1", taskType: "article.generate.v1", status: "processing" }],
      },
    } as Partial<TaskDetailDto>));
    listAdminTaskItems.mockResolvedValue(itemsResult([]));
    render(await renderPage());
    expect(screen.getByTestId("parent-batch-active-children-note")).toBeTruthy();
    expect(screen.queryByTestId("task-pause-open")).toBeNull();
    expect(screen.queryByTestId("article-publish-batch-summary")).toBeNull();
  });
});
