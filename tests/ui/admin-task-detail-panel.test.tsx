import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  TaskDetailPanel,
  type TaskDetailRow,
  type TaskItemRow,
} from "@/app/(admin)/tasks/_components/task-detail-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function detail(overrides: Partial<TaskDetailRow> = {}): TaskDetailRow {
  return {
    family: "channel_sync",
    taskId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
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

function item(overrides: Partial<TaskItemRow> = {}): TaskItemRow {
  return {
    itemId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    status: "failed",
    attemptCount: 2,
    leaseEpoch: "3",
    lockedUntil: "2026-08-26T02:30:00.000Z",
    errorSummary: "redacted",
    ...overrides,
  };
}

describe("TaskDetailPanel · detail + items", () => {
  it("展示任务详情的四类计数与状态", () => {
    render(
      <TaskDetailPanel detail={detail()} items={[]} baseSearch={new URLSearchParams()} />,
    );
    expect(screen.getByTestId("task-detail-status").textContent).toBe("失败");
    expect(screen.getByTestId("retry-failed-open")).toBeTruthy();
  });

  it("失败/部分失败状态下渲染「重试失败项」，其余状态不渲染", () => {
    const { rerender } = render(
      <TaskDetailPanel detail={detail({ status: "failed" })} items={[]} baseSearch={new URLSearchParams()} />,
    );
    expect(screen.queryByTestId("retry-failed-open")).toBeTruthy();

    rerender(
      <TaskDetailPanel detail={detail({ status: "pending" })} items={[]} baseSearch={new URLSearchParams()} />,
    );
    expect(screen.queryByTestId("retry-failed-open")).toBeNull();
  });

  it("子项表格展示 item 级状态、attempt 次数与锁定时间", () => {
    render(
      <TaskDetailPanel detail={detail()} items={[item()]} baseSearch={new URLSearchParams()} />,
    );
    const row = screen.getByTestId(`task-item-row-${item().itemId}`);
    expect(row.textContent).toContain("失败");
    expect(row.textContent).toContain("2");
    // 2026-08-26T02:30:00Z → Asia/Shanghai 10:30，且不带时区后缀
    expect(row.textContent).toContain("10:30");
    expect(row.textContent).not.toMatch(/UTC|GMT/);
  });

  it("catalog_scan + itemStatus=skipped 组合时给出「已自动忽略该筛选」提示", () => {
    render(
      <TaskDetailPanel
        detail={detail({ family: "catalog_scan" })}
        items={[]}
        itemStatusValue="skipped"
        baseSearch={new URLSearchParams()}
      />,
    );
    expect(screen.getByText(/已自动忽略该筛选/)).toBeTruthy();
  });

  it("非 catalog_scan family 不展示 skipped 排除提示", () => {
    render(
      <TaskDetailPanel
        detail={detail({ family: "channel_sync" })}
        items={[]}
        itemStatusValue="skipped"
        baseSearch={new URLSearchParams()}
      />,
    );
    expect(screen.queryByText(/已自动忽略该筛选/)).toBeNull();
  });

  it("子项状态筛选下拉：catalog_scan 不含 skipped 选项", () => {
    render(
      <TaskDetailPanel detail={detail({ family: "catalog_scan" })} items={[]} baseSearch={new URLSearchParams()} />,
    );
    const select = screen.getByLabelText("子项状态") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).not.toContain("skipped");
  });

  it("errorSummary 为 redacted 时子项展示脱敏说明", () => {
    render(
      <TaskDetailPanel detail={detail()} items={[item({ errorSummary: "redacted" })]} baseSearch={new URLSearchParams()} />,
    );
    expect(screen.getByText("已脱敏，详情见审计/日志")).toBeTruthy();
  });

  it("子项为空时展示占位说明", () => {
    render(<TaskDetailPanel detail={detail()} items={[]} baseSearch={new URLSearchParams()} />);
    expect(screen.getByTestId("task-items-empty-state")).toBeTruthy();
  });
});
