import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualReviewResolveControls } from "@/app/(admin)/tasks/_components/manual-review-resolve-controls";

import { installDialogShim } from "./jsdom-dialog";

installDialogShim();

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const INTENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

function successResult(resolution: "effect_confirmed" | "no_effect_confirmed") {
  return {
    intentId: INTENT_ID,
    resolution,
    status: resolution === "effect_confirmed" ? "confirmed" : "failed",
    resolvedAt: "2026-08-26T02:00:00.000Z",
    automaticReconciliation: false as const,
    nextActions: ["upstream_readback", "authorized_rescan"] as const,
    wrote: true,
    auditId: "1",
  };
}

describe("ManualReviewResolveControls · 双结果裁决 UI", () => {
  it("两个按钮打开的确认框都带有共同的警示文案：断言外部真相 / 不可逆 / 不会自动触发对账", async () => {
    render(<ManualReviewResolveControls intentId={INTENT_ID} />);
    fireEvent.click(screen.getByTestId(`manual-review-confirm-effect-${INTENT_ID}`));
    await waitFor(() => expect(dialog()?.open).toBe(true));
    const warning = screen.getByTestId(`manual-review-warning-${INTENT_ID}`);
    expect(warning.textContent).toContain("人工断言");
    expect(warning.textContent).toContain("不可撤销");
    expect(warning.textContent).toContain("automaticReconciliation");
  });

  it("确认已发生 与 确认未发生 的分支警示文案不同，各自点名对应的误判后果", async () => {
    render(<ManualReviewResolveControls intentId={INTENT_ID} />);

    fireEvent.click(screen.getByTestId(`manual-review-confirm-effect-${INTENT_ID}`));
    await waitFor(() => expect(dialog()?.open).toBe(true));
    const effectDialogText = dialog()!.textContent ?? "";
    expect(effectDialogText).toContain("不会再尝试");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(dialog()?.open).toBe(false));

    fireEvent.click(screen.getByTestId(`manual-review-confirm-no-effect-${INTENT_ID}`));
    await waitFor(() => expect(dialog()?.open).toBe(true));
    const noEffectDialogText = dialog()!.textContent ?? "";
    expect(noEffectDialogText).toContain("重复副作用");

    expect(effectDialogText).not.toBe(noEffectDialogText);
  });

  it("原因为空时点击确认不发请求，就地展示校验提示", async () => {
    render(<ManualReviewResolveControls intentId={INTENT_ID} />);
    fireEvent.click(screen.getByTestId(`manual-review-confirm-effect-${INTENT_ID}`));
    await waitFor(() => expect(dialog()?.open).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交裁决：已发生" }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId(`manual-review-reason-error-${INTENT_ID}`)).toBeTruthy();
    expect(dialog()?.open).toBe(true);
  });

  it("提交时命中 resolve 路由，请求体带 intentId/resolution/reason，且携带 x-request-id", async () => {
    fetchMock.mockResolvedValue(okResponse(successResult("effect_confirmed")));
    render(<ManualReviewResolveControls intentId={INTENT_ID} />);
    fireEvent.click(screen.getByTestId(`manual-review-confirm-effect-${INTENT_ID}`));
    await waitFor(() => expect(dialog()?.open).toBe(true));
    fireEvent.change(screen.getByTestId(`manual-review-reason-input-${INTENT_ID}`), {
      target: { value: "  已登录渠道后台核实  " },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交裁决：已发生" }));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/admin/tasks/manual-reviews/resolve");
    const request = init as RequestInit & { headers: Record<string, string> };
    expect(request.method).toBe("POST");
    expect(request.headers["x-request-id"]).toBeTruthy();
    expect(JSON.parse(String(request.body))).toEqual({
      intentId: INTENT_ID,
      resolution: "effect_confirmed",
      reason: "已登录渠道后台核实",
    });
  });

  it("成功后展示 automaticReconciliation:false 与 nextActions 的后续步骤指引，并刷新页面", async () => {
    fetchMock.mockResolvedValue(okResponse(successResult("no_effect_confirmed")));
    render(<ManualReviewResolveControls intentId={INTENT_ID} />);
    fireEvent.click(screen.getByTestId(`manual-review-confirm-no-effect-${INTENT_ID}`));
    await waitFor(() => expect(dialog()?.open).toBe(true));
    fireEvent.change(screen.getByTestId(`manual-review-reason-input-${INTENT_ID}`), {
      target: { value: "核实后确认未发生" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交裁决：未发生" }));
    });

    const result = await screen.findByTestId(`manual-review-resolved-${INTENT_ID}`);
    expect(result.textContent).toContain("不会自动触发对账或重试");
    expect(result.textContent).toMatch(/去上游渠道后台核实/);
    expect(result.textContent).toMatch(/补偿扫描或重试/);
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("失败时按 C6a 的 8 码文案呈现，且不同 409 码文案彼此可区分", async () => {
    fetchMock.mockResolvedValueOnce(
      envelopeResponse({ ok: false, status: 409, code: "task_admin_state_conflict" }),
    );
    render(<ManualReviewResolveControls intentId={INTENT_ID} />);
    fireEvent.click(screen.getByTestId(`manual-review-confirm-effect-${INTENT_ID}`));
    await waitFor(() => expect(dialog()?.open).toBe(true));
    fireEvent.change(screen.getByTestId(`manual-review-reason-input-${INTENT_ID}`), {
      target: { value: "reason" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交裁决：已发生" }));
    });
    const stateConflict = await screen.findByTestId(`manual-review-error-${INTENT_ID}`);
    expect(stateConflict.textContent).toContain("任务当前状态不支持该操作");
    expect(dialog()?.open).toBe(true);
    expect(
      (screen.getByTestId(`manual-review-reason-input-${INTENT_ID}`) as HTMLInputElement).value,
    ).toBe("reason");

    fetchMock.mockResolvedValueOnce(
      envelopeResponse({ ok: false, status: 409, code: "task_admin_idempotency_conflict" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "提交裁决：已发生" }));
    });
    const idempotencyConflict = await screen.findByTestId(`manual-review-error-${INTENT_ID}`);
    expect(idempotencyConflict.textContent).toContain("已用于另一次不同的提交");
    expect(idempotencyConflict.textContent).not.toBe(stateConflict.textContent);
    expect(dialog()?.open).toBe(true);
    expect(
      (screen.getByTestId(`manual-review-reason-input-${INTENT_ID}`) as HTMLInputElement).value,
    ).toBe("reason");
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
