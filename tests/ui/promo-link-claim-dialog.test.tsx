import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogShim } from "./jsdom-dialog";

const actions = vi.hoisted(() => ({
  readCatalogBatchContextAction: vi.fn(),
  enqueuePromoLinkClaimAction: vi.fn(),
  readCatalogBatchSummaryAction: vi.fn(),
  readPromoClaimShardEstimateAction: vi.fn(),
}));
vi.mock("@/app/(admin)/catalog-sync/_actions", () => actions);
const { PromoLinkClaimDialog } = await import("@/app/(admin)/catalog-sync/_components/promo-link-claim-dialog");
installDialogShim();
beforeEach(() => Object.values(actions).forEach((action) => action.mockReset()));
const selection = { scope: "explicit_ids" as const, ids: ["a"] };
const single = { submittedCount: 1, locales: [], channelGroups: [{ channelAppId: "app", channelCode: "c", channelName: "Channel", eligibleCount: 1, accounts: [{ id: "acct", name: "Main" }] }] };
function renderDialog(context = single, granted = true) { actions.readCatalogBatchContextAction.mockResolvedValue({ ok: true, data: context }); return render(<PromoLinkClaimDialog selection={selection} promoClaimGranted={granted} promoClaimBlockedReason={granted ? null : "没有权限"} onClose={vi.fn()} onSubmitted={vi.fn()} />); }

describe("PromoLinkClaimDialog", () => {
  it("single account submits once automatically and keeps the task link", async () => {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue({ ok: true, data: { taskId: "p1", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "p1", phase: "completed", submittedCount: 1, ineligibleCount: 0 } });
    renderDialog(); await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("link", { name: "查看任务" })).toBeTruthy();
  });
  it("network retry retains request id and frozen accounts", async () => {
    actions.enqueuePromoLinkClaimAction.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, data: { taskId: "p2", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "p2", phase: "completed", submittedCount: 1, ineligibleCount: 0 } });
    renderDialog(); await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(2));
    expect(actions.enqueuePromoLinkClaimAction.mock.calls[0][0].requestId).toBe(actions.enqueuePromoLinkClaimAction.mock.calls[1][0].requestId);
  });
  it("requires multi-account configuration and does not submit inactive capability", async () => {
    const multi = { ...single, channelGroups: [{ ...single.channelGroups[0], accounts: [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }] }] };
    renderDialog(multi); await screen.findByText("Channel（1 条）"); expect(actions.enqueuePromoLinkClaimAction).not.toHaveBeenCalled();
    const select = screen.getByDisplayValue("选择账户");
    expect(select.className).toContain("bg-white");
    expect(select.className).toContain("text-gray-900");
    expect(select.className).toContain("disabled:bg-gray-100");
    fireEvent.change(select, { target: { value: "a2" } }); fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalled());
  });
  it("locks multi-account selection after a network failure and retries the frozen account", async () => {
    const multi = { ...single, channelGroups: [{ ...single.channelGroups[0], accounts: [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }] }] };
    actions.enqueuePromoLinkClaimAction.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, data: { taskId: "p3", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "p3", phase: "completed", submittedCount: 1, ineligibleCount: 0 } });
    renderDialog(multi); await screen.findByText("Channel（1 条）");
    const select = screen.getByDisplayValue("选择账户"); fireEvent.change(select, { target: { value: "a2" } }); fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    await screen.findByRole("alert"); expect(select.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(2));
    expect(actions.enqueuePromoLinkClaimAction.mock.calls[1][0].channelAccounts).toEqual({ app: "a2" });
    expect(actions.enqueuePromoLinkClaimAction.mock.calls[0][0].requestId).toBe(actions.enqueuePromoLinkClaimAction.mock.calls[1][0].requestId);
  });
  it("does not submit when permission is denied", async () => {
    renderDialog(single, false); await screen.findByText("没有权限"); expect(actions.enqueuePromoLinkClaimAction).not.toHaveBeenCalled();
  });
});

/**
 * 阶段2 第4步（施工任务 3.6，设计 §5.9）：开关开启（`context.lifecycleEnabled
 * === true`）时，即使是单账户这种"原本会自动提交"的形状，也不再自动提交，
 * 而是先显示"预计分 N 片、预计耗时 X 小时"，等运营手动点击确认。开关关闭
 * （上面几条既有用例，`lifecycleEnabled` 字段缺失）时的自动提交行为逐字
 * 不变——这正是本组新增用例要证明的另一半。
 */
describe("PromoLinkClaimDialog · 阶段2 第4步：生命周期开关开启时的提交前预估", () => {
  const lifecycleSingle = { ...single, lifecycleEnabled: true };

  it("单账户场景下不再自动提交，显示预计分片数与预计耗时，点击后才真正提交", async () => {
    actions.readPromoClaimShardEstimateAction.mockResolvedValue({
      ok: true, data: { totalShardCount: 3, estimatedHours: 4.5, windowMinutes: 90, groups: [] },
    });
    actions.enqueuePromoLinkClaimAction.mockResolvedValue({ ok: true, data: { taskId: "p4", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "p4", phase: "completed", submittedCount: 1, ineligibleCount: 0 } });

    renderDialog(lifecycleSingle);
    // `promo-claim-shard-estimate` 这个 testid 从一开始（"正在估算…"）到
    // 预估请求结算（"预计分 N 片…"）中间会先渲染一次占位文案——用
    // `findByTestId` 只等元素出现，不等它落到最终文案，在满负载并行跑测时
    // 真实抓到过一次"断言跑在异步结算之前"的间歇性失败（不是产品缺陷，是
    // 断言本身的竞态）。改用 `waitFor` 明确等到最终文案出现。
    await waitFor(() => expect(screen.getByTestId("promo-claim-shard-estimate").textContent).toContain("预计分 3 片"));
    const estimateEl = screen.getByTestId("promo-claim-shard-estimate");
    expect(estimateEl.textContent).toContain("预计耗时 4.5 小时");
    // 没有自动提交——按钮还在，且从未调用过 enqueue。
    expect(actions.enqueuePromoLinkClaimAction).not.toHaveBeenCalled();
    const submitButton = screen.getByRole("button", { name: "领取推广链接" });
    expect(submitButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(submitButton);
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(1));
    expect(actions.enqueuePromoLinkClaimAction.mock.calls[0][0].channelAccounts).toEqual({ app: "acct" });
  });

  it("预估请求携带已选定的账户映射", async () => {
    actions.readPromoClaimShardEstimateAction.mockResolvedValue({
      ok: true, data: { totalShardCount: 1, estimatedHours: 1.5, windowMinutes: 90, groups: [] },
    });
    renderDialog(lifecycleSingle);
    await screen.findByTestId("promo-claim-shard-estimate");
    await waitFor(() => expect(actions.readPromoClaimShardEstimateAction).toHaveBeenCalled());
    expect(actions.readPromoClaimShardEstimateAction.mock.calls[0][0].channelAccounts).toEqual({ app: "acct" });
  });

  it("多账户尚未选定时显示提示文案，不请求预估；选定后才请求并展示结果", async () => {
    const multi = { ...lifecycleSingle, channelGroups: [{ ...lifecycleSingle.channelGroups[0], accounts: [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }] }] };
    actions.readPromoClaimShardEstimateAction.mockResolvedValue({
      ok: true, data: { totalShardCount: 2, estimatedHours: 3, windowMinutes: 90, groups: [] },
    });
    renderDialog(multi);
    const before = await screen.findByTestId("promo-claim-shard-estimate");
    expect(before.textContent).toContain("选好账户后即可估算");
    expect(actions.readPromoClaimShardEstimateAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByDisplayValue("选择账户"), { target: { value: "a2" } });
    await waitFor(() => expect(actions.readPromoClaimShardEstimateAction).toHaveBeenCalledTimes(1));
    // 同上一条用例：等最终文案落定，不是等元素第一次出现（先出现的是
    // "正在估算…" 占位文案）。
    await waitFor(() => expect(screen.getByTestId("promo-claim-shard-estimate").textContent).toContain("预计分 2 片"));
  });

  it("预估请求失败时不阻断提交——只是不显示具体数字", async () => {
    actions.readPromoClaimShardEstimateAction.mockRejectedValue(new Error("network"));
    actions.enqueuePromoLinkClaimAction.mockResolvedValue({ ok: true, data: { taskId: "p5", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "p5", phase: "completed", submittedCount: 1, ineligibleCount: 0 } });
    renderDialog(lifecycleSingle);
    const estimateEl = await screen.findByTestId("promo-claim-shard-estimate");
    expect(estimateEl.textContent).toContain("正在估算");
    fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(1));
  });
});
