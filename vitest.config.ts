import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 路径含非 ASCII 字符时 new URL(...).pathname 会返回 percent-encoded 结果，
// 必须用 fileURLToPath 还原成真实文件系统路径。
const srcPath = fileURLToPath(new URL("./src", import.meta.url));

// 按目录所有权拆成两个 project：
//   ui   → Claude 独占的 tests/ui
//   node → Codex 独占的 tests/backend 与 tests/integration
// 两者 extends: true，共享根部的 resolve.alias 与 passWithNoTests。
export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
    },
  },
  test: {
    // Codex 侧目录本轮为空，不能因"零测试"判失败。
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/ui/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/backend/**/*.test.ts", "tests/integration/**/*.test.ts"],
        },
      },
    ],
  },
});
