import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogShim } from "./jsdom-dialog";

const actions = vi.hoisted(() => ({ readCatalogBatchContextAction: vi.fn(), enqueuePromoLinkClaimAction: vi.fn(), readCatalogBatchSummaryAction: vi.fn() }));
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
