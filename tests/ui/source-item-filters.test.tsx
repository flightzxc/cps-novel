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

describe("SourceItemFilters 上架时间与排序（2026-10-06）", () => {
  beforeEach(() => {
    push.mockReset();
    window.history.replaceState({}, "", "/catalog-sync?page=3&status=pending");
  });

  it("默认全部上架时间，预设为 近 7/30/90/180 天 与 近 1 年，不显示起始日期提示", () => {
    render(<SourceItemFilters values={{ status: "pending" }} />);
    const select = screen.getByLabelText("上架时间") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "7", "30", "90", "180", "365"]);
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "全部上架时间", "近 7 天", "近 30 天", "近 90 天", "近 180 天", "近 1 年",
    ]);
    expect(screen.queryByTestId("source-created-from-hint")).toBeNull();
  });

  it("选中预设后页面显示换算出的起始日期，便于运营核对", () => {
    render(<SourceItemFilters values={{ status: "pending", sourceCreatedWithin: "90", sourceCreatedFrom: "2026-07-08" }} />);
    expect((screen.getByLabelText("上架时间") as HTMLSelectElement).value).toBe("90");
    expect(screen.getByTestId("source-created-from-hint").textContent).toBe("2026-07-08 起");
  });

  it("提交时把预设（天数，不是日期）放进查询参数，与既有筛选一起保留、回到第一页", () => {
    render(<SourceItemFilters values={{ status: "pending", sourceLocale: "en" }} />);
    fireEvent.change(screen.getByLabelText("上架时间"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "source_created_desc" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(push).toHaveBeenCalledWith("/catalog-sync?search=&status=pending&sourceLocale=en&promoLinkStatus=&sourceCreatedWithin=30&sort=source_created_desc&pageSize=100");
  });

  it("两项都是默认（全部/默认排序）时不进 URL——未使用时地址与改动前逐字一致", () => {
    render(<SourceItemFilters values={{ status: "pending", sourceCreatedWithin: "30", sort: "source_created_desc" }} />);
    fireEvent.change(screen.getByLabelText("上架时间"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    const url = String(push.mock.calls[0]![0]);
    expect(url).not.toContain("sourceCreatedWithin");
    expect(url).not.toContain("sort=");
  });

  it("排序提供默认与上架时间（新→旧）两项", () => {
    render(<SourceItemFilters values={{ status: "pending" }} />);
    const select = screen.getByLabelText("排序") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "source_created_desc"]);
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["默认排序（最近可见）", "上架时间（新→旧）"]);
  });

  it("改变每页条数时保留 URL 里的上架时间与排序（刷新后保留）", () => {
    window.history.replaceState({}, "", "/catalog-sync?page=4&status=pending&sourceCreatedWithin=30&sort=source_created_desc");
    render(<SourceItemFilters values={{ status: "pending", sourceCreatedWithin: "30", sourceCreatedFrom: "2026-09-06", sort: "source_created_desc", pageSize: "100" }} />);
    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "200" } });
    expect(push).toHaveBeenCalledWith("/catalog-sync?status=pending&sourceCreatedWithin=30&sort=source_created_desc&pageSize=200");
  });

  it("URL / prop 改变时重新同步这两个字段", () => {
    const { rerender } = render(<SourceItemFilters values={{ status: "pending", sourceCreatedWithin: "7", sourceCreatedFrom: "2026-09-29" }} />);
    rerender(<SourceItemFilters values={{ status: "pending", sourceCreatedWithin: "365", sourceCreatedFrom: "2025-10-06", sort: "source_created_desc" }} />);
    expect((screen.getByLabelText("上架时间") as HTMLSelectElement).value).toBe("365");
    expect((screen.getByLabelText("排序") as HTMLSelectElement).value).toBe("source_created_desc");
    expect(screen.getByTestId("source-created-from-hint").textContent).toBe("2025-10-06 起");
  });
});
