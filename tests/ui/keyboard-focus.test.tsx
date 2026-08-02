import "./setup-cleanup";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button, ButtonLink } from "@/components/Button";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_CHAPTER, MOCK_NOVEL_DETAIL } from "@/features/public-ui/fixtures/mock-content";

// 见 design-tokens.test.ts 的同一处注释：jsdom 的全局 URL 与 fileURLToPath 不兼容
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../src/styles/globals.css"), "utf8");

describe("焦点态", () => {
  it("焦点环由样式层统一提供，组件不各写各的", () => {
    expect(css).toMatch(/:where\(\.site, \.reader\) :focus-visible/);
    expect(css).toMatch(/outline:\s*2px solid var\(--novel-focus\)/);
    expect(css).toMatch(/outline-offset:\s*2px/);
  });

  it("阅读区内的焦点环改用当前阅读前景色，避免浅色纸面上不可见", () => {
    expect(css).toMatch(/\.reader \{[^}]*--novel-focus:\s*var\(--reader-fg\)/s);
  });

  it("没有任何地方把焦点轮廓关掉", () => {
    expect(css).not.toMatch(/outline:\s*(none|0)\b/);
  });
});

describe("键盘可达", () => {
  it("行动按钮是原生可聚焦元素", () => {
    render(
      <>
        <Button>按钮</Button>
        <ButtonLink href="/somewhere">链接按钮</ButtonLink>
      </>,
    );

    const button = screen.getByRole("button", { name: "按钮" });
    const link = screen.getByRole("link", { name: "链接按钮" });

    button.focus();
    expect(document.activeElement).toBe(button);
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it("按钮不用 tabindex 篡改自然 Tab 顺序", () => {
    const { container } = render(
      <NovelDetailScreen chrome={mockChrome()} novel={MOCK_NOVEL_DETAIL} />,
    );

    for (const node of container.querySelectorAll("a, button")) {
      const tabIndex = node.getAttribute("tabindex");
      expect(tabIndex === null || tabIndex === "0").toBe(true);
    }
  });

  it("详情页的每个交互元素都有可读名称", () => {
    const { container } = render(
      <NovelDetailScreen chrome={mockChrome()} novel={MOCK_NOVEL_DETAIL} />,
    );

    for (const node of container.querySelectorAll("a, button")) {
      const name =
        node.textContent?.trim() ||
        node.getAttribute("aria-label") ||
        node.querySelector("img")?.getAttribute("alt");
      expect(name, `存在没有可读名称的交互元素：${node.outerHTML.slice(0, 80)}`).toBeTruthy();
    }
  });

  it("阅读设置入口声明了展开状态与弹层类型", () => {
    render(<ChapterScreen chrome={mockChrome()} chapter={MOCK_CHAPTER} />);

    const toggle = screen.getByTestId("reader-settings-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-haspopup")).toBe("dialog");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("设置面板的档位控件是 radiogroup，可用方向键操作", () => {
    render(<ChapterScreen chrome={mockChrome()} chapter={MOCK_CHAPTER} />);
    fireEvent.click(screen.getByTestId("reader-settings-toggle"));

    const groups = screen.getAllByRole("radiogroup");
    expect(groups).toHaveLength(4);
    for (const group of groups) {
      expect(group.getAttribute("aria-labelledby")).toBeTruthy();
    }
  });

  it("装饰性图形对读屏隐藏", () => {
    const { container } = render(
      <NovelDetailScreen chrome={mockChrome()} novel={MOCK_NOVEL_DETAIL} />,
    );

    for (const svg of container.querySelectorAll("svg")) {
      const labelled =
        svg.getAttribute("aria-hidden") === "true" ||
        svg.closest('[aria-hidden="true"]') !== null;
      expect(labelled, "存在未对读屏隐藏的装饰性 svg").toBe(true);
    }
  });
});