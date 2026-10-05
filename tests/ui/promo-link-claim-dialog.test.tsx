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

  it("切换账户后，新预估落定前不显示上一次的旧结果（而是正在估算）", async () => {
    // 回归用例：effect 里原先同步 setEstimate(null) 重置预估——为了消掉
    // react-hooks/set-state-in-effect，这次改成在触发 allAccountsChosen
    // 变化的唯一位置（账户 <select> 的 onChange）里做同样的重置。这条用例
    // 专门证明"切换账户后，在新预估落定前，不会闪现上一个账户的旧数字"这条
    // 行为没有被改掉。
    const multi = { ...lifecycleSingle, channelGroups: [{ ...lifecycleSingle.channelGroups[0], accounts: [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }] }] };
    let resolveSecond!: (value: { ok: true; data: { totalShardCount: number; estimatedHours: number; windowMinutes: number; groups: never[] } }) => void;
    const secondPromise = new Promise<{ ok: true; data: { totalShardCount: number; estimatedHours: number; windowMinutes: number; groups: never[] } }>((resolve) => {
      resolveSecond = resolve;
    });
    actions.readPromoClaimShardEstimateAction
      .mockResolvedValueOnce({ ok: true, data: { totalShardCount: 2, estimatedHours: 3, windowMinutes: 90, groups: [] } })
      .mockImplementationOnce(() => secondPromise);

    renderDialog(multi);
    await screen.findByText("Channel（1 条）");
    fireEvent.change(screen.getByDisplayValue("选择账户"), { target: { value: "a1" } });
    await waitFor(() => expect(screen.getByTestId("promo-claim-shard-estimate").textContent).toContain("预计分 2 片"));

    fireEvent.change(screen.getByDisplayValue("One"), { target: { value: "a2" } });
    // 新请求还没落定——不能显示上一个账户（a1）的旧结果。
    expect(screen.getByTestId("promo-claim-shard-estimate").textContent).toContain("正在估算");
    expect(screen.getByTestId("promo-claim-shard-estimate").textContent).not.toContain("预计分 2 片");

    resolveSecond({ ok: true, data: { totalShardCount: 5, estimatedHours: 7, windowMinutes: 90, groups: [] } });
    await waitFor(() => expect(screen.getByTestId("promo-claim-shard-estimate").textContent).toContain("预计分 5 片"));
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

/**
 * 2026-10-06 追加（第五件）：提交后统计完成的弹窗要把"已有推广码 / 待人工核对 /
 * 其它未提交"补齐，否则运营会看到「已选 ≠ 已提交 + 不符合」。老批次（结果里没有
 * 三个生命周期计数键，读接口返回 `null`）的展示逐字不变。
 */
describe("PromoLinkClaimDialog · 统计完成后的计数展示（已有推广码 / 待人工核对 / 提示数）", () => {
  const base = { taskId: "p6", phase: "completed", alreadyLinkedCount: 0 };

  async function submitAndReadStatus(data: Record<string, unknown>): Promise<HTMLElement> {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue({ ok: true, data: { taskId: "p6", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { ...base, ...data } });
    renderDialog();
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(1));
    const status = await screen.findByRole("status");
    // 先出现的是"任务已提交，正在统计…"占位文案，等统计结果落定。
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("不符合领取条件"));
    return status;
  }

  it("有新计数：展示已选、已提交、已有推广码、待人工核对、不符合领取条件、其它未提交，提示数单独一行", async () => {
    const status = await submitAndReadStatus({
      selectedCount: 20, submittedCount: 10, ineligibleCount: 2,
      alreadyHasPromoCodeCount: 4, manualReviewPendingCount: 3, inOtherUnfinishedBatchNoticeCount: 5, blockedCount: 1,
    });
    // 恒等式：20 = 10 + 2 + 4 + 3 + 1；提示数 5 不参与加总（已计在"已提交"里）。
    expect(Array.from(status.querySelectorAll("span.block")).map((el) => el.textContent)).toEqual([
      "已选 20 本",
      "任务已提交：10 本",
      "已有推广码：4 本",
      "待人工核对：3 本",
      "不符合领取条件：2 本",
      "其它未提交：1 本",
      "其中 5 本同时在其它未完成的批次里，跑到时会自动跳过",
    ]);
    expect(screen.getByTestId("promo-claim-summary-overlap-notice").textContent)
      .toBe("其中 5 本同时在其它未完成的批次里，跑到时会自动跳过");
  });

  it("新类别为 0 时不显示，提示数为 0 时不显示提示行", async () => {
    const status = await submitAndReadStatus({
      selectedCount: 7, submittedCount: 6, ineligibleCount: 1,
      alreadyHasPromoCodeCount: 0, manualReviewPendingCount: 0, inOtherUnfinishedBatchNoticeCount: 0, blockedCount: 0,
    });
    expect(Array.from(status.querySelectorAll("span.block")).map((el) => el.textContent)).toEqual([
      "已选 7 本",
      "任务已提交：6 本",
      "不符合领取条件：1 本",
    ]);
    expect(screen.queryByTestId("promo-claim-summary-overlap-notice")).toBeNull();
    expect(status.textContent).not.toContain("已有推广码");
    expect(status.textContent).not.toContain("待人工核对");
    expect(status.textContent).not.toContain("其它未提交");
  });

  it("老批次无新键（读接口返回 null）：只显示已提交与不符合领取条件两行，与改前一致", async () => {
    const status = await submitAndReadStatus({
      // 老批次的结果里往往已经有 selectedCount，但三个生命周期计数键是缺失的——
      // 此时不能因为 selectedCount 有值就换成新版展示。
      selectedCount: 5, submittedCount: 4, ineligibleCount: 1,
      alreadyHasPromoCodeCount: null, manualReviewPendingCount: null, inOtherUnfinishedBatchNoticeCount: null, blockedCount: 0,
    });
    expect(Array.from(status.querySelectorAll("span.block")).map((el) => el.textContent)).toEqual([
      "任务已提交：4 条",
      "不符合领取条件：1 条",
    ]);
    expect(screen.queryByTestId("promo-claim-summary-overlap-notice")).toBeNull();
    expect(status.textContent).not.toContain("已选");
  });
});
