import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RetryFailedButton } from "@/app/(admin)/tasks/_components/retry-failed-button";

import { installDialogShim } from "./jsdom-dialog";

installDialogShim();

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const TASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  routerRefresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(payload: unknown) {
  return { json: async () => ({ ok: true, data: payload }) } as unknown as Response;
}

function envelopeResponse(envelope: unknown) {
  return { json: async () => envelope } as unknown as Response;
}

function dialog(): HTMLDialogElement | null {
  return document.querySelector("dialog");
}

async function openAndFillReason(text = "上游临时抖动已恢复") {
  fireEvent.click(screen.getByTestId("retry-failed-open"));
  await waitFor(() => expect(dialog()?.open).toBe(true));
  fireEvent.change(screen.getByTestId("retry-failed-reason-input"), { target: { value: text } });
}

describe("RetryFailedButton · 重试失败项", () => {
  it("原因为空时点击确认不发请求，就地展示校验提示", async () => {
    render(<RetryFailedButton family="channel_sync" taskId={TASK_ID} />);
    fireEvent.click(screen.getByTestId("retry-failed-open"));
    await waitFor(() => expect(dialog()?.open).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认重试" }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("retry-failed-reason-error")).toBeTruthy();
  });

  it("提交命中 retry-failed 路由，请求体带 family/taskId/reason（trim 后），并携带 x-request-id", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        family: "channel_sync",
        taskId: TASK_ID,
        status: "pending",
        retriedItemCount: 3,
        totalCount: 10,
        successCount: 7,
        failedCount: 3,
        skippedCount: 0,
        wrote: true,
        auditId: "1",
      }),
    );
    render(<RetryFailedButton family="channel_sync" taskId={TASK_ID} />);
    await openAndFillReason("  上游临时抖动已恢复  ");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认重试" }));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/admin/tasks/retry-failed");
    const request = init as RequestInit & { headers: Record<string, string> };
    expect(request.method).toBe("POST");
    expect(request.headers["x-request-id"]).toBeTruthy();
    expect(JSON.parse(String(request.body))).toEqual({
      family: "channel_sync",
      taskId: TASK_ID,
      reason: "上游临时抖动已恢复",
    });
  });

  it("成功后展示重试子项数并刷新页面", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        family: "generic",
        taskId: TASK_ID,
        status: "pending",
        retriedItemCount: 5,
        totalCount: 8,
        successCount: 3,
        failedCount: 5,
        skippedCount: 0,
        wrote: true,
        auditId: "2",
      }),
    );
    render(<RetryFailedButton family="generic" taskId={TASK_ID} />);
    await openAndFillReason();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认重试" }));
    });
    const result = await screen.findByTestId("retry-failed-result");
    expect(result.textContent).toContain("5");
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("409 族错误各自可区分：状态冲突 / 未裁决 intent / 并发写 / 范围冲突", async () => {
    const cases: Array<[string, string]> = [
      ["task_admin_state_conflict", "任务当前状态不支持该操作"],
      ["task_admin_unresolved_intent", "未裁决的人工审查项"],
      ["task_admin_concurrent_write", "已被其他操作同时修改"],
      ["task_admin_active_scope_conflict", "同一渠道/应用范围内已有进行中的任务"],
    ];
    const seenTexts = new Set<string>();
    render(<RetryFailedButton family="channel_sync" taskId={TASK_ID} />);
    for (const [code, expectedSubstring] of cases) {
      fetchMock.mockResolvedValueOnce(envelopeResponse({ ok: false, status: 409, code }));
      await openAndFillReason();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认重试" }));
      });
      const error = await screen.findByTestId("retry-failed-error");
      expect(error.textContent).toContain(expectedSubstring);
      seenTexts.add(error.textContent ?? "");
    }
    expect(seenTexts.size).toBe(cases.length);
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
