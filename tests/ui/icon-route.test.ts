import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import * as appleIcon from "@/app/apple-icon";
import { brandMarkImage } from "@/app/_components/brand-mark-image";
import * as icon from "@/app/icon";

type StyledElement = ReactElement<{
  style: Record<string, string | number>;
  children?: StyledElement | StyledElement[];
}>;

/** frame box, then the two bars, as `brandMarkImage` nests them. */
function parts(size: number) {
  const canvas = brandMarkImage(size) as StyledElement;
  const frame = canvas.props.children as StyledElement;
  const bars = frame.props.children as StyledElement[];
  return { canvas: canvas.props.style, frame: frame.props.style, bars: bars.map((b) => b.props.style) };
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
 * P1-10 §13 obligation: both sizes are the registered geometric placeholder, so
 * neither route may grow its own mark. Measurements are the 32-unit `BrandMark`
 * viewBox times `size / 32`, which is what keeps 180 from drifting off 32.
 */
describe("brand mark geometry", () => {
  it("scales every measurement linearly with the output size", () => {
    const small = parts(32);
    const large = parts(180);
    const scale = 180 / 32;

    expect(large.frame.width).toBeCloseTo(Number(small.frame.width) * scale);
    expect(large.frame.height).toBeCloseTo(Number(small.frame.height) * scale);
    expect(large.frame.borderRadius).toBeCloseTo(Number(small.frame.borderRadius) * scale);
    expect(large.frame.gap).toBeCloseTo(Number(small.frame.gap) * scale);
    expect(large.bars[0].width).toBeCloseTo(Number(small.bars[0].width) * scale);
    expect(large.bars[0].height).toBeCloseTo(Number(small.bars[0].height) * scale);
  });

  it("keeps the 32-unit proportions of BrandMark", () => {
    const { frame, bars } = parts(32);

    expect(frame.width).toBe(28);
    expect(frame.borderRadius).toBe(7);
    expect(frame.border).toBe("2px solid #626c84");
    expect(frame.gap).toBe(4);
    expect(bars.map((bar) => [bar.width, bar.height])).toEqual([
      [3, 14],
      [3, 14],
    ]);
  });

  /** Two bars of different weight is what makes the mark read as a mark. */
  it("keeps the warm and cool bars distinct", () => {
    const { canvas, bars } = parts(32);

    expect(canvas.background).toBe("#12151c");
    expect(bars[0].background).toBe("#e0a96d");
    expect(bars[1].background).toBe("#8a93a5");
  });
});
