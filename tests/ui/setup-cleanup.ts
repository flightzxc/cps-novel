import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * 用例之间清理 DOM。
 *
 * vitest 没有开 globals，@testing-library/react 的自动清理探测不到全局 afterEach，
 * 于是不会自行注册——同一文件里的多个用例会把渲染结果叠在同一个 document 上，
 * 导致 getBy* 报「找到多个元素」。这里显式补上。
 *
 * 放在 tests/ui/ 内而不是改 vitest.config.ts，是为了不碰 Codex 侧的 node project 配置。
 * 每个 UI 测试文件顶部 `import "./setup-cleanup";` 即可。
 */
afterEach(cleanup);

/**
 * jsdom 没有实现 window.matchMedia。阅读器与主推轮播都要靠它读
 * prefers-reduced-motion，缺了会直接抛错。这里补一个默认「不减少动效」的实现；
 * 需要验证减少动效分支的用例自行 stubGlobal 覆盖。
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
