import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WCAG_AA_NON_TEXT,
  WCAG_AA_TEXT,
  contrastRatio,
  isPureBlack,
  isPureWhite,
} from "@/design/contrast";

/**
 * 设计 token 的对比度契约。
 *
 * 这个测试直接解析 src/styles/globals.css 里的**实际色值**再重算对比度——
 * 不是照抄文档里的数字。所以改色值而不满足门槛会在这里失败，
 * 「WCAG AA 达标」不再是一句口头承诺。
 */

// jsdom 环境下全局 URL 是 jsdom 的实现，Node 的 fileURLToPath 不认它，
// 所以先把 import.meta.url 单独转成真实路径字符串，再用 path 拼接。
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../src/styles/globals.css"), "utf8");

// 注释里也写了色号（说明文字），解析前先去掉，否则会把注释当声明读进来
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取出某个选择器下的声明块。本文件里这些块都不含嵌套花括号。 */
function declarationsOf(selector: string): Record<string, string> {
  const index = cssWithoutComments.indexOf(`${selector} {`);
  expect(index, `globals.css 里找不到选择器 ${selector}`).toBeGreaterThan(-1);

  const start = cssWithoutComments.indexOf("{", index) + 1;
  const end = cssWithoutComments.indexOf("}", start);
  const body = cssWithoutComments.slice(start, end);

  const result: Record<string, string> = {};
  for (const segment of body.split(";")) {
    const match = /(--[\w-]+)\s*:\s*([\s\S]+)/.exec(segment.trim());
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

const root = declarationsOf(":root");
const site = declarationsOf(".site");

const readerLight = {
  bg: root["--reader-light-bg"],
  fg: root["--reader-light-fg"],
  fgMuted: root["--reader-light-fg-muted"],
};
const readerDark = {
  bg: root["--reader-dark-bg"],
  fg: root["--reader-dark-fg"],
  fgMuted: root["--reader-dark-fg-muted"],
};

describe("设计 token · 结构", () => {
  it("站点作用域声明了全部必需的颜色 token", () => {
    const required = [
      "--novel-bg",
      "--novel-bg-elevated",
      "--novel-bg-raised",
      "--novel-fg",
      "--novel-fg-muted",
      "--novel-fg-subtle",
      "--novel-border",
      "--novel-border-strong",
      "--novel-primary",
      "--novel-primary-hover",
      "--novel-accent",
      "--novel-accent-hover",
      "--novel-on-accent",
      "--novel-danger",
      "--novel-success",
      "--novel-focus",
    ];

    for (const token of required) {
      expect(site[token], `.site 缺少 ${token}`).toBeTruthy();
    }
  });

  it("阅读作用域的浅深两套调色板都齐全", () => {
    for (const value of [
      readerLight.bg,
      readerLight.fg,
      readerLight.fgMuted,
      root["--reader-light-selection"],
      readerDark.bg,
      readerDark.fg,
      readerDark.fgMuted,
      root["--reader-dark-selection"],
    ]) {
      expect(value).toBeTruthy();
    }
  });

  it("建立了 .site 与 .reader 两个作用域", () => {
    expect(css).toContain(".site {");
    expect(css).toContain(".reader {");
  });

  it("阅读主题是三态：跟随系统为默认，手动选择优先级更高", () => {
    // 跟随系统 + 手动浅色共用一套浅色值
    expect(css).toContain('.reader[data-reader-theme="light"]');
    expect(css).toContain('.reader[data-reader-theme="system"]');
    // 系统为深色时，仅对 system 态生效
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*\.reader\[data-reader-theme="system"\]/,
    );
    // 手动深色是独立选择器，写在媒体查询之后，因此优先级更高
    const systemDarkAt = css.search(/@media \(prefers-color-scheme: dark\)/);
    const manualDarkAt = css.indexOf('.reader[data-reader-theme="dark"] {');
    expect(manualDarkAt).toBeGreaterThan(systemDarkAt);
  });

  it("封面比例只有一个定义处", () => {
    const occurrences = css.match(/--novel-cover-aspect\s*:/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("不引入任何 Web Font", () => {
    expect(css).not.toMatch(/@font-face/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import url\(/);
  });
});

describe("设计 token · 纯黑与纯白禁用", () => {
  it("基底不用纯黑", () => {
    expect(isPureBlack(site["--novel-bg"])).toBe(false);
    expect(isPureBlack(readerDark.bg)).toBe(false);
  });

  it("正文不用纯白", () => {
    expect(isPureWhite(site["--novel-fg"])).toBe(false);
    expect(isPureWhite(readerLight.bg)).toBe(false);
    expect(isPureWhite(readerDark.fg)).toBe(false);
  });
});

describe("设计 token · WCAG AA 对比度", () => {
  const textPairs: [string, string, string][] = [
    ["主文本 / 基底", site["--novel-fg"], site["--novel-bg"]],
    ["主文本 / 卡片底", site["--novel-fg"], site["--novel-bg-elevated"]],
    ["主文本 / 抬升底", site["--novel-fg"], site["--novel-bg-raised"]],
    ["次要文本 / 基底", site["--novel-fg-muted"], site["--novel-bg"]],
    ["次要文本 / 卡片底", site["--novel-fg-muted"], site["--novel-bg-elevated"]],
    ["次要文本 / 抬升底", site["--novel-fg-muted"], site["--novel-bg-raised"]],
    ["第三级文本 / 基底", site["--novel-fg-subtle"], site["--novel-bg"]],
    ["第三级文本 / 卡片底", site["--novel-fg-subtle"], site["--novel-bg-elevated"]],
    ["链接色 / 基底", site["--novel-primary"], site["--novel-bg"]],
    ["链接色 / 卡片底", site["--novel-primary"], site["--novel-bg-elevated"]],
    ["主按钮文字 / 纸色填充", site["--novel-on-accent"], site["--novel-accent"]],
    ["主按钮文字 / 纸色悬停", site["--novel-on-accent"], site["--novel-accent-hover"]],
    ["描边按钮文字 / 基底", site["--novel-fg"], site["--novel-bg"]],
    ["下架色 / 基底", site["--novel-danger"], site["--novel-bg"]],
    ["下架色 / 卡片底", site["--novel-danger"], site["--novel-bg-elevated"]],
    ["成功色 / 基底", site["--novel-success"], site["--novel-bg"]],
    ["阅读浅色 正文 / 底", readerLight.fg, readerLight.bg],
    ["阅读浅色 次要 / 底", readerLight.fgMuted, readerLight.bg],
    ["阅读深色 正文 / 底", readerDark.fg, readerDark.bg],
    ["阅读深色 次要 / 底", readerDark.fgMuted, readerDark.bg],
  ];

  it.each(textPairs)("%s 达到正文 4.5:1", (_label, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  const nonTextPairs: [string, string, string][] = [
    ["焦点环 / 基底", site["--novel-focus"], site["--novel-bg"]],
    ["焦点环 / 卡片底", site["--novel-focus"], site["--novel-bg-elevated"]],
    ["交互边界 / 基底", site["--novel-border-strong"], site["--novel-bg"]],
    ["交互边界 / 卡片底", site["--novel-border-strong"], site["--novel-bg-elevated"]],
  ];

  it.each(nonTextPairs)("%s 达到非文本 3:1", (_label, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
  });
});
