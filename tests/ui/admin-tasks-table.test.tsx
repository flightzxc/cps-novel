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

  it("errorSummary 为 redacted 时展示脱敏说明，而不是原始字符串", () => {
    render(<TasksTable tasks={[task({ errorSummary: "redacted" })]} />);
    expect(screen.getByText("已脱敏，详情见审计/日志")).toBeTruthy();
    expect(screen.queryByText("redacted")).toBeNull();
  });

  it("errorSummary 为 null 时展示占位符而不是脱敏说明", () => {
    render(<TasksTable tasks={[task({ errorSummary: null })]} />);
    expect(screen.queryByText("已脱敏，详情见审计/日志")).toBeNull();
  });

  // C-10 (Phase E rework, 2026-09-07): a derived stop reason is a stable
  // enum code, not free text — it replaces "已脱敏" in this column when the
  // service could derive one for the task.
  it("stopReason 存在时展示该稳定码，替代「已脱敏」", () => {
    render(<TasksTable tasks={[task({ errorSummary: "redacted", stopReason: "upstream_error" })]} />);
    expect(screen.getByText("upstream_error")).toBeTruthy();
    expect(screen.queryByText("已脱敏，详情见审计/日志")).toBeNull();
  });

  it("stopReason 缺失时（undefined）维持既有的脱敏说明", () => {
    render(<TasksTable tasks={[task({ errorSummary: "redacted", stopReason: undefined })]} />);
    expect(screen.getByText("已脱敏，详情见审计/日志")).toBeTruthy();
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
});
