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
