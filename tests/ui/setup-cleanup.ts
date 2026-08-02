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
