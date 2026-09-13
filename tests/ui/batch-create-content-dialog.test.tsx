import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogShim } from "./jsdom-dialog";

const actions = vi.hoisted(() => ({
  readCatalogBatchContextAction: vi.fn(),
  applyContentCreationBatchAction: vi.fn(),
  readCatalogBatchSummaryAction: vi.fn(),
}));
vi.mock("@/app/(admin)/catalog-sync/_actions", () => actions);
const { BatchCreateContentDialog } = await import("@/app/(admin)/catalog-sync/_components/batch-create-content-dialog");
installDialogShim();
beforeEach(() => Object.values(actions).forEach((action) => action.mockReset()));
const selection = { scope: "all_filtered" as const, filter: { status: "pending" } };
const context = { submittedCount: 1001, channelGroups: [], locales: [{ locale: "en", eligibleCount: 3, templates: [{ key: "news", name: "News" }] }, { locale: "ru", eligibleCount: 2, templates: [] }] };
function renderDialog() { return render(<BatchCreateContentDialog selection={selection} contentPublishGranted contentPublishBlockedReason={null} onClose={vi.fn()} onSubmitted={vi.fn()} />); }

describe("BatchCreateContentDialog", () => {
  it("reads templates from the full selection and submits the locale map once", async () => {
    actions.readCatalogBatchContextAction.mockResolvedValue({ ok: true, data: context });
    actions.applyContentCreationBatchAction.mockResolvedValue({ ok: true, data: { taskId: "task-1", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "task-1", phase: "completed", submittedCount: 5, ineligibleCount: 1 } });
    renderDialog();
    await screen.findByText("en（3 条）");
    fireEvent.change(screen.getAllByDisplayValue("服务默认模板")[0]!, { target: { value: "news" } });
    fireEvent.click(screen.getByRole("button", { name: "创建内容" }));
    await waitFor(() => expect(actions.applyContentCreationBatchAction).toHaveBeenCalledWith(expect.objectContaining({ selection, templateKeysByLocale: { en: "news" } })));
    expect(await screen.findByText(/任务已提交：5 条/)).toBeTruthy();
  });

  it("network rejection leaves the dialog retryable with the same request id", async () => {
    actions.readCatalogBatchContextAction.mockResolvedValue({ ok: true, data: context });
    actions.applyContentCreationBatchAction.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, data: { taskId: "task-2", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockResolvedValue({ ok: true, data: { taskId: "task-2", phase: "completed", submittedCount: 1, ineligibleCount: 0 } });
    renderDialog(); await screen.findByText("en（3 条）");
    fireEvent.click(screen.getByRole("button", { name: "创建内容" }));
    await screen.findByRole("alert");
    expect(screen.getAllByDisplayValue("服务默认模板")[0]!.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "创建内容" }));
    await waitFor(() => expect(actions.applyContentCreationBatchAction).toHaveBeenCalledTimes(2));
    expect(actions.applyContentCreationBatchAction.mock.calls[0][0].requestId).toBe(actions.applyContentCreationBatchAction.mock.calls[1][0].requestId);
  });

  it("removes a locale key when switched back to the service default and keeps task link after summary failure", async () => {
    actions.readCatalogBatchContextAction.mockResolvedValue({ ok: true, data: context });
    actions.applyContentCreationBatchAction.mockResolvedValue({ ok: true, data: { taskId: "task-3", phase: "queued" } });
    actions.readCatalogBatchSummaryAction.mockRejectedValue(new Error("offline"));
    renderDialog(); await screen.findByText("en（3 条）");
    const select = screen.getAllByDisplayValue("服务默认模板")[0]!;
    fireEvent.change(select, { target: { value: "news" } });
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "创建内容" }));
    await waitFor(() => expect(actions.applyContentCreationBatchAction).toHaveBeenCalledWith(expect.objectContaining({ templateKeysByLocale: {} })));
    expect(await screen.findByRole("link", { name: "查看任务" })).toBeTruthy();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("does not submit without a loaded context or publish permission", async () => {
    actions.readCatalogBatchContextAction.mockResolvedValue({ ok: false, kind: "invalid_input", code: "items_required" });
    renderDialog();
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "创建内容" }).hasAttribute("disabled")).toBe(true);
    expect(actions.applyContentCreationBatchAction).not.toHaveBeenCalled();
  });
});
