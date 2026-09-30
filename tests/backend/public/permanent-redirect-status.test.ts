import { describe, expect, it } from "vitest";
import { permanentRedirect } from "next/navigation";
import { getRedirectStatusCodeFromError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * 2026-09-30 短码语种纠正的 HTTP 语义：详情页/章节页对"短码对得上、语种前缀
 * 或 slug 不对"的请求调 `permanentRedirect`，开发单要求这是 **308**。
 * 与 `not-found-status.test.ts` 同一手法：钉住 Next 对 `permanentRedirect` 的
 * 状态码映射——测试专用地引用 Next 内部模块，升级后路径/形状变了会在导入期
 * 大声失败，而不是悄悄把线上的 308 变成别的码。
 */
describe("public novel permanentRedirect() HTTP status", () => {
  it("Next maps permanentRedirect() to HTTP 308 (the short-code locale/slug correction status)", () => {
    try {
      permanentRedirect("/ko/novel/deungdae-pabc123");
    } catch (error) {
      if (!isRedirectError(error)) throw new Error("permanentRedirect() did not throw a redirect error");
      expect(getRedirectStatusCodeFromError(error)).toBe(308);
      return;
    }
    throw new Error("permanentRedirect() did not throw");
  });
});
