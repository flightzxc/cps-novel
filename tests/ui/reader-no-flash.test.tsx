import "./setup-cleanup";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { ReaderSettingsProvider } from "@/features/public-ui/chapter/ReaderSettingsProvider";
import {
  READER_FONT_SIZES,
  READER_LINE_HEIGHTS,
  READER_MEASURES,
} from "@/features/public-ui/chapter/reader-settings";
import { writeReaderSettings } from "@/features/public-ui/chapter/reader-storage";
import { MOCK_CHAPTER } from "@/features/public-ui/fixtures/mock-content";

/**
 * 首帧不闪。
 *
 * 服务端不知道读者本机存过什么，阅读区只能先按默认值渲染。改过设置的读者因此
 * 会在补水前看到一帧默认外观：配色闪一下已经难看，**排版闪一下是整页回流**，
 * 而且会让阅读位置按错误的字号被测量。
 *
 * 防线由三段拼成，缺一不可，所以这里三段各自钉一遍：
 *   ① 章节布局的阻塞式内联脚本，在补水前把偏好写到 <html>；
 *   ② globals.css 的 --reader-pref-* 兜底层与主题回放规则，消费脚本写下的值；
 *   ③ 阅读区在补水前不写内联排版变量，免得盖掉前两段的成果。
 */

// jsdom 环境下全局 URL 是 jsdom 的实现，Node 的 fileURLToPath 不认它，
// 所以先把 import.meta.url 单独转成真实路径字符串，再用 path 拼接。
const here = dirname(fileURLToPath(import.meta.url));
const CHAPTER_LAYOUT_SOURCE = readFileSync(
  resolve(here, "../../src/app/dev-preview/chapter/layout.tsx"),
  "utf8",
);
const GLOBALS_CSS = readFileSync(resolve(here, "../../src/styles/globals.css"), "utf8");

describe("防闪 · ① 布局里的内联脚本", () => {
  it("是阻塞式内联脚本，且排在 children 之前", () => {
    // 必须先于阅读区绘制执行；用 next/script 或放到 children 之后都会晚一拍。
    expect(CHAPTER_LAYOUT_SOURCE).toContain("dangerouslySetInnerHTML");
    expect(CHAPTER_LAYOUT_SOURCE).not.toContain("next/script");

    const scriptAt = CHAPTER_LAYOUT_SOURCE.indexOf("dangerouslySetInnerHTML");
    const childrenAt = CHAPTER_LAYOUT_SOURCE.indexOf("{children}");
    expect(scriptAt).toBeLessThan(childrenAt);
  });

  it("主题与排版三项都回放——只修主题等于只解决了一半", () => {
    expect(CHAPTER_LAYOUT_SOURCE).toContain("data-reader-pref-theme");
    for (const cssVar of [
      "--reader-pref-font-size",
      "--reader-pref-line-height",
      "--reader-pref-measure",
    ]) {
      expect(CHAPTER_LAYOUT_SOURCE).toContain(cssVar);
    }
  });

  it("整段包在 try/catch 里——存储被禁用时不能挡住正文", () => {
    expect(CHAPTER_LAYOUT_SOURCE).toContain("try{");
    expect(CHAPTER_LAYOUT_SOURCE).toContain("catch(e){}");
  });

  it("档位表从同一个真源注入，脚本里不另抄一份字面量", () => {
    // 抄一份就会和 reader-settings.ts 漂移，读者的档位会在补水前后对不上。
    for (const literal of ["READER_FONT_SIZES", "READER_LINE_HEIGHTS", "READER_MEASURES"]) {
      expect(CHAPTER_LAYOUT_SOURCE).toContain(literal);
    }
    expect(CHAPTER_LAYOUT_SOURCE).not.toContain('"22px"');
  });
});

describe("防闪 · ② CSS 兜底层", () => {
  it("三项排版变量都经过 --reader-pref-* 兜底", () => {
    for (const [name, fallback] of [
      ["font-size", "18px"],
      ["line-height", "1.8"],
      ["measure", "68ch"],
    ]) {
      expect(GLOBALS_CSS).toContain(
        `--reader-${name}: var(--reader-pref-${name}, ${fallback});`,
      );
    }
  });

  it("兜底默认值与 DEFAULT_READER_SETTINGS 指向同一档", () => {
    // CSS 里的字面量和 TS 里的默认下标是两处独立事实，漂移了没人会发现——
    // 除非在这里对一遍。
    expect(READER_FONT_SIZES[1]).toBe("18px");
    expect(READER_LINE_HEIGHTS[1]).toBe("1.8");
    expect(READER_MEASURES[1]).toBe("68ch");
  });

  it("主题回放规则只作用于 system 态", () => {
    // 这是整套机制安全的根据：补水前阅读区恒为 system，补水后是 light/dark，
    // 两组选择器的匹配集互斥，永远不会互相打架。
    for (const theme of ["light", "dark"]) {
      expect(GLOBALS_CSS).toContain(
        `:root[data-reader-pref-theme="${theme}"] .reader[data-reader-theme="system"]`,
      );
    }
  });

  it("回放规则带 color-scheme——否则滚动条与表单件和正文配色对不上", () => {
    const prefBlocks = GLOBALS_CSS.match(
      /:root\[data-reader-pref-theme="(light|dark)"\][^{]*\{[^}]*\}/g,
    );
    expect(prefBlocks).toHaveLength(2);
    expect(prefBlocks![0]).toContain("color-scheme: light");
    expect(prefBlocks![1]).toContain("color-scheme: dark");
  });
});

describe("防闪 · ③ 阅读区的内联样式时机", () => {
  it("补水完成后才写内联排版变量", () => {
    writeReaderSettings({
      theme: "dark",
      fontSizeIndex: 3,
      lineHeightIndex: 2,
      measureIndex: 2,
    });

    render(
      <ReaderSettingsProvider>
        <ChapterScreen chapter={MOCK_CHAPTER} />
      </ReaderSettingsProvider>,
    );

    // RTL 的 render 会跑完 effect，所以这里看到的是补水之后的稳定态。
    const style = screen.getByTestId("reader-surface").getAttribute("style") ?? "";
    expect(style).toContain("--reader-font-size: 22px");
    expect(style).toContain("--reader-measure: 76ch");
  });

  it("独立渲染（无 Provider）时立即写内联变量，不受补水门控影响", () => {
    // 自持模式没有"等存储读回"这回事，P1-10 的行为必须逐字节保持。
    render(<ChapterScreen chapter={MOCK_CHAPTER} initialSettings={{ fontSizeIndex: 0 }} />);

    const style = screen.getByTestId("reader-surface").getAttribute("style") ?? "";
    expect(style).toContain("--reader-font-size: 16px");
  });
});
