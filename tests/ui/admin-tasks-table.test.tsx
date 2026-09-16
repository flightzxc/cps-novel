import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TasksTable, type TaskSummaryRow } from "@/app/(admin)/tasks/_components/tasks-table";

function task(overrides: Partial<TaskSummaryRow> = {}): TaskSummaryRow {
  return {
    family: "channel_sync",
    taskId: "11111111-1111-4111-8111-111111111111",
    taskType: "chapter_sync",
    status: "failed",
    totalCount: 10,
    successCount: 7,
    failedCount: 3,
    skippedCount: 0,
    errorSummary: "redacted",
    ...overrides,
  };
}

describe("TasksTable · 两类任务统一列表", () => {
  it("空态给出可操作指引，而不是一句「没有数据」", () => {
    render(<TasksTable tasks={[]} />);
    expect(screen.getByTestId("tasks-empty-state").textContent).toMatch(/family|状态/);
  });

  it("渲染 family / task_type / 状态 / 三类计数 / 失败原因列", () => {
    render(<TasksTable tasks={[task()]} />);
    expect(screen.getByText("渠道同步")).toBeTruthy();
    expect(screen.getByText("chapter_sync")).toBeTruthy();
    expect(screen.getByTestId(`task-status-${task().taskId}`).textContent).toBe("失败");
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("unknown redacted errors show the safe generic fallback", () => {
    render(<TasksTable tasks={[task({ errorSummary: "redacted" })]} />);
    expect(screen.getByText("系统异常，详情见审计/日志")).toBeTruthy();
    expect(screen.queryByText("redacted")).toBeNull();
  });

  it("errorSummary 为 null 时展示占位符而不是脱敏说明", () => {
    render(<TasksTable tasks={[task({ errorSummary: null })]} />);
    expect(screen.queryByText("系统异常，详情见审计/日志")).toBeNull();
  });

  // C-10 (Phase E rework, 2026-09-07): a derived stop reason is a stable
  // enum code, not free text — it replaces "已脱敏" in this column when the
  // service could derive one for the task.
  it("stopReason 存在时展示该稳定码，替代「已脱敏」", () => {
    render(<TasksTable tasks={[task({ errorSummary: "redacted", stopReason: "upstream_error" })]} />);
    expect(screen.getByText("upstream_error")).toBeTruthy();
    expect(screen.queryByText("系统异常，详情见审计/日志")).toBeNull();
  });

  it("stopReason 缺失时（undefined）显示安全的未知异常说明", () => {
    render(<TasksTable tasks={[task({ errorSummary: "redacted", stopReason: undefined })]} />);
    expect(screen.getByText("系统异常，详情见审计/日志")).toBeTruthy();
  });

  it("known failures show Chinese copy plus the stable code", () => {
    render(<TasksTable tasks={[task({
      failure: { code: "promo_link_missing", label: "缺少推广链接" },
    })]} />);
    expect(screen.getByText("缺少推广链接（promo_link_missing）")).toBeTruthy();
    expect(screen.queryByText("系统异常，详情见审计/日志")).toBeNull();
  });

  it("shows Article admission counts and localized blocker reasons", () => {
    render(<TasksTable tasks={[task({
      taskType: "article.generate.batch.v1",
      articleAdmission: {
        selectedCount: 200,
        submittedCount: 0,
        blockedCount: 200,
        blockedReasonCounts: { promo_link_missing: 200 },
      },
    })]} />);
    const admission = screen.getByTestId(`article-admission-${task().taskId}`);
    expect(admission.textContent).toContain("已选 200 条 · 已提交 0 条 · 准入阻断 200 条");
    expect(admission.textContent).toContain("缺少推广链接：200 条");
    expect(admission.textContent).not.toContain("promo_link_missing");
  });

  // Regression: the catalog-batch count strings used to be gated on
  // `taskType !== "article.generate.batch.v1"` — a negative check against ONE
  // version literal. The moment `article.generate.batch.v2` shipped, that
  // condition became true for v2 and the table started rendering catalog
  // semantics (「已纳入」/「状态不符合／未找到」) on an article-generate parent,
  // which has no such buckets. Both versions must be excluded, so this asserts
  // v2 explicitly; `isArticleGenerateBatchTaskType` is the version-agnostic
  // predicate that replaced the literal comparison.
  it.each([
    ["article.generate.batch.v1"],
    ["article.generate.batch.v2"],
  ])("%s 不渲染 catalog 批次的计数语义", (taskType) => {
    render(<TasksTable tasks={[task({
      taskType,
      catalogBatch: {
        phase: "materializing",
        submittedCount: 7,
        alreadyLinkedCount: 5,
        ineligibleCount: 3,
      },
    })]} />);
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("已纳入 5 条");
    expect(body).not.toContain("状态不符合／未找到 3 条");
    expect(body).not.toContain("· 7 条");
  });

  // C-9 (`施工工单_C9_任务详情独立路由对齐CPS_2026-09-07.md`): "查看详情" now
  // navigates to the independent `/tasks/<taskId>` route instead of the old
  // same-page panel's `/tasks?taskId=…&taskFamily=…`.
  it("查看详情链接指向 /tasks/<taskId>，并携带 family 作为解析提示", () => {
    render(<TasksTable tasks={[task()]} />);
    const link = screen.getByTestId(`view-task-detail-${task().taskId}`) as HTMLAnchorElement;
    const url = new URL(link.getAttribute("href")!, "https://admin.invalid");
    expect(url.pathname).toBe(`/tasks/${task().taskId}`);
    expect(url.searchParams.get("family")).toBe("channel_sync");
  });

  // C-9 §一: catalog_scan 的子项计数单位是「页」（1 项 = 1 页 × 20 条），其余
  // 任务族/taskType 不带单位，维持既有裸数字展示。
  it("catalog_scan 任务的计数列展示「页」单位，其余任务不受影响", () => {
    render(
      <TasksTable
        tasks={[
          task({ taskId: "22222222-2222-4222-8222-222222222222", taskType: "catalog_scan", totalCount: 2000, successCount: 1800 }),
        ]}
      />,
    );
    expect(screen.getByText("2000 页")).toBeTruthy();
    expect(screen.getByText("1800 页")).toBeTruthy();
  });

  it("非 catalog_scan 任务的计数列不带单位", () => {
    render(<TasksTable tasks={[task({ taskType: "chapter_sync", totalCount: 10 })]} />);
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.queryByText("10 页")).toBeNull();
  });

  // C-12 (`施工工单_C12_目录任务计量口径改为本_2026-09-07.md`): once bookCounts
  // is derivable, the 总数/成功/失败 columns switch from page units to book
  // ("本") units — 跳过 stays page-based (catalog_scan items are never
  // skipped either way, so the unit is moot there).
  it("bookCounts 存在时，目录任务的总数/成功/失败列改用「本」单位", () => {
    render(
      <TasksTable
        tasks={[
          task({
            taskId: "22222222-2222-4222-8222-222222222222",
            taskType: "catalog_scan",
            totalCount: 2000,
            successCount: 4,
            failedCount: 1997,
            bookCounts: {
              upstreamTotal: 89,
              fetched: 80,
              failedBooks: 20,
              pagesScanned: 5,
              pagesTotalExpected: 5,
              percent: 90,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("89 本")).toBeTruthy();
    expect(screen.getByText("80 本")).toBeTruthy();
    expect(screen.getByText("20 本")).toBeTruthy();
    expect(screen.queryByText("2000 页")).toBeNull();
    expect(screen.queryByText("4 页")).toBeNull();
    expect(screen.queryByText("1997 页")).toBeNull();
  });

  it("bookCounts 缺失时（尚未拿到首页），目录任务的计数列维持既有「页」单位展示", () => {
    render(
      <TasksTable
        tasks={[
          task({
            taskId: "22222222-2222-4222-8222-222222222222",
            taskType: "catalog_scan",
            totalCount: 2000,
            successCount: 0,
          }),
        ]}
      />,
    );
    expect(screen.getByText("2000 页")).toBeTruthy();
    expect(screen.queryByText(/本$/)).toBeNull();
  });

  it("目录父任务显示中文阶段和未提交原因，不显示后端 reason key", () => {
    render(<TasksTable tasks={[task({
      taskType: "batch.materialize.v1",
      catalogBatch: {
        phase: "materializing",
        submittedCount: null,
        ineligibleCount: null,
        blockedCount: 3,
        blockedReasonCounts: { channel_account_required: 2, active_item_conflict: 1 },
      },
    })]} />);
    const cell = screen.getByTestId(`catalog-batch-blocked-${task().taskId}`);
    expect(screen.getByTestId(`catalog-batch-phase-${task().taskId}`).textContent).toContain("正在统计");
    expect(cell.textContent).toContain("部分条目未提交（3 条）");
    expect(cell.textContent).toContain("缺少可用渠道账户：2 条");
    expect(cell.textContent).not.toContain("channel_account_required");
  });

  it("小说纳入父任务区分状态不符合和 locale 阻断，且不显示未知 reason key", () => {
    render(<TasksTable tasks={[task({
      taskType: "batch.materialize.v1",
      catalogBatch: {
        phase: "completed_with_errors",
        submittedCount: 1,
        ineligibleCount: 1,
        alreadyLinkedCount: 0,
        blockedCount: 5,
        blockedReasonCounts: { missing_locale: 2, unsupported_locale: 3, internal_reason: 9 },
      },
    })]} />);

    const phase = screen.getByTestId(`catalog-batch-phase-${task().taskId}`);
    const blocked = screen.getByTestId(`catalog-batch-blocked-${task().taskId}`);
    expect(phase.textContent).toContain("状态不符合／未找到 1 条");
    expect(blocked.textContent).toContain("来源语言缺失：2 条");
    expect(blocked.textContent).toContain("来源语言暂不受产品支持：3 条");
    expect(blocked.textContent).not.toContain("internal_reason");
  });
});
