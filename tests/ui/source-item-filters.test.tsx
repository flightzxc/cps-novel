import "./setup-cleanup";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const { SourceItemFilters } = await import("@/app/(admin)/catalog-sync/_components/source-item-filters");

describe("SourceItemFilters 分页大小", () => {
  beforeEach(() => {
    push.mockReset();
    window.history.replaceState({}, "", "/catalog-sync?page=4&status=pending&search=moon&sourceLocale=ja");
  });

  it("默认每页 100 条，并提供 50 / 100 / 200 选项", () => {
    render(<SourceItemFilters values={{ status: "pending" }} />);
    const select = screen.getByLabelText("每页条数") as HTMLSelectElement;
    expect(select.value).toBe("100");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["50", "100", "200"]);
  });

  it("改变每页条数回到第一页，保留已应用筛选", () => {
    render(<SourceItemFilters values={{ status: "pending", search: "moon", sourceLocale: "ja", pageSize: "100" }} />);
    fireEvent.change(screen.getByLabelText("搜索标题"), { target: { value: "draft only" } });
    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "200" } });
    expect(push).toHaveBeenCalledWith("/catalog-sync?status=pending&search=moon&sourceLocale=ja&pageSize=200");
  });

  it("URL / prop 改变时重新同步表单字段", () => {
    const { rerender } = render(<SourceItemFilters values={{ status: "pending", search: "old", sourceLocale: "ja", pageSize: "50" }} />);
    rerender(<SourceItemFilters values={{ status: "linked", search: "new", sourceLocale: "en", pageSize: "200" }} />);
    expect((screen.getByLabelText("搜索标题") as HTMLInputElement).value).toBe("new");
    expect((screen.getByLabelText("来源条目状态") as HTMLSelectElement).value).toBe("linked");
    expect((screen.getByLabelText("来源语种") as HTMLSelectElement).value).toBe("en");
    expect((screen.getByLabelText("每页条数") as HTMLSelectElement).value).toBe("200");
  });
});

describe("SourceItemFilters 推广链接状态 (B-4)", () => {
  beforeEach(() => {
    push.mockReset();
    window.history.replaceState({}, "", "/catalog-sync?page=1&status=linked");
  });

  it("默认显示全部，并提供未领取/已领取/人工核对中三个选项", () => {
    render(<SourceItemFilters values={{ status: "linked" }} />);
    const select = screen.getByLabelText("推广链接状态") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "not_claimed", "claimed", "manual_review"]);
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["全部", "未领取", "已领取", "人工核对中"]);
  });

  it("提交时把选中的推广链接状态传入查询参数，并与既有筛选一起保留、回到第一页", () => {
    render(<SourceItemFilters values={{ status: "linked", sourceLocale: "en", promoLinkStatus: "claimed" }} />);
    fireEvent.change(screen.getByLabelText("推广链接状态"), { target: { value: "not_claimed" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(push).toHaveBeenCalledWith("/catalog-sync?search=&status=linked&sourceLocale=en&promoLinkStatus=not_claimed&pageSize=100");
  });

  it("URL / prop 改变时重新同步该字段", () => {
    const { rerender } = render(<SourceItemFilters values={{ status: "linked", promoLinkStatus: "claimed" }} />);
    rerender(<SourceItemFilters values={{ status: "linked", promoLinkStatus: "manual_review" }} />);
    expect((screen.getByLabelText("推广链接状态") as HTMLSelectElement).value).toBe("manual_review");
  });
});
