import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 组件零硬编码色值。
 *
 * 所有颜色必须来自 src/styles/globals.css 的 token（经 Tailwind 的
 * novel-* / reader-* 工具类，或直接 var(--novel-*)）。组件里出现字面色值就意味着
 * 它逃出了对比度校验的覆盖范围——那正是 design-tokens 测试守不住的地方。
 */

const SCAN_ROOTS = ["../../src/components", "../../src/features/public-ui", "../../src/app"];

/**
 * 假数据目录是唯一豁免：它生成的是**内容图片**（内联占位封面的渐变），
 * 属于「封面是全站唯一高饱和元素」里的封面，不是界面颜色。
 */
const EXEMPT = ["fixtures"];

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXEMPT.includes(entry)) {
        continue;
      }
      out.push(...collectFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// 见 design-tokens.test.ts 的同一处注释：jsdom 的全局 URL 与 fileURLToPath 不兼容
const here = dirname(fileURLToPath(import.meta.url));
const files = SCAN_ROOTS.flatMap((root) => collectFiles(resolve(here, root)));

describe("组件零硬编码色值", () => {
  it("扫描到了待检查的文件", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((file) => [file.split("/src/")[1], file]))(
    "src/%s 不含字面色值",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      // 逐行扫描，跳过注释行，避免把说明文字里的示例色号误判为实现
      const offenders: string[] = [];

      for (const line of source.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          continue;
        }
        if (/#[0-9a-fA-F]{3,8}\b/.test(line)) {
          offenders.push(trimmed);
        }
        if (/\b(rgba?|hsla?)\s*\(/.test(line)) {
          offenders.push(trimmed);
        }
      }

      expect(offenders).toEqual([]);
    },
  );
});
