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

describe("TasksTable · 三类任务统一列表", () => {
  it("空态给出可操作指引，而不是一句「没有数据」", () => {
    render(<TasksTable tasks={[]} baseSearch={new URLSearchParams()} />);
    expect(screen.getByTestId("tasks-empty-state").textContent).toMatch(/family|状态/);
  });

  it("渲染 family / task_type / 状态 / 三类计数 / 失败原因列", () => {
    render(<TasksTable tasks={[task()]} baseSearch={new URLSearchParams()} />);
    expect(screen.getByText("渠道同步")).toBeTruthy();
    expect(screen.getByText("chapter_sync")).toBeTruthy();
    expect(screen.getByTestId(`task-status-${task().taskId}`).textContent).toBe("失败");
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("errorSummary 为 redacted 时展示脱敏说明，而不是原始字符串", () => {
    render(<TasksTable tasks={[task({ errorSummary: "redacted" })]} baseSearch={new URLSearchParams()} />);
    expect(screen.getByText("已脱敏，详情见审计/日志")).toBeTruthy();
    expect(screen.queryByText("redacted")).toBeNull();
  });

  it("errorSummary 为 null 时展示占位符而不是脱敏说明", () => {
    render(<TasksTable tasks={[task({ errorSummary: null })]} baseSearch={new URLSearchParams()} />);
    expect(screen.queryByText("已脱敏，详情见审计/日志")).toBeNull();
  });

  // C-10 (Phase E rework, 2026-09-07): a derived stop reason is a stable
  // enum code, not free text — it replaces "已脱敏" in this column when the
  // service could derive one for the task.
  it("stopReason 存在时展示该稳定码，替代「已脱敏」", () => {
    render(
      <TasksTable
        tasks={[task({ errorSummary: "redacted", stopReason: "upstream_error" })]}
        baseSearch={new URLSearchParams()}
      />,
    );
    expect(screen.getByText("upstream_error")).toBeTruthy();
    expect(screen.queryByText("已脱敏，详情见审计/日志")).toBeNull();
  });

  it("stopReason 缺失时（undefined）维持既有的脱敏说明", () => {
    render(
      <TasksTable
        tasks={[task({ errorSummary: "redacted", stopReason: undefined })]}
        baseSearch={new URLSearchParams()}
      />,
    );
    expect(screen.getByText("已脱敏，详情见审计/日志")).toBeTruthy();
  });

  it("查看详情链接携带 taskId 与 taskFamily，并保留已有的列表筛选参数", () => {
    const baseSearch = new URLSearchParams({ family: "channel_sync", status: "failed", limit: "50" });
    render(<TasksTable tasks={[task()]} baseSearch={baseSearch} />);
    const link = screen.getByTestId(`view-task-detail-${task().taskId}`) as HTMLAnchorElement;
    const url = new URL(link.getAttribute("href")!, "https://admin.invalid");
    expect(url.searchParams.get("taskId")).toBe(task().taskId);
    expect(url.searchParams.get("taskFamily")).toBe("channel_sync");
    expect(url.searchParams.get("family")).toBe("channel_sync");
    expect(url.searchParams.get("status")).toBe("failed");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("查看详情链接会清掉上一次选中的子项筛选，避免带着旧的 itemStatus/itemLimit 跳到新任务", () => {
    const baseSearch = new URLSearchParams({ taskId: "old-id", taskFamily: "generic", itemStatus: "failed", itemLimit: "20" });
    render(<TasksTable tasks={[task()]} baseSearch={baseSearch} />);
    const link = screen.getByTestId(`view-task-detail-${task().taskId}`) as HTMLAnchorElement;
    const url = new URL(link.getAttribute("href")!, "https://admin.invalid");
    expect(url.searchParams.get("itemStatus")).toBeNull();
    expect(url.searchParams.get("itemLimit")).toBeNull();
    expect(url.searchParams.get("taskId")).toBe(task().taskId);
  });
});
