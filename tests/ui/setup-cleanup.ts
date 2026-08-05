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
 * 用例之间清空本地存储。
 *
 * jsdom 的 localStorage 在同一个测试文件内是跨用例共享的，阅读器现在会真的往
 * 里面写偏好与阅读位置。不清的话，前一个用例选的深色会漏进下一个用例的初值，
 * 表现为「单独跑绿、连着跑红」这种最难查的顺序依赖。
 */
afterEach(() => {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.clear();
    } catch {
      // 环境不支持就算了，测试不该因清理动作本身失败。
    }
  }
  // 阅读偏好会把手动主题覆盖镜像到 <html> 上，而 <html> 不在 RTL 的清理范围内。
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-reader-pref-theme");
  }
});

/**
 * jsdom 没有实现 window.matchMedia。阅读器与主推轮播都要靠它读
 * prefers-reduced-motion，缺了会直接抛错。这里补一个默认「不减少动效」的实现；
 * 需要验证减少动效分支的用例自行 stubGlobal 覆盖。
 */
/**
 * jsdom 没有实现 window.scrollTo（调用会打印 "Not implemented" 噪音，且不改变
 * scrollY）。阅读位置恢复每次挂载都会调它，这里补一个真的会更新 scrollY 的实现，
 * 这样用例既没有噪音，也能直接断言"滚到了哪里"。
 */
if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", {
    writable: true,
    configurable: true,
    value: (optionsOrX?: ScrollToOptions | number, y?: number) => {
      const top =
        typeof optionsOrX === "object" && optionsOrX !== null
          ? (optionsOrX.top ?? 0)
          : (y ?? 0);
      Object.defineProperty(window, "scrollY", {
        writable: true,
        configurable: true,
        value: top,
      });
    },
  });
}

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
