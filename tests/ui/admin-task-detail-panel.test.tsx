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

  // Phase C: catalog_scan folded into GenericTask (taskType = "catalog_scan");
  // TaskFamily no longer has a third value, so the pre-migration
  // "catalog_scan family + itemStatus=skipped" exclusion hint (and its two
  // sibling tests) is now an impossible combination and has been removed
  // from both task-detail-panel.tsx and this test file.

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

  // C-10 (Phase E rework, 2026-09-07): "停止原因" is derived from the one
  // item whose `stopReason` the projection populated (the origin failed
  // item), not from any free-text field.
  describe("停止原因（C-10）", () => {
    it("起源项带 stopReason 时，顶部展示「停止原因」行", () => {
      render(
        <TaskDetailPanel
          detail={detail()}
          items={[item({ stopReason: "upstream_error (HTTP 401) @ 第 1 页" })]}
          baseSearch={new URLSearchParams()}
        />,
      );
      const stopReasonRow = screen.getByTestId("task-detail-stop-reason");
      expect(stopReasonRow.textContent).toContain("停止原因");
      expect(stopReasonRow.textContent).toContain("upstream_error (HTTP 401) @ 第 1 页");
    });

    it("没有任何子项带 stopReason 时，不展示「停止原因」行", () => {
      render(
        <TaskDetailPanel detail={detail()} items={[item()]} baseSearch={new URLSearchParams()} />,
      );
      expect(screen.queryByTestId("task-detail-stop-reason")).toBeNull();
    });

    it("级联被标记的子项（无 stopReason）与起源项并存时，仍只显示起源项的停止原因", () => {
      render(
        <TaskDetailPanel
          detail={detail()}
          items={[
            item({ itemId: "cascaded-item", status: "failed" }), // no stopReason: cascaded stoppedBeforeFetch item
            item({ itemId: "origin-item", stopReason: "upstream_error (HTTP 401) @ 第 1 页" }),
          ]}
          baseSearch={new URLSearchParams()}
        />,
      );
      const stopReasonRow = screen.getByTestId("task-detail-stop-reason");
      expect(stopReasonRow.textContent).toContain("upstream_error (HTTP 401) @ 第 1 页");
      // Exactly one "停止原因" line, not one per item.
      expect(screen.getAllByTestId("task-detail-stop-reason")).toHaveLength(1);
    });
  });
});
