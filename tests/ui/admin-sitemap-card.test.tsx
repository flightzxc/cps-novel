import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SitemapCard } from "@/app/(admin)/settings/_components/sitemap-card";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
vi.mock("@/features/admin-ui/admin-fetch", () => ({ adminFetch: vi.fn() }));
const snapshot = { enabled: true, task: { id: "t", status: "pending", createdAt: "2026-01-01", completedAt: null }, lastGeneration: { status: "failed", finishedAt: null }, published: { generatedAt: "2026-01-01", urlCount: 42 } };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(adminFetch).mockResolvedValue({ ok: true, data: snapshot }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("shows queue state, last failure, count and sends an audited refresh reason", async () => {
  render(<SitemapCard settingsManage="granted" />);
  await screen.findByText(/已入队，等待执行/);
  expect(screen.getByText(/最近生成结果：失败/)).toBeTruthy();
  expect(screen.getByText(/当前收录数：42/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Sitemap 刷新原因"), { target: { value: "refresh test" } });
  vi.mocked(adminFetch).mockResolvedValueOnce({ ok: true, data: { status: "coalesced", taskId: "t" } });
  fireEvent.click(screen.getByRole("button", { name: "刷新 Sitemap" }));
  await screen.findByText(/已合并至现有任务/);
  await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(3));
  expect(adminFetch).toHaveBeenCalledWith("/api/admin/sitemap", { method: "POST", body: { reason: "refresh test" } });
});
it("does not fetch or offer a mutation without capability", () => {
  render(<SitemapCard settingsManage="denied" />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(adminFetch).not.toHaveBeenCalled();
});
it("shows processing and disables refresh when gates are closed", async () => {
  vi.mocked(adminFetch).mockResolvedValue({ ok: true, data: { ...snapshot, enabled: false, task: { ...snapshot.task, status: "processing" } } });
  render(<SitemapCard settingsManage="granted" />);
  await screen.findByText(/任务状态：处理中/);
  await waitFor(() => expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true));
});
