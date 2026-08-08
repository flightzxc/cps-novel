import "./setup-cleanup";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { projectAdminContentPage, projectAdminNovelListItem } from "@/contracts";
import { ContentPagination } from "@/app/(admin)/novels/_components/content-pagination";
import {
  ContentCapabilityDenied,
  ContentTableSkeleton,
} from "@/app/(admin)/novels/_components/content-states";
import { NovelFilters } from "@/app/(admin)/novels/_components/novel-filters";
import { NovelsTable } from "@/app/(admin)/novels/_components/novels-table";

import { novelListItem, page, troubledNovelListItem } from "./fixtures/admin-content";

/**
 * 书目列表的渲染验收（P2-04）。
 *
 * 每个用例都把 kernel 形状的 fixture 过一遍真实 `projectAdminNovelListItem`，
 * 而不是手写 view fixture——投影一旦开始外泄 `author` / `splitRatio`，这里就会
 * 直接失败，而不是要等到 secret-boundary 那一个文件。
 */

const NOVELS = [novelListItem(), troubledNovelListItem()].map(projectAdminNovelListItem);

describe("P2-04 书目列表", () => {
  it("加载态给出骨架并对辅助技术宣告 busy", () => {
    render(<ContentTableSkeleton />);
    const skeleton = screen.getByTestId("content-table-skeleton");
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(within(skeleton).getByText("加载中")).toBeTruthy();
  });

  it("空结果给出明确文案，而不是一张空表", () => {
    render(<NovelsTable novels={[]} />);
    expect(screen.getByText("没有符合条件的书目")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("有数据时逐行展示后端真实字段", () => {
    render(<NovelsTable novels={NOVELS} />);

    // 标题 + 业务身份 + slug
    expect(screen.getByText("夜航船")).toBeTruthy();
    expect(screen.getByText("novel-biz-0001")).toBeTruthy();
    expect(screen.getByText("/ye-hang-chuan")).toBeTruthy();

    // 生命周期状态
    expect(screen.getByTestId("novel-status-published").textContent).toBe("已发布");
    expect(screen.getByTestId("novel-status-draft").textContent).toBe("草稿");

    // 章节标量：本地行数 / 上游声明
    expect(screen.getByTestId(`chapter-rows-${NOVELS[0].novelId}`).textContent).toBe("118");
    expect(screen.getByText("/ 120")).toBeTruthy();

    // 实际落地的试读数
    expect(screen.getByTestId(`materialized-${NOVELS[0].novelId}`).textContent).toBe("3");

    // 同步摘要与更新时间
    expect(screen.getAllByText(/来源 \d+/).length).toBe(2);
    expect(screen.getByText("无同步记录")).toBeTruthy();
  });

  it("异常列把每个 exception code 渲染成具名徽章，无异常时明说无异常", () => {
    render(<NovelsTable novels={NOVELS} />);
    expect(screen.getByTestId("exception-source_item_stale").textContent).toBe("上游条目过期");
    expect(screen.getByTestId("exception-sync_task_failed").textContent).toBe("同步任务失败");
    expect(screen.getByText("无异常")).toBeTruthy();
  });

  it("试读计数与策略不符时在列表里就点出来", () => {
    const mismatched = projectAdminNovelListItem(
      novelListItem({
        preview: {
          policy: {
            materializationPolicy: "upstream_returned_preview",
            materializedChapterCount: 5,
            displayAuthorized: true,
            indexAuthorized: true,
            cacheAuthorized: true,
            maxMaterializedChapters: 5,
            lastRefreshedAt: null,
            createdAt: "2026-08-08T00:00:00.000Z",
            updatedAt: "2026-08-08T00:00:00.000Z",
          },
          actualMaterializedChapterCount: 2,
          actualDisplayableChapterCount: 2,
          policyCountMatchesActual: false,
        },
      }),
    );
    render(<NovelsTable novels={[mismatched]} />);
    expect(screen.getByText("（策略 5）")).toBeTruthy();
  });

  /**
   * 断言落在**可交互元素**上，而不是扫描全文。
   *
   * 扫文本会把 `已发布` 这种状态标签、`同步` 这种列头当成写入口误报；真正要守的
   * 是"这一屏能触发什么"。于是：没有 button、没有 form、没有 input，链接全部是
   * 指向读页面的「查看」。
   */
  it("每行只提供查看入口，不提供任何写操作控件", () => {
    const { container } = render(<NovelsTable novels={NOVELS} />);

    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.querySelectorAll("form").length).toBe(0);
    // CPS 用勾选列驱动批量分类/批量重试/删除；本期无写操作，勾选列就是选给谁用
    expect(container.querySelectorAll("input").length).toBe(0);

    const links = Array.from(container.querySelectorAll("a"));
    expect(links.length).toBe(NOVELS.length);
    for (const link of links) {
      expect(link.textContent).toBe("查看");
      expect(link.getAttribute("href")).toMatch(/^\/novels\/[0-9a-f-]+$/);
    }
  });

  it("表格骨架沿用 CPS 的列表外观", () => {
    const { container } = render(<NovelsTable novels={NOVELS} />);
    // CPS dramas-list-client.tsx:199-227 的外壳与表头
    expect(container.querySelector(".rounded-xl.border.border-gray-200.bg-white")).toBeTruthy();
    expect(container.querySelector("thead.border-b.border-gray-200.bg-gray-50")).toBeTruthy();
    expect(container.querySelector("tbody.divide-y.divide-gray-100")).toBeTruthy();
    expect(container.querySelector("tr.hover\\:bg-gray-50")).toBeTruthy();
  });
});

describe("P2-04 书目筛选", () => {
  it("是一个纯 GET 表单，字段名即查询参数", () => {
    const { container } = render(<NovelFilters values={{}} />);
    const form = container.querySelector("form");
    expect(form).toBeTruthy();
    expect(form?.getAttribute("method")?.toUpperCase()).toBe("GET");
    expect(form?.querySelector('[name="search"]')).toBeTruthy();
    expect(form?.querySelector('[name="status"]')).toBeTruthy();
    expect(form?.querySelector('[name="locale"]')).toBeTruthy();
    // page 不是字段：换筛选条件必须回到第 1 页
    expect(form?.querySelector('[name="page"]')).toBeNull();
  });

  it("状态下拉只列出登记过的 novel 状态", () => {
    render(<NovelFilters values={{}} />);
    const select = screen.getByLabelText("生命周期状态") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(["", "draft", "ready", "published", "unpublished", "takedown"]);
  });

  it("回显当前筛选值", () => {
    render(<NovelFilters values={{ search: "夜航", status: "published", locale: "en" }} />);
    expect((screen.getByLabelText("搜索书名、业务 ID、slug") as HTMLInputElement).value).toBe(
      "夜航",
    );
    expect((screen.getByLabelText("生命周期状态") as HTMLSelectElement).value).toBe("published");
    expect((screen.getByLabelText("语种") as HTMLSelectElement).value).toBe("en");
  });
});

describe("P2-04 分页", () => {
  it("只有一页时整块不渲染", () => {
    const { container } = render(
      <ContentPagination basePath="/novels" params={{}} page={1} totalPages={1} total={3} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("翻页链接保留当前筛选条件且不携带旧 page", () => {
    render(
      <ContentPagination
        basePath="/novels"
        params={{ search: "夜 & 航", status: "published", page: "2" }}
        page={2}
        totalPages={5}
        total={97}
      />,
    );
    expect(screen.getByText("第 2 / 5 页，共 97 条")).toBeTruthy();

    const previous = screen.getByRole("link", { name: "上一页" }).getAttribute("href") ?? "";
    const next = screen.getByRole("link", { name: "下一页" }).getAttribute("href") ?? "";
    const nextParams = new URLSearchParams(next.split("?")[1]);

    expect(nextParams.get("page")).toBe("3");
    // CPS 手工拼接会把带 & 的搜索词拼坏；这里必须原样还原
    expect(nextParams.get("search")).toBe("夜 & 航");
    expect(nextParams.get("status")).toBe("published");
    expect(new URLSearchParams(previous.split("?")[1]).get("page")).toBe("1");
  });

  it("首页无上一页、末页无下一页", () => {
    const { rerender } = render(
      <ContentPagination basePath="/novels" params={{}} page={1} totalPages={3} total={50} />,
    );
    expect(screen.queryByRole("link", { name: "上一页" })).toBeNull();
    expect(screen.getByRole("link", { name: "下一页" })).toBeTruthy();

    rerender(
      <ContentPagination basePath="/novels" params={{}} page={3} totalPages={3} total={50} />,
    );
    expect(screen.getByRole("link", { name: "上一页" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "下一页" })).toBeNull();
  });
});

describe("P2-04 读能力被拒", () => {
  it("点名缺失的能力位，而不是笼统说无权限", () => {
    render(<ContentCapabilityDenied capability="content:view" />);
    const panel = screen.getByTestId("content-capability-denied");
    expect(panel.textContent).toContain("content:view");
    expect(panel.textContent).toContain("内容查看");
    expect(panel.textContent).not.toContain("无权限");
    // 读被拒不存在"补做 2FA 就能通过"这条路
    expect(panel.textContent).not.toContain("双重验证");
  });
});

describe("P2-04 投影页信封", () => {
  it("页码字段原样透传后端分页结果", () => {
    const projected = projectAdminContentPage(
      page([novelListItem()], { page: 3, pageSize: 20, total: 47, totalPages: 3 }),
      projectAdminNovelListItem,
    );
    expect(projected).toMatchObject({ page: 3, pageSize: 20, total: 47, totalPages: 3 });
    expect(projected.items.length).toBe(1);
  });
});
