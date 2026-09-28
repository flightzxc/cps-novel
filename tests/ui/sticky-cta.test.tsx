import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { StickyCTA } from "@/features/public-ui/layout/StickyCTA";

/**
 * B1（照搬 CPS v8.5.1 `src/components/site/sticky-cta.tsx` 的结构，见
 * `StickyCTA.tsx` 头部注释）。新增用例（交接文档"测试与门禁"一节要求）：
 * 没有链接时不渲染。
 */
describe("StickyCTA", () => {
  it("没有 readOnUpstreamHref 时整块不渲染（不留 spacer，也不留浮窗本体）", () => {
    const { container } = render(<StickyCTA locale="en" href={undefined} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("sticky-cta")).toBeNull();
    expect(screen.queryByTestId("sticky-cta-spacer")).toBeNull();
  });

  it("有链接时渲染浮窗 + 等高 spacer，按钮跳 readOnUpstreamHref 且带 nofollow sponsored", () => {
    render(<StickyCTA locale="en" href="/go/abc123" />);

    const spacer = screen.getByTestId("sticky-cta-spacer");
    const bar = screen.getByTestId("sticky-cta");
    expect(spacer).toBeTruthy();
    expect(bar).toBeTruthy();
    // spacer 必须在浮窗本体之前——它在文档流里把随后的内容（这里是浮窗本体
    // 之后的页脚）推开，`fixed` 的浮窗本体自己不占据文档流空间。
    expect(spacer.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const link = screen.getByRole("link", { name: "Continue reading" });
    expect(link.getAttribute("href")).toBe("/go/abc123");
    expect(link.getAttribute("rel")).toBe("nofollow sponsored");
  });
});
