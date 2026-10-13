import "./setup-cleanup";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeModeInterstitial } from "@/features/public-ui/go/CodeModeInterstitial";
import { COPIED_STATE_MS } from "@/features/public-ui/go/CopyCodeButton";

/**
 * v0.6.0 F.1：口令码模式中间页——内容照设计稿（书名 + 封面、大号口令码 + 复制按钮、三步说明 / 一句话说明、
 * 两个商店按钮、免责小字）。商店链接缺哪个就不渲染哪个，都缺显示一句话兜底。
 */
const APP_STORE = "https://apps.apple.com/app/plotnovel/id123";
const GOOGLE_PLAY = "https://play.google.com/store/apps/details?id=com.plotnovel";

function page(overrides: Partial<Parameters<typeof CodeModeInterstitial>[0]> = {}) {
  return (
    <CodeModeInterstitial
      brandName="PulseNovel"
      appName="PlotNovel"
      title="Fifty Million For Ten Years"
      coverUrl="https://img.example/cover.jpg"
      code="960031"
      backHref="/novel/fifty-million-abc123"
      appStoreUrl={APP_STORE}
      googlePlayUrl={GOOGLE_PLAY}
      {...overrides}
    />
  );
}

describe("口令码模式中间页 · 内容", () => {
  it("书名、封面、大号口令码、标题与说明", () => {
    render(page());
    expect(screen.getByTestId("code-mode-book-title").textContent).toBe("Fifty Million For Ten Years");
    expect(screen.getByTestId("code-mode-code").textContent).toBe("960031");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Continue reading on PlotNovel");
    expect(screen.getByText("Available in the PlotNovel app")).toBeTruthy();
    expect(screen.getByText("Your book code")).toBeTruthy();
    expect(screen.getByTestId("code-mode-intro").textContent).toBe(
      "This book is read in the free PlotNovel app. Copy your book code, open the app, and paste it into Search.",
    );
    const image = document.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://img.example/cover.jpg");
  });

  it("三步说明（手机版，默认'三步版'）：编号 1–3 与设计稿文案逐字一致", () => {
    render(page());
    const steps = within(screen.getByTestId("code-mode-steps")).getAllByRole("listitem");
    expect(steps.map((item) => item.textContent?.replace(/^\d/, ""))).toEqual([
      "Copy the code above.",
      "Get the free PlotNovel app.",
      "Open the app, tap Search and paste the code. The book opens right away.",
    ]);
    expect(steps.map((item) => item.textContent?.[0])).toEqual(["1", "2", "3"]);
  });

  it("两个商店按钮：App Store 是主按钮，Google Play 是描边按钮；https 链接，新窗口安全属性", () => {
    render(page());
    const appStore = screen.getByRole("link", { name: /Download on the App Store/ });
    const play = screen.getByRole("link", { name: /Get it on Google Play/ });
    expect(appStore.getAttribute("href")).toBe(APP_STORE);
    expect(play.getAttribute("href")).toBe(GOOGLE_PLAY);
    expect(appStore.getAttribute("rel")).toBe("noopener noreferrer");
    expect(appStore.className).toContain("bg-novel-accent");
    expect(play.className).toContain("border-novel-border-strong");
    expect(screen.queryByTestId("code-mode-search-fallback")).toBeNull();
  });

  it("只配了一个商店链接：另一个按钮不渲染，也没有兜底句", () => {
    const { unmount } = render(page({ googlePlayUrl: null }));
    expect(screen.getByRole("link", { name: /Download on the App Store/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Get it on Google Play/ })).toBeNull();
    expect(screen.queryByTestId("code-mode-search-fallback")).toBeNull();
    unmount();

    render(page({ appStoreUrl: null }));
    expect(screen.queryByRole("link", { name: /Download on the App Store/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Get it on Google Play/ })).toBeTruthy();
  });

  it("两个商店链接都没配：不渲染任何下载按钮，显示一句 Search \"PlotNovel\" in your app store", () => {
    render(page({ appStoreUrl: null, googlePlayUrl: null }));
    expect(screen.queryByRole("link", { name: /App Store|Google Play/ })).toBeNull();
    expect(screen.getByTestId("code-mode-search-fallback").textContent).toBe('Search "PlotNovel" in your app store');
  });

  it("返回书页链接：有就渲染，没有（文章已下线）整个不渲染；免责小字用站点品牌名", () => {
    const { unmount } = render(page());
    expect(screen.getByTestId("code-mode-back").getAttribute("href")).toBe("/novel/fifty-million-abc123");
    expect(screen.getByText("PlotNovel is a third-party app. PulseNovel may earn a commission.")).toBeTruthy();
    unmount();
    render(page({ backHref: undefined }));
    expect(screen.queryByTestId("code-mode-back")).toBeNull();
  });

  it("App 名来自剧场配置，不写死品牌", () => {
    render(page({ appName: "ReadNow" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Continue reading on ReadNow");
    expect(screen.getByText('ReadNow is a third-party app. PulseNovel may earn a commission.')).toBeTruthy();
  });

  it("无封面也能渲染（占位块），书名里的特殊字符按文本渲染而不是 HTML", () => {
    const { container } = render(page({ coverUrl: undefined, title: '<img src=x onerror=alert(1)> & "quotes"' }));
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(screen.getByTestId("code-mode-book-title").textContent).toBe('<img src=x onerror=alert(1)> & "quotes"');
  });
});

describe("复制口令码按钮", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("点击 → 写入剪贴板、变成 Copied（成功色），1.8 秒后恢复 Copy code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(page());
    const button = screen.getByTestId("code-mode-copy");
    expect(button.textContent).toBe("Copy code");

    await act(async () => { fireEvent.click(button); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("960031");
    expect(button.textContent).toBe("Copied");
    expect(screen.getByRole("status").textContent).toBe("Copied");

    await act(async () => { vi.advanceTimersByTime(COPIED_STATE_MS - 1); });
    expect(button.textContent).toBe("Copied");
    await act(async () => { vi.advanceTimersByTime(2); });
    expect(button.textContent).toBe("Copy code");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("剪贴板接口失败时退回 execCommand；两条路都失败就保持原状（不假装已复制）", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    render(page());
    const button = screen.getByTestId("code-mode-copy");
    await act(async () => { fireEvent.click(button); });
    expect(exec).toHaveBeenCalledWith("copy");
    expect(button.textContent).toBe("Copied");

    await act(async () => { vi.advanceTimersByTime(COPIED_STATE_MS + 10); });
    exec.mockReturnValue(false);
    await act(async () => { fireEvent.click(button); });
    expect(button.textContent).toBe("Copy code");
  });
});
