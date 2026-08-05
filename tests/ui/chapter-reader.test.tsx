import "./setup-cleanup";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import {
  DEFAULT_READER_SETTINGS,
  READER_FONT_SIZES,
  READER_LINE_HEIGHTS,
  READER_MEASURES,
  READER_SETTINGS_STORAGE_KEY,
  normalizeReaderSettings,
} from "@/features/public-ui/chapter/reader-settings";
import { MOCK_CHAPTER, MOCK_CHAPTER_LAST } from "@/features/public-ui/fixtures/mock-content";

function openPanel() {
  fireEvent.click(screen.getByTestId("reader-settings-toggle"));
}

describe("章节页 · 结构与字段边界", () => {
  it("轻量书籍归属条标出所属小说与当前试读范围", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);

    const bar = screen.getByTestId("book-attribution-bar");
    expect(bar.textContent).toContain(MOCK_CHAPTER.novel.title);
    expect(bar.textContent).toContain("试读 1 / 3");
  });

  it("试读范围的分母是可试读章数，不是总章数，也不出现全书进度百分比", () => {
    const { container } = render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    const text = container.textContent ?? "";

    expect(text).toContain("试读 1 / 3");
    expect(text).not.toContain("265");
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("渲染章号、章名与全部段落", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);

    expect(screen.getByText("第 1 章")).toBeTruthy();
    expect(screen.getByRole("heading", { name: MOCK_CHAPTER.title })).toBeTruthy();
    expect(screen.getByTestId("reader-body").querySelectorAll("p")).toHaveLength(
      MOCK_CHAPTER.paragraphs.length,
    );
  });

  it("不出现作者、字数、发布日期等分销接口不提供的字段", () => {
    const { container } = render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    const text = container.textContent ?? "";

    for (const forbidden of ["作者", "字数", "发布于", "评分", "阅读量"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text.toLowerCase()).not.toMatch(/author|word count|released on/);
  });
});

describe("章节页 · 章节导航", () => {
  it("有上下章时渲染链接", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER_LAST} />);
    expect(screen.getByRole("link", { name: "上一章" }).getAttribute("rel")).toBe("prev");
  });

  it("边界处不渲染无处可去的链接，改用说明文字", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);

    expect(screen.queryByRole("link", { name: "上一章" })).toBeNull();
    expect(screen.getByText("已是第一章")).toBeTruthy();
    expect(screen.getByRole("link", { name: "下一章" })).toBeTruthy();
  });

  it("最后一章试读时正式阅读升为主动作", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER_LAST} />);

    expect(screen.getByText("本站的试读到此结束。")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "前往正式阅读" }).className,
    ).toContain("bg-novel-accent");
  });

  it("非最后一章时正式阅读保持次动作", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);

    const link = screen.getByRole("link", { name: "前往正式阅读" });
    expect(link.className).not.toContain("bg-novel-accent");
    expect(link.className).toContain("border-novel-border-strong");
  });
});

describe("章节页 · 阅读作用域边界", () => {
  it("只有正文阅读区在阅读作用域里", () => {
    const { container } = render(<ChapterScreen chapter={MOCK_CHAPTER} />);

    const surfaces = container.querySelectorAll(".reader");
    expect(surfaces).toHaveLength(1);

    const surface = surfaces[0];
    // 页头、页脚、归属条、章节导航都不在阅读作用域内
    expect(surface.querySelector("header")).toBeNull();
    expect(surface.querySelector("footer")).toBeNull();
    expect(surface.querySelector('[data-testid="book-attribution-bar"]')).toBeNull();
    expect(surface.querySelector('[data-testid="chapter-pager"]')).toBeNull();
  });

  it("默认主题是跟随系统", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    expect(screen.getByTestId("reader-surface").getAttribute("data-reader-theme")).toBe(
      "system",
    );
  });
});

describe("阅读设置面板", () => {
  it("默认收起，点击后展开", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);

    expect(screen.queryByTestId("reader-settings-panel")).toBeNull();
    openPanel();
    expect(screen.getByTestId("reader-settings-panel")).toBeTruthy();
  });

  it("四组控件齐备：主题三态 + 字号 + 行高 + 页宽", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();

    expect(
      screen.getByTestId("reader-theme-control").querySelectorAll('[role="radio"]'),
    ).toHaveLength(3);
    expect(
      screen.getByTestId("reader-font-size-control").querySelectorAll('[role="radio"]'),
    ).toHaveLength(READER_FONT_SIZES.length);
    expect(
      screen.getByTestId("reader-line-height-control").querySelectorAll('[role="radio"]'),
    ).toHaveLength(READER_LINE_HEIGHTS.length);
    expect(
      screen.getByTestId("reader-measure-control").querySelectorAll('[role="radio"]'),
    ).toHaveLength(READER_MEASURES.length);
  });

  it("控件不是静态图形：切主题会改变阅读区的实际属性", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();

    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(screen.getByTestId("reader-surface").getAttribute("data-reader-theme")).toBe("dark");

    fireEvent.click(screen.getByRole("radio", { name: "浅色" }));
    expect(screen.getByTestId("reader-surface").getAttribute("data-reader-theme")).toBe("light");
  });

  it("控件不是静态图形：改字号 / 行高 / 页宽会改变阅读区的 CSS 变量", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();

    fireEvent.click(screen.getByRole("radio", { name: "22" }));
    fireEvent.click(screen.getByRole("radio", { name: "宽松" }));
    fireEvent.click(screen.getByRole("radio", { name: "宽" }));

    const style = screen.getByTestId("reader-surface").getAttribute("style") ?? "";
    expect(style).toContain("--reader-font-size: 22px");
    expect(style).toContain("--reader-line-height: 2");
    expect(style).toContain("--reader-measure: 76ch");
  });

  it("radio 的选中态用 aria-checked 表达", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();

    expect(screen.getByRole("radio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(screen.getByRole("radio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("恢复默认把四项设置一次性还原", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();

    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    fireEvent.click(screen.getByRole("radio", { name: "16" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));

    expect(screen.getByTestId("reader-surface").getAttribute("data-reader-theme")).toBe(
      "system",
    );
    expect(screen.getByTestId("reader-surface").getAttribute("style")).toContain(
      `--reader-font-size: ${READER_FONT_SIZES[DEFAULT_READER_SETTINGS.fontSizeIndex]}`,
    );
  });

  it("Esc 关闭面板", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("reader-settings-panel")).toBeNull();
  });

  it("明确告知本轮设置不跨会话保持", () => {
    render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();
    expect(screen.getByText("设置仅在本次浏览生效")).toBeTruthy();
  });
});

describe("阅读设置 · P1-11 接入点", () => {
  it("接受外部灌入的初值（P1-11 从本地存储读回）", () => {
    render(
      <ChapterScreen
        chapter={MOCK_CHAPTER}
        initialSettings={{ theme: "dark", fontSizeIndex: 3 }}
      />,
    );

    const surface = screen.getByTestId("reader-surface");
    expect(surface.getAttribute("data-reader-theme")).toBe("dark");
    expect(surface.getAttribute("style")).toContain("--reader-font-size: 22px");
  });

  it("向外抛出变更（P1-11 的持久化回调）", () => {
    const onSettingsChange = vi.fn();
    render(<ChapterScreen chapter={MOCK_CHAPTER} onSettingsChange={onSettingsChange} />);

    openPanel();
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));

    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
  });

  it("本轮不读写本地存储", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    render(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("存储键已定义，避免下一轮临时起名", () => {
    expect(READER_SETTINGS_STORAGE_KEY).toBe("novel:reader-settings:v1");
  });

  it("把越界或损坏的值收敛回合法范围", () => {
    expect(normalizeReaderSettings({ fontSizeIndex: 99 }).fontSizeIndex).toBe(
      READER_FONT_SIZES.length - 1,
    );
    expect(normalizeReaderSettings({ measureIndex: -5 }).measureIndex).toBe(0);
    expect(
      normalizeReaderSettings({ theme: "sepia" as never }).theme,
    ).toBe("system");
    expect(normalizeReaderSettings(null)).toEqual(DEFAULT_READER_SETTINGS);
  });

  it("非整数档位回默认档，而不是回中间档", () => {
    // 越界整数是「选过但超范围」，夹回两端；非整数是存储被损坏或被手改，
    // 唯一说得通的落点是默认值。字号有 4 档，中间档（2）恰好不等于默认档（1），
    // 这条断言就是用来钉住两者区别的。
    expect(normalizeReaderSettings({ fontSizeIndex: NaN }).fontSizeIndex).toBe(
      DEFAULT_READER_SETTINGS.fontSizeIndex,
    );
    expect(normalizeReaderSettings({ fontSizeIndex: 1.5 }).fontSizeIndex).toBe(
      DEFAULT_READER_SETTINGS.fontSizeIndex,
    );
  });
});