import "./setup-cleanup";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/features/admin-ui/import-progress", () => ({
  ImportProgress: ({ onTerminal }: { onTerminal: () => void }) => (
    <button type="button" data-testid="import-progress-task-id" onClick={onTerminal}>progress</button>
  ),
}));

const { TaskDetailProgress } = await import("@/app/(admin)/tasks/[id]/_components/task-detail-progress");

afterEach(() => {
  vi.useRealTimers();
  refresh.mockReset();
});

describe("TaskDetailProgress · 批量父任务物化刷新", () => {
  it("queued/materializing 每 3 秒刷新，卸载后清理计时器", () => {
    vi.useFakeTimers();
    const view = render(<TaskDetailProgress taskId="parent" materializing />);
    vi.advanceTimersByTime(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.advanceTimersByTime(6000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("普通任务不额外建立物化刷新，终态回调仍刷新一次", () => {
    vi.useFakeTimers();
    render(<TaskDetailProgress taskId="child" />);
    vi.advanceTimersByTime(6000);
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("import-progress-task-id"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
