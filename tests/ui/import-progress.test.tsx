import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { ImportProgress } from "@/features/admin-ui/import-progress";

/**
 * C-6 (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md` §三):
 * component-level coverage for `ImportProgress` that the host-page test
 * (`tests/ui/catalog-scan-trigger-form.test.tsx`) does not exercise --
 * that file only asserts `onTerminal` fired once via `router.refresh()`,
 * never that polling itself actually stopped. A regression that keeps
 * calling `fetch` after a terminal status (e.g. a dropped `clearInterval`)
 * would pass the host-page test but silently hammer the API forever; the
 * "polling stops" cases below fail specifically on that regression shape.
 */

function progressPayload(overrides: Record<string, unknown> = {}) {
  return {
    taskType: "catalog_scan",
    status: "processing",
    total: 4,
    success: 1,
    failed: 0,
    skip: 0,
    processed: 1,
    percent: 25,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    taskErrors: [],
    items: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ImportProgress 轮询与终态 (C-6)", () => {
  it("每 2 秒轮询一次，命中终态后停止轮询（不再发起新的 fetch）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => progressPayload({ status: "processing" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ImportProgress taskId="task-poll-1" />);

    // Initial fetch is deferred via setTimeout(fn, 0), not a synchronous
    // call in the effect body (see the component's own comment on why).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Now flip to a terminal status and let the next tick observe it.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => progressPayload({ status: "completed", success: 4, processed: 4, percent: 100 }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const callsAtTerminal = fetchMock.mock.calls.length;
    expect(callsAtTerminal).toBe(4);

    // Advance well past several more would-be poll ticks: call count must
    // not grow. A dropped `clearInterval` on the terminal path is exactly
    // the regression shape this asserts against.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(callsAtTerminal);
  });

  it("命中终态时只触发一次 onTerminal，即使后续还有渲染", async () => {
    const onTerminal = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => progressPayload({ status: "completed", success: 4, processed: 4, percent: 100 }),
      }),
    );

    render(<ImportProgress taskId="task-terminal-1" onTerminal={onTerminal} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("completed_with_errors 桥接后的 partial_failed 渲染「部分失败」徽标", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => progressPayload({ status: "partial_failed", failed: 1 }),
      }),
    );

    render(<ImportProgress taskId="task-partial-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("部分失败")).toBeTruthy();
  });

  it("失败明细可展开，逐条渲染 errorMessage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          progressPayload({
            status: "partial_failed",
            failed: 1,
            items: [
              { id: "item-1", status: "failed", errorMessage: "第 3 页抓取失败", createdAt: new Date().toISOString() },
            ],
          }),
      }),
    );

    render(<ImportProgress taskId="task-partial-2" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const toggle = screen.getByText(/条失败记录/);
    await act(async () => {
      toggle.closest("button")?.click();
    });
    expect(screen.getByText("第 3 页抓取失败")).toBeTruthy();
  });
});
