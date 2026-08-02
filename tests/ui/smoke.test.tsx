import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

// 用一个简单的内联组件做冒烟测试，避免直接渲染 Server Component（RSC）
// 带来的额外复杂度；这里只验证 P1-04 的测试链路（vitest + jsdom +
// @testing-library/react）本身是可用的。
function Greeting({ name }: { name: string }) {
  return <p>Hello, {name}!</p>;
}

describe("smoke", () => {
  it("renders a component and finds it in the DOM", () => {
    render(<Greeting name="cps-novel" />);

    const node = screen.getByText("Hello, cps-novel!");
    expect(node).toBeTruthy();
    expect(node.textContent).toBe("Hello, cps-novel!");
  });
});