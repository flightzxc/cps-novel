import "./setup-cleanup";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { ReaderSettingsProvider } from "@/features/public-ui/chapter/ReaderSettingsProvider";
import {
  DEFAULT_READER_SETTINGS,
  READER_SETTINGS_STORAGE_KEY,
} from "@/features/public-ui/chapter/reader-settings";
import {
  readReaderSettings,
  writeReaderSettings,
} from "@/features/public-ui/chapter/reader-storage";
import { MOCK_CHAPTER } from "@/features/public-ui/fixtures/mock-content";

/**
 * 偏好持久化（P1-11 交付物 ②）。
 *
 * 这里验的是「跨会话保持」这一条：偏好必须真的落到 localStorage，且下次挂载能
 * 读回来。P1-10 的同名能力只活在组件 state 里，刷新即失。
 */

function renderWithProvider(ui: ReactElement) {
  return render(<ReaderSettingsProvider>{ui}</ReaderSettingsProvider>);
}

function openPanel() {
  fireEvent.click(screen.getByTestId("reader-settings-toggle"));
}

describe("阅读偏好 · 持久化", () => {
  it("改设置会写进本地存储", () => {
    renderWithProvider(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));

    expect(readReaderSettings().theme).toBe("dark");
    expect(window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY)).toContain("dark");
  });

  it("四项排版参数各自都持久化，不是只存了主题", () => {
    renderWithProvider(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();
    fireEvent.click(screen.getByRole("radio", { name: "22" }));
    fireEvent.click(screen.getByRole("radio", { name: "宽松" }));
    fireEvent.click(screen.getByRole("radio", { name: "宽" }));
    fireEvent.click(screen.getByRole("radio", { name: "浅色" }));

    expect(readReaderSettings()).toEqual({
      theme: "light",
      fontSizeIndex: 3,
      lineHeightIndex: 2,
      measureIndex: 2,
    });
  });

  it("重新挂载后读回存过的偏好——这就是「跨会话保持」", () => {
    writeReaderSettings({
      theme: "dark",
      fontSizeIndex: 3,
      lineHeightIndex: 0,
      measureIndex: 0,
    });

    renderWithProvider(<ChapterScreen chapter={MOCK_CHAPTER} />);

    const surface = screen.getByTestId("reader-surface");
    expect(surface.getAttribute("data-reader-theme")).toBe("dark");
    expect(surface.getAttribute("style")).toContain("--reader-font-size: 22px");
    expect(surface.getAttribute("style")).toContain("--reader-line-height: 1.6");
    expect(surface.getAttribute("style")).toContain("--reader-measure: 60ch");
  });

  it("恢复默认同样落盘，不会下次挂载又变回旧值", () => {
    writeReaderSettings({
      theme: "dark",
      fontSizeIndex: 3,
      lineHeightIndex: 2,
      measureIndex: 2,
    });

    renderWithProvider(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));

    expect(readReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
  });

  it("手动主题覆盖同时镜像到 html，供防闪脚本与 CSS 使用", () => {
    renderWithProvider(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();

    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(document.documentElement.getAttribute("data-reader-pref-theme")).toBe("dark");

    // 回到「跟随系统」时属性必须**移除**而不是写 "system"：
    // 没有属性参与，媒体查询才能自己说了算。
    fireEvent.click(screen.getByRole("radio", { name: "跟随系统" }));
    expect(document.documentElement.hasAttribute("data-reader-pref-theme")).toBe(false);
  });
});

describe("阅读偏好 · 存储异常不影响阅读", () => {
  it("存储里是损坏的 JSON 时回默认值，不抛异常", () => {
    window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, "{ 这不是 JSON");

    expect(readReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
    expect(() => renderWithProvider(<ChapterScreen chapter={MOCK_CHAPTER} />)).not.toThrow();
    expect(screen.getByTestId("reader-surface").getAttribute("data-reader-theme")).toBe(
      "system",
    );
  });

  it("存储里是合法 JSON 但结构不对时收敛回合法值", () => {
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({ theme: "sepia", fontSizeIndex: 99, measureIndex: -3 }),
    );

    expect(readReaderSettings()).toEqual({
      theme: "system",
      fontSizeIndex: 3,
      lineHeightIndex: DEFAULT_READER_SETTINGS.lineHeightIndex,
      measureIndex: 0,
    });
  });

  it("setItem 抛异常（Safari 无痕模式）时正文照常渲染", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });

    renderWithProvider(<ChapterScreen chapter={MOCK_CHAPTER} />);
    openPanel();

    expect(() => fireEvent.click(screen.getByRole("radio", { name: "深色" }))).not.toThrow();
    // 存不下也要在本次会话内生效——存储失败不等于设置失败。
    expect(screen.getByTestId("reader-surface").getAttribute("data-reader-theme")).toBe(
      "dark",
    );

    setItem.mockRestore();
  });

  it("getItem 抛异常（站点数据被禁用）时回默认值", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });

    expect(readReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
    expect(() => renderWithProvider(<ChapterScreen chapter={MOCK_CHAPTER} />)).not.toThrow();

    getItem.mockRestore();
  });
});
