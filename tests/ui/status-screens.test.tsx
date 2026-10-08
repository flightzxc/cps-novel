import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { MOCK_NOVEL_CARDS } from "@/features/public-ui/fixtures/mock-content";

describe("下架状态", () => {
  it("平静陈述当前不可阅读，并给一条回首页的路", () => {
    render(<UnavailableScreen locale="en" reason="unpublished" homeHref="/" />);

    expect(screen.getByRole("heading", { name: "This book is temporarily unavailable" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to home" }).getAttribute("href")).toBe("/");
  });

  it("标出状态原因，供路由层将来映射 HTTP 状态码", () => {
    render(<UnavailableScreen locale="en" reason="unpublished" />);
    expect(
      screen.getByTestId("unavailable-screen").getAttribute("data-unavailable-reason"),
    ).toBe("unpublished");
  });
});

describe("撤回状态", () => {
  it("文案与下架不同", () => {
    render(<UnavailableScreen locale="en" reason="takedown" />);

    expect(screen.getByRole("heading", { name: "This book has been withdrawn" })).toBeTruthy();
    // C（Owner 2026-09-29 拍板"按运营原文做"）: `unavailable.takedownBody`
    // 去掉了 "this site"，从 "...this site no longer offers this book." 改成
    // "...this book is no longer offered here."——断言跟随新文案，"永久"这层
    // 措辞此前就已经不在（Owner 拍板 2026-09-10），这条检查不变。
    expect(screen.getByText(/no longer offered here/)).toBeTruthy();
    expect(screen.queryByText(/permanent/i)).toBeNull();
  });

  it("标出状态原因", () => {
    render(<UnavailableScreen locale="en" reason="takedown" />);
    expect(
      screen.getByTestId("unavailable-screen").getAttribute("data-unavailable-reason"),
    ).toBe("takedown");
  });
});

describe("两种状态的共同纪律", () => {
  it.each(["unpublished", "takedown"] as const)("%s 不制造错误感", (reason) => {
    const { container } = render(<UnavailableScreen locale="en" reason={reason} />);
    const text = container.textContent ?? "";

    for (const forbidden of ["出错", "错误", "失败", "异常", "404", "410", "Error"]) {
      expect(text, `状态页出现了错误感措辞：${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(["unpublished", "takedown"] as const)("%s 不使用危险色作为主视觉", (reason) => {
    const { container } = render(<UnavailableScreen locale="en" reason={reason} />);
    expect(container.innerHTML).not.toContain("novel-danger");
  });

  it("可选的书名在未提供时不渲染", () => {
    const { container } = render(<UnavailableScreen locale="en" reason="takedown" />);
    expect(container.textContent).not.toContain("《》");
  });
});

describe("聚合页", () => {
  it("语言与题材共用同一个屏幕和同一种卡片", () => {
    const { container } = render(
      <CollectionScreen locale="en" title="言情" novels={MOCK_NOVEL_CARDS.slice(0, 4)} totalCount={MOCK_NOVEL_CARDS.length} />,
    );

    expect(screen.getByRole("heading", { name: "言情", level: 1 })).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="book-card"]')).toHaveLength(4);
    // 标题下的作品数是调用方传入的总本数（分页覆盖的总数），不是当前页渲染的 4 张卡片。
    expect(screen.getByText(`${MOCK_NOVEL_CARDS.length} works`)).toBeTruthy();
  });

  it("空集合有明确的空状态", () => {
    render(
      <CollectionScreen
        locale="en"
        title="悬疑"
        novels={[]}
        totalCount={0}
        emptyMessage="这个题材下暂时没有可以阅读的作品。"
      />,
    );

    expect(screen.getByTestId("book-grid-empty")).toBeTruthy();
    expect(screen.getByText("0 works")).toBeTruthy();
  });

  it("说明文字未提供时不渲染空段落", () => {
    const { container } = render(<CollectionScreen locale="en" title="言情" novels={[]} totalCount={0} />);
    // 页面壳自己有一个 <header>，这里要的是 main 里面那个集合头部
    const header = container.querySelector("main header") as HTMLElement;
    // 只剩「N 部作品」这一行，没有空的说明段落
    expect(header.querySelectorAll("p")).toHaveLength(1);
    expect(header.textContent).toContain("0 works");
  });
});