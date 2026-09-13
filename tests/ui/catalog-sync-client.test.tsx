import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogShim } from "./jsdom-dialog";

const actions = vi.hoisted(() => ({
  readCatalogBatchContextAction: vi.fn(), enqueuePromoLinkClaimAction: vi.fn(), readCatalogBatchSummaryAction: vi.fn(),
  applyContentCreationBatchAction: vi.fn(), dryRunContentCreationAction: vi.fn(), applyContentCreationAction: vi.fn(),
}));
vi.mock("@/app/(admin)/catalog-sync/_actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { CatalogSyncClient } = await import("@/app/(admin)/catalog-sync/_components/catalog-sync-client");
installDialogShim();
beforeEach(() => Object.values(actions).forEach((action) => action.mockReset()));
const row = (id: string, title: string) => ({ id, title, description: "", coverUrl: null, totalChapterCount: 1, paidFromChapter: null, sourceLocale: "en", sourceLanguageCode: "en", sourceLanguageName: "English", status: "linked" as const, novelId: "n", lastSeenAt: null, channelAppId: "app", channelCode: "c", channelName: "Channel", sourceAppCode: "source", sourceAppName: "Source", promoClaimEligible: true, promoClaimIneligibleReason: null });
const rows = [row("a", "A"), row("b", "B")];
const singleContext = { submittedCount: 2, locales: [], channelGroups: [{ channelAppId: "app", channelCode: "c", channelName: "Channel", eligibleCount: 2, accounts: [{ id: "account", name: "Main" }] }] };
function renderPage(filter = { status: "pending" }) { return render(<CatalogSyncClient items={rows} total={1001} filter={filter} catalogGate={{ featureEnabled: true }} contentPublish="granted" promoClaimGranted promoClaimBlockedReason={null} />); }
async function selectPage() { fireEvent.click(screen.getByLabelText("选择当前页")); await screen.findByText(/已选择本页 2 条/); }

describe("CatalogSyncClient new batch selection", () => {
  it("keeps explicit ids across page props and resets only when a material filter changes", async () => {
    const view = renderPage(); fireEvent.click(screen.getByLabelText("勾选 A"));
    expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("1");
    view.rerender(<CatalogSyncClient items={[row("c", "C")]} total={1001} filter={{ status: "pending" }} catalogGate={{ featureEnabled: true }} contentPublish="granted" promoClaimGranted promoClaimBlockedReason={null} />);
    expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("1");
    view.rerender(<CatalogSyncClient key="linked" items={[row("c", "C")]} total={9} filter={{ status: "linked" }} catalogGate={{ featureEnabled: true }} contentPublish="granted" promoClaimGranted promoClaimBlockedReason={null} />);
    await waitFor(() => expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("0"));
  });

  it("upgrades a page selection to all_filtered without expanding ids and rows become read-only", async () => {
    renderPage(); await selectPage(); fireEvent.click(screen.getByRole("button", { name: /选择符合当前筛选条件的全部 1001 条/ }));
    expect(screen.getByTestId("all-filtered-selection").textContent).toContain("1001");
    expect(screen.getByLabelText("勾选 A").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("1001");
  });

  it("cancelling all-filtered selection clears the selection", async () => {
    renderPage();
    await selectPage();
    fireEvent.click(screen.getByRole("button", { name: /选择符合当前筛选条件的全部 1001 条/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消全选" }));
    expect(screen.queryByTestId("all-filtered-selection")).toBeNull();
    expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("0");
    expect((screen.getByLabelText("勾选 A") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("Promo link claim", () => {
  it("single account submits once directly from one toolbar click", async () => {
    actions.readCatalogBatchContextAction.mockResolvedValue({ ok: true, data: singleContext });
    actions.enqueuePromoLinkClaimAction.mockResolvedValue({ ok: true, data: { taskId: "p1", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "p1", phase: "completed", submittedCount: 2, ineligibleCount: 0 } });
    renderPage(); fireEvent.click(screen.getByLabelText("勾选 A")); fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(1));
    expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledWith(expect.objectContaining({ selection: { scope: "explicit_ids", ids: ["a"] }, channelAccounts: { app: "account" } }));
  });

  it("multiple accounts require one configuration before submit", async () => {
    actions.readCatalogBatchContextAction.mockResolvedValue({ ok: true, data: { ...singleContext, channelGroups: [{ ...singleContext.channelGroups[0], accounts: [{ id: "a1", name: "One" }, { id: "a2", name: "Two" }] }] } });
    actions.enqueuePromoLinkClaimAction.mockResolvedValue({ ok: true, data: { taskId: "p2", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "p2", phase: "completed", submittedCount: 2, ineligibleCount: 0 } });
    renderPage(); fireEvent.click(screen.getByLabelText("勾选 A")); fireEvent.click(screen.getByRole("button", { name: "领取推广链接" }));
    await screen.findByText("Channel（2 条）"); expect(actions.enqueuePromoLinkClaimAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByDisplayValue("选择账户"), { target: { value: "a2" } }); fireEvent.click(screen.getAllByRole("button", { name: "领取推广链接" }).at(-1)!);
    await waitFor(() => expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledWith(expect.objectContaining({ channelAccounts: { app: "a2" } })));
  });
});
