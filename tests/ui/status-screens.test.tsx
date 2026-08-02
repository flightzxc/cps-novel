import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { MOCK_NOVEL_CARDS } from "@/features/public-ui/fixtures/mock-content";

describe("下架状态", () => {
  it("平静陈述当前不可阅读，并给一条回首页的路", () => {
    render(<UnavailableScreen reason="unpublished" homeHref="/" />);

    expect(screen.getByRole("heading", { name: "这本书暂时不可阅读" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "回到首页" }).getAttribute("href")).toBe("/");
  });

  it("标出状态原因，供路由层将来映射 HTTP 状态码", () => {
    render(<UnavailableScreen reason="unpublished" />);
    expect(
      screen.getByTestId("unavailable-screen").getAttribute("data-unavailable-reason"),
    ).toBe("unpublished");
  });
});

describe("撤回状态", () => {
  it("文案与下架不同", () => {
    render(<UnavailableScreen reason="takedown" />);

    expect(screen.getByRole("heading", { name: "这本书已经撤回" })).toBeTruthy();
    expect(screen.getByText(/永久性的撤回/)).toBeTruthy();
  });

  it("标出状态原因", () => {
    render(<UnavailableScreen reason="takedown" />);
    expect(
      screen.getByTestId("unavailable-screen").getAttribute("data-unavailable-reason"),
    ).toBe("takedown");
  });
});

describe("两种状态的共同纪律", () => {
  it.each(["unpublished", "takedown"] as const)("%s 不制造错误感", (reason) => {
    const { container } = render(<UnavailableScreen reason={reason} />);
    const text = container.textContent ?? "";

    for (const forbidden of ["出错", "错误", "失败", "异常", "404", "410", "Error"]) {
      expect(text, `状态页出现了错误感措辞：${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(["unpublished", "takedown"] as const)("%s 不使用危险色作为主视觉", (reason) => {
    const { container } = render(<UnavailableScreen reason={reason} />);
    expect(container.innerHTML).not.toContain("novel-danger");
  });

  it("可选的书名在未提供时不渲染", () => {
    const { container } = render(<UnavailableScreen reason="takedown" />);
    expect(container.textContent).not.toContain("《》");
  });
});

describe("聚合页", () => {
  it("语言与题材共用同一个屏幕和同一种卡片", () => {
    const { container } = render(
      <CollectionScreen title="言情" novels={MOCK_NOVEL_CARDS.slice(0, 4)} />,
    );

    expect(screen.getByRole("heading", { name: "言情", level: 1 })).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="book-card"]')).toHaveLength(4);
  });

  it("空集合有明确的空状态", () => {
    render(
      <CollectionScreen
        title="悬疑"
        novels={[]}
        emptyMessage="这个题材下暂时没有可以阅读的作品。"
      />,
    );

    expect(screen.getByTestId("book-grid-empty")).toBeTruthy();
    expect(screen.getByText("0 部作品")).toBeTruthy();
  });

  it("说明文字未提供时不渲染空段落", () => {
    const { container } = render(<CollectionScreen title="言情" novels={[]} />);
    // 页面壳自己有一个 <header>，这里要的是 main 里面那个集合头部
    const header = container.querySelector("main header") as HTMLElement;
    // 只剩「N 部作品」这一行，没有空的说明段落
    expect(header.querySelectorAll("p")).toHaveLength(1);
    expect(header.textContent).toContain("0 部作品");
  });
});