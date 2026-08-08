import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdminContentQueryError } from "@/server/admin-content";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { ContentErrorPanel } from "@/app/(admin)/novels/_components/content-states";

const notFoundCalls = vi.hoisted(() => ({ count: 0 }));

/**
 * `notFound()` 在真实运行时是靠抛异常中断渲染的。这里的替身保持"抛"这个语义，
 * 否则 `notFoundIfMissingIdentifier` 的 `never` 返回值在测试里会悄悄变成 undefined，
 * 于是"该 404 却继续往下渲染"这类 bug 反而测不出来。
 */
vi.mock("next/navigation", () => ({
  notFound: () => {
    notFoundCalls.count += 1;
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { notFoundIfMissingIdentifier, queryErrorEnvelope } = await import(
  "@/app/(admin)/novels/_lib/content-errors"
);

const NovelsError = (await import("@/app/(admin)/novels/error")).default;

describe("P2-04 详情页错误分流", () => {
  it("非法 UUID → 404", () => {
    notFoundCalls.count = 0;
    expect(() =>
      notFoundIfMissingIdentifier(
        new AdminContentQueryError("invalid_identifier", "A valid UUID identifier is required"),
      ),
    ).toThrow("NEXT_NOT_FOUND");
    expect(notFoundCalls.count).toBe(1);
  });

  /**
   * 本轮修订的核心：`.catch(() => null)` 会把断连、超时、驱动异常一律说成
   * "没有这本书"。这三条断言钉住"查不到" ≠ "查不出来"。
   */
  it.each([
    ["数据库连接断开", new Error("Connection terminated unexpectedly")],
    ["查询超时", new Error("Query read timeout")],
    ["驱动异常", Object.assign(new Error("P1001"), { name: "PrismaClientInitializationError" })],
  ])("%s 原样抛出，不伪装成 404", (_name, error) => {
    notFoundCalls.count = 0;
    expect(() => notFoundIfMissingIdentifier(error)).toThrow(error);
    expect(notFoundCalls.count).toBe(0);
  });

  it("其它 kernel 校验错误也不当 404，交给上层决定", () => {
    notFoundCalls.count = 0;
    const error = new AdminContentQueryError("invalid_page", "Page must be a positive integer");
    expect(() => notFoundIfMissingIdentifier(error)).toThrow(error);
    expect(notFoundCalls.count).toBe(0);
  });
});

describe("P2-04 查询参数错误就地提示", () => {
  it.each([
    ["invalid_page", "页码无效，必须是大于 0 的整数"],
    ["invalid_page_size", "每页条数无效，必须在 1 到 100 之间"],
    ["invalid_status", "状态取值未登记"],
  ] as const)("%s 映射为 400 并给出点名参数的文案", (code, copy) => {
    const envelope = queryErrorEnvelope(new AdminContentQueryError(code, "boom"));
    expect(envelope).toMatchObject({ ok: false, status: 400, code });
    expect(errorEnvelopeCopy(envelope!)).toBe(copy);
  });

  it("非法标识不走就地提示，留给 404", () => {
    expect(
      queryErrorEnvelope(new AdminContentQueryError("invalid_identifier", "bad id")),
    ).toBeNull();
  });

  it("基础设施异常不走就地提示，留给 error boundary", () => {
    expect(queryErrorEnvelope(new Error("Connection terminated unexpectedly"))).toBeNull();
  });

  it("就地提示面板渲染出可读文案", () => {
    const envelope = queryErrorEnvelope(new AdminContentQueryError("invalid_page", "boom"))!;
    render(<ContentErrorPanel message={errorEnvelopeCopy(envelope)} />);
    expect(screen.getByTestId("content-error").textContent).toBe(
      "页码无效，必须是大于 0 的整数",
    );
  });
});

describe("P2-04 段级 error boundary", () => {
  it("明说这不是「不存在」，并给出可重试入口", () => {
    render(<NovelsError error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={() => {}} />);
    const panel = screen.getByTestId("novels-segment-error");
    expect(panel.textContent).toContain("内容数据读取失败");
    expect(panel.textContent).toContain("这不是「没有这本书」");
    expect(panel.textContent).toContain("abc123");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  /** 生产环境 message 会被剥离，开发环境又可能带驱动细节——两边都不该渲染。 */
  it("不渲染 error.message", () => {
    const { container } = render(
      <NovelsError
        error={Object.assign(new Error("postgres://user:pw@host/db timed out"), {
          digest: "d1",
        })}
        reset={() => {}}
      />,
    );
    expect(container.textContent ?? "").not.toContain("postgres://");
    expect(container.textContent ?? "").not.toContain("timed out");
  });

  it("重试按钮调用 reset", () => {
    const reset = vi.fn();
    render(<NovelsError error={new Error("boom")} reset={reset} />);
    screen.getByRole("button", { name: "重试" }).click();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
