import "./setup-cleanup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverImage } from "@/components/CoverImage";

/**
 * 封面组件（B-37 阶段 0）：
 *   - 上游直链加载失败时显示「无封面占位」，不露浏览器原生破图图标；
 *   - 失败判定两条路径：onError，以及挂载时 `complete && naturalWidth === 0`
 *     （服务端渲染的 img 可能在水合之前就已失败，浏览器不会再补发 error）；
 *   - src 变化后重置失败状态；
 *   - `priority` → eager + fetchpriority=high，默认 lazy。
 */

const SRC_A = "https://img.example.test/cover/a.jpg";
const SRC_B = "https://img.example.test/cover/b.jpg";

/** jsdom 不加载图片，`complete`/`naturalWidth` 要靠原型 getter 桩来模拟浏览器给出的结果。 */
function stubImageState(state: { complete: boolean; naturalWidth: number }) {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(state.complete);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(state.naturalWidth);
}

function frame(container: HTMLElement) {
  return container.querySelector("[data-cover-state]") as HTMLElement;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CoverImage · 加载失败兜底", () => {
  it("正常有图时渲染 <img>，没有占位", () => {
    const { container } = render(<CoverImage src={SRC_A} alt="Cover of A" />);

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(SRC_A);
    expect(img!.getAttribute("alt")).toBe("Cover of A");
    expect(frame(container).getAttribute("data-cover-state")).toBe("image");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("触发 error 事件后换成占位：<img> 被移除，书脊 SVG 出现", () => {
    const { container } = render(<CoverImage src={SRC_A} alt="Cover of A" />);

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(frame(container).getAttribute("data-cover-state")).toBe("failed");
  });

  it("水合前就已失败：挂载时 complete=true 且 naturalWidth=0，不等 error 事件直接渲染占位", () => {
    stubImageState({ complete: true, naturalWidth: 0 });

    const { container } = render(<CoverImage src={SRC_A} alt="Cover of A" />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(frame(container).getAttribute("data-cover-state")).toBe("failed");
  });

  it("挂载检查不误伤：已成功加载（complete=true 且 naturalWidth>0）仍显示图", () => {
    stubImageState({ complete: true, naturalWidth: 250 });

    const { container } = render(<CoverImage src={SRC_A} alt="Cover of A" />);

    expect(container.querySelector("img")).not.toBeNull();
    expect(frame(container).getAttribute("data-cover-state")).toBe("image");
  });

  it("挂载检查不误伤：还在加载（complete=false，naturalWidth=0）仍显示图", () => {
    stubImageState({ complete: false, naturalWidth: 0 });

    const { container } = render(<CoverImage src={SRC_A} alt="Cover of A" />);

    expect(container.querySelector("img")).not.toBeNull();
    expect(frame(container).getAttribute("data-cover-state")).toBe("image");
  });

  it("src 变化后重置失败状态：新地址重新渲染 <img>", () => {
    const { container, rerender } = render(<CoverImage src={SRC_A} alt="Cover of A" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();

    rerender(<CoverImage src={SRC_B} alt="Cover of B" />);

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(SRC_B);
    expect(frame(container).getAttribute("data-cover-state")).toBe("image");
  });

  it("src 变化后新地址再失败，仍会再次进入占位（状态不是只能失败一次）", () => {
    const { container, rerender } = render(<CoverImage src={SRC_A} alt="Cover of A" />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<CoverImage src={SRC_B} alt="Cover of B" />);

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(frame(container).getAttribute("data-cover-state")).toBe("failed");
  });

  it("没有 src 时仍是占位（原有行为），状态为 empty", () => {
    const { container } = render(<CoverImage alt="No cover" />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(frame(container).getAttribute("data-cover-state")).toBe("empty");
  });

  it("占位态与图片态都保留设计约束：比例只走 token，内描边仍在", () => {
    const ok = render(<CoverImage src={SRC_A} alt="a" />);
    fireEvent.error(ok.container.querySelector("img")!);

    for (const container of [ok.container, render(<CoverImage alt="b" />).container]) {
      const style = frame(container).getAttribute("style") ?? "";
      expect(style).toContain("var(--novel-cover-aspect)");
      expect(style).not.toMatch(/3\s*\/\s*4|2\s*\/\s*3/);
      // 内描边：aria-hidden 的 ring 层
      expect(container.querySelector('[class*="ring-inset"]')).not.toBeNull();
    }
  });
});

describe("CoverImage · 加载优先级", () => {
  it("默认 lazy，且不带 fetchpriority", () => {
    const { container } = render(<CoverImage src={SRC_A} alt="a" />);
    const img = container.querySelector("img")!;

    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.hasAttribute("fetchpriority")).toBe(false);
  });

  it("priority 为真时 loading=eager + fetchpriority=high", () => {
    const { container } = render(<CoverImage src={SRC_A} alt="a" priority />);
    const img = container.querySelector("img")!;

    expect(img.getAttribute("loading")).toBe("eager");
    expect(img.getAttribute("fetchpriority")).toBe("high");
  });

  it("服务端渲染输出同样带上这些属性（首屏靠 SSR 的 HTML 就能让浏览器提前发现高优先级图）", () => {
    const eager = renderToStaticMarkup(<CoverImage src={SRC_A} alt="a" priority />);
    const lazy = renderToStaticMarkup(<CoverImage src={SRC_A} alt="a" />);

    expect(eager).toContain('loading="eager"');
    expect(eager).toContain('fetchPriority="high"');
    expect(lazy).toContain('loading="lazy"');
    expect(lazy).not.toMatch(/fetchPriority/i);
  });
});
