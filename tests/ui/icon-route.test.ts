import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import * as appleIcon from "@/app/apple-icon";
import { brandMarkImage } from "@/app/_components/brand-mark-image";
import * as icon from "@/app/icon";

type StyledElement = ReactElement<{
  style: Record<string, string | number>;
  src?: string;
  width?: number;
  height?: number;
  children?: StyledElement;
}>;

/** canvas div, then the single <img> mark, as `brandMarkImage` nests them. */
function parts(size: number) {
  const canvas = brandMarkImage(size) as StyledElement;
  const mark = canvas.props.children as StyledElement;
  return { canvas: canvas.props.style, mark };
}

describe("icon routes", () => {
  it("exports a 32x32 favicon module", () => {
    expect(icon.size).toEqual({ width: 32, height: 32 });
    expect(icon.contentType).toBe("image/png");
    expect(typeof icon.default).toBe("function");
  });

  it("exports a 180x180 apple-icon module", () => {
    expect(appleIcon.size).toEqual({ width: 180, height: 180 });
    expect(appleIcon.contentType).toBe("image/png");
    expect(typeof appleIcon.default).toBe("function");
  });
});

/**
 * PulseNovel 品牌接入（2026-09-19）：`brandMarkImage` 不再画几何占位（圆角
 * 方框 + 两根竖条，此前这三条用例测的是那套 div 树），而是把
 * `.brand-assets/pulsenovel-mark-256.png` 内嵌成 base64 data URI 画一张
 * `<img>`（satori 不解析 SVG/CSS 变量，见该文件顶部注释）。
 *
 * P1-10 §13「两个路由不得各画一套标记」的义务还在，只是现在守的方式变了：
 * 不再是「两处输出尺寸共用同一套 div 树」，而是「两处输出尺寸共用同一份
 * base64 位图，只做等比缩放」——所以下面第二条用例直接比较两个尺寸的
 * `src` 是否逐字节相同。
 */
describe("brand mark geometry", () => {
  it("scales the <img> box linearly with the output size", () => {
    const small = parts(32);
    const large = parts(180);

    expect(small.mark.props.width).toBe(32);
    expect(small.mark.props.height).toBe(32);
    expect(small.mark.props.style.width).toBe(32);
    expect(small.mark.props.style.height).toBe(32);

    expect(large.mark.props.width).toBe(180);
    expect(large.mark.props.height).toBe(180);
    expect(large.mark.props.style.width).toBe(180);
    expect(large.mark.props.style.height).toBe(180);
  });

  it("both sizes render the exact same embedded PNG asset", () => {
    const small = parts(32);
    const large = parts(180);

    expect(small.mark.props.src).toMatch(/^data:image\/png;base64,/);
    // 用来防「base64 被截断/贴错」这类静默损坏：一张真实 256px PNG 编码后
    // 远不止这个长度，太短说明资产没有正确内嵌。
    expect(small.mark.props.src!.length).toBeGreaterThan(10_000);
    // 同一份底图按输出尺寸缩放，不是给两个路由各生成一张图——src 必须相同。
    expect(small.mark.props.src).toBe(large.mark.props.src);
  });

  /** 画布仍是站点作用域的恒定深色基底（--novel-bg），没有换成别的颜色。 */
  it("keeps the dark site-scope canvas behind the mark", () => {
    const { canvas } = parts(32);
    expect(canvas.background).toBe("#12151c");
  });
});
