import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookCard } from "@/features/public-ui/book/BookCard";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import type { NovelCardView } from "@/features/public-ui/types";

const WITH_TAGS: NovelCardView = {
  id: "a",
  title: "The Lantern Keeper's Daughter",
  coverUrl: "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E",
  tags: [
    { slug: "romance", label: "言情" },
    { slug: "modern", label: "都市" },
  ],
  locale: { code: "en", label: "English" },
  href: "/novel/a",
};

const WITHOUT_TAGS: NovelCardView = {
  id: "b",
  title: "Nine Winters in the Glass House",
  tags: [],
  href: "/novel/b",
};

describe("书籍卡片", () => {
  it("渲染封面、书名与标签", () => {
    render(<BookCard novel={WITH_TAGS} />);

    expect(screen.getByRole("heading", { name: WITH_TAGS.title })).toBeTruthy();
    expect(screen.getByAltText(`《${WITH_TAGS.title}》封面`)).toBeTruthy();
    expect(screen.getByText("言情")).toBeTruthy();
    expect(screen.getByText("都市")).toBeTruthy();
  });

  it("标签为空时整个标签区块消失，不留空位", () => {
    const { container } = render(<BookCard novel={WITHOUT_TAGS} />);
    expect(container.querySelector('[data-testid="tag-list"]')).toBeNull();
  });

  it("缺封面时渲染占位块，卡片版面不塌", () => {
    const { container } = render(<BookCard novel={WITHOUT_TAGS} />);
    expect(container.querySelector("img")).toBeNull();
    // 占位块仍然按封面比例占位
    const slot = container.querySelector('[style*="--novel-cover-aspect"]');
    expect(slot).toBeTruthy();
  });

  it("封面比例只走 token，不出现字面比例", () => {
    const { container } = render(<BookCard novel={WITH_TAGS} />);
    const slot = container.querySelector('[style*="aspect-ratio"]') as HTMLElement;
    expect(slot.getAttribute("style")).toContain("var(--novel-cover-aspect)");
    expect(slot.getAttribute("style")).not.toMatch(/3\s*\/\s*4|2\s*\/\s*3/);
  });

  it("卡片上不出现分销接口不提供的字段", () => {
    const { container } = render(<BookCard novel={WITH_TAGS} />);
    const text = container.textContent ?? "";

    for (const forbidden of ["作者", "评分", "阅读量", "播放量", "完结", "连载", "国家"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text.toLowerCase()).not.toMatch(/author|rating|views/);
  });
});

describe("卡片网格", () => {
  it("首页与聚合页共用同一种卡片", () => {
    const { container } = render(<BookGrid novels={[WITH_TAGS, WITHOUT_TAGS]} />);
    expect(container.querySelectorAll('[data-testid="book-card"]')).toHaveLength(2);
  });

  it("密度刻意低于视频类竞品：移动 2 列 / 桌面 5 列", () => {
    const { container } = render(<BookGrid novels={[WITH_TAGS]} />);
    const grid = container.querySelector('[data-testid="book-grid"]') as HTMLElement;

    expect(grid.className).toContain("grid-cols-2");
    expect(grid.className).toContain("lg:grid-cols-5");
    expect(grid.className).not.toContain("grid-cols-6");
  });

  it("空集合渲染空状态而不是空网格", () => {
    render(<BookGrid novels={[]} emptyMessage="这个题材下暂时没有可以阅读的作品。" />);
    expect(screen.getByTestId("book-grid-empty").textContent).toBe(
      "这个题材下暂时没有可以阅读的作品。",
    );
  });
});