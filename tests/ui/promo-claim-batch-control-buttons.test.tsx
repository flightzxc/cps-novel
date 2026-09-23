import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromoClaimBatchControlButtons } from "@/app/(admin)/tasks/_components/promo-claim-batch-control-buttons";

import { installDialogShim } from "./jsdom-dialog";

installDialogShim();

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const BATCH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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

/**
 * 阶段2 第4步（施工任务 3.1/3.3）：`PromoClaimBatchControlButtons` 的可点性
 * 全部按 `parentRawStatus`（批次自身未经派生的原始 status 列值）判定，
 * 不是页面上展示用的派生状态——这是修复"按钮显示可点，点了却 409"这条旧路径
 * 缺陷的直接原因，所以这里逐一覆盖四个按钮各自的可点性边界。
 */
describe("PromoClaimBatchControlButtons · 可点性", () => {
  it("parentRawStatus 非 paused/cancelled/disabled 时（含 completed）显示暂停，不显示恢复/中止之外的其它按钮", () => {
    render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="completed" />);
    expect(screen.getByTestId("promo-claim-batch-pause-open")).toBeTruthy();
    expect(screen.queryByTestId("promo-claim-batch-resume-open")).toBeNull();
    expect(screen.getByTestId("promo-claim-batch-abort-open")).toBeTruthy(); // completed 不是 cancelled，仍可中止。
    expect(screen.queryByTestId("promo-claim-batch-reapprove-open")).toBeNull();
  });

  it("parentRawStatus=paused 时只显示恢复与中止，不显示暂停", () => {
    render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="paused" />);
    expect(screen.queryByTestId("promo-claim-batch-pause-open")).toBeNull();
    expect(screen.getByTestId("promo-claim-batch-resume-open")).toBeTruthy();
    expect(screen.getByTestId("promo-claim-batch-abort-open")).toBeTruthy();
  });

  it("parentRawStatus=cancelled 时不显示任何按钮（终态，不可逆）", () => {
    const { container } = render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="cancelled" />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("parentRawStatus=disabled 且 holdReasonCode=approval_expired 时显示重新批准，不显示暂停/恢复", () => {
    render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="disabled" holdReasonCode="approval_expired" />);
    expect(screen.getByTestId("promo-claim-batch-reapprove-open")).toBeTruthy();
    expect(screen.queryByTestId("promo-claim-batch-pause-open")).toBeNull();
    expect(screen.queryByTestId("promo-claim-batch-resume-open")).toBeNull();
    expect(screen.getByTestId("promo-claim-batch-abort-open")).toBeTruthy(); // disabled 不是 cancelled，仍可中止。
  });

  it("parentRawStatus=disabled 但 holdReasonCode 是其它系统暂停原因（如 credential_not_ready）时不显示重新批准", () => {
    render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="disabled" holdReasonCode="credential_not_ready" />);
    expect(screen.queryByTestId("promo-claim-batch-reapprove-open")).toBeNull();
    expect(screen.getByTestId("promo-claim-batch-abort-open")).toBeTruthy();
  });
});

describe("PromoClaimBatchControlButtons · 提交", () => {
  async function openDialog(testId: string) {
    fireEvent.click(screen.getByTestId(testId));
    // 四个动作的 ConfirmDialog 全部渲染在 DOM 里，只有当前 `open` 的那一个
    // 会真正打开——`document.querySelector("dialog")` 永远只拿到 DOM 顺序里
    // 的第一个（暂停），必须用 `dialog[open]` 精确匹配"现在真正打开的那个"。
    await waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
  }

  it("暂停：命中批次级 pause 路由，请求体为 taskId（+ 可选 reason）", async () => {
    fetchMock.mockResolvedValue(okResponse({ batchId: BATCH_ID, status: "paused", pausedShardCount: 1, wrote: true, auditId: "1" }));
    render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="processing" />);
    await openDialog("promo-claim-batch-pause-open");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认暂停" }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/admin/tasks/promo-claim-batch/pause");
    const request = init as RequestInit;
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({ taskId: BATCH_ID });
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("恢复：命中批次级 resume 路由，请求体只有 taskId（没有 reason 字段）", async () => {
    fetchMock.mockResolvedValue(okResponse({ batchId: BATCH_ID, status: "pending", releasedShardCount: 1, wrote: true, auditId: "2" }));
    render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="paused" />);
    await openDialog("promo-claim-batch-resume-open");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/admin/tasks/promo-claim-batch/resume");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ taskId: BATCH_ID });
  });

  it("中止：命中批次级 abort 路由，填写的原因随请求体一起发送", async () => {
    fetchMock.mockResolvedValue(okResponse({ batchId: BATCH_ID, status: "cancelled", terminatedShardCount: 2, terminatedItemCount: 2, wrote: true, auditId: "3" }));
    render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="processing" />);
    await openDialog("promo-claim-batch-abort-open");
    fireEvent.change(screen.getByTestId("promo-claim-batch-abort-reason"), { target: { value: "运营中止" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认中止" }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/admin/tasks/promo-claim-batch/abort");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ taskId: BATCH_ID, reason: "运营中止" });
  });

  it("重新批准：命中批次级 reapprove 路由", async () => {
    fetchMock.mockResolvedValue(okResponse({
      batchId: BATCH_ID, status: "pending", approvedAt: "2026-09-23T09:00:00.000Z", approvalValidUntil: "2026-09-24T09:00:00.000Z", wrote: true, auditId: "4",
    }));
    render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="disabled" holdReasonCode="approval_expired" />);
    await openDialog("promo-claim-batch-reapprove-open");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认重新批准" }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/admin/tasks/promo-claim-batch/reapprove");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ taskId: BATCH_ID });
  });

  it("409 状态冲突时展示中文错误提示，且不刷新页面", async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ ok: false, status: 409, code: "task_admin_state_conflict" }));
    render(<PromoClaimBatchControlButtons taskId={BATCH_ID} parentRawStatus="processing" />);
    await openDialog("promo-claim-batch-pause-open");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认暂停" }));
    });
    // 四个动作的 ConfirmDialog 全部渲染在 DOM 里（只有一个真正 `open`），
    // `errorMessage` 是这几个对话框共用的一份状态，所以每个 body 里都会有
    // 一份这个 testid——必须把查询范围限定在真正打开的那一个对话框内，
    // 否则会因为"找到多个匹配元素"而报错。
    const openDialogEl = document.querySelector("dialog[open]")!;
    const error = await within(openDialogEl as HTMLElement).findByTestId("promo-claim-batch-control-dialog-error");
    expect(error.textContent).toBeTruthy();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
