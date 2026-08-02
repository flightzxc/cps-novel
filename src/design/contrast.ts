/**
 * WCAG 2.1 对比度计算。
 *
 * 用途：让「正文 ≥ 4.5:1、非文本 ≥ 3:1」成为可执行断言而不是口头承诺。
 * 设计 token 的实际色值写在 src/styles/globals.css，由 tests/ui/design-tokens.test.ts
 * 解析出来后调用这里的函数重算——所以改色值而不改测试会直接失败。
 *
 * 参考：WCAG 2.1 成功准则 1.4.3（正文对比度）与 1.4.11（非文本对比度）。
 */

/** WCAG AA 正文与图形文字的最低对比度 */
export const WCAG_AA_TEXT = 4.5;
/** WCAG AA 大字号文本（≥18.66px 粗体或 ≥24px）的最低对比度 */
export const WCAG_AA_LARGE_TEXT = 3;
/** WCAG AA 非文本（控件边界、焦点指示）的最低对比度 */
export const WCAG_AA_NON_TEXT = 3;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * 解析 `#rgb` / `#rrggbb`（大小写皆可）。
 * 不接受带透明度的形式——token 里出现半透明色就意味着对比度不可静态验证，
 * 属于设计错误，应该在这里报出来而不是悄悄放过。
 */
export function parseHexColor(input: string): Rgb {
  const value = input.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);

  if (!match) {
    throw new Error(`不是可静态验证的十六进制颜色：${input}`);
  }

  const hex = match[1];
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex;

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** sRGB 单通道去伽马 */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 相对亮度，WCAG 定义 */
export function relativeLuminance(color: Rgb | string): number {
  const { r, g, b } = typeof color === "string" ? parseHexColor(color) : color;
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** 两色对比度，返回 1–21 之间的比值 */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 是否为纯黑。基底禁止用纯黑——OLED 上纯黑配白字会产生光晕拖影。 */
export function isPureBlack(color: string): boolean {
  const { r, g, b } = parseHexColor(color);
  return r === 0 && g === 0 && b === 0;
}

/** 是否为纯白。正文禁止用纯白，降低眩光。 */
export function isPureWhite(color: string): boolean {
  const { r, g, b } = parseHexColor(color);
  return r === 255 && g === 255 && b === 255;
}
