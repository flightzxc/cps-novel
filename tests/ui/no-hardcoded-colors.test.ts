import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
 * 假数据目录是唯一内容豁免：它生成的是**内容图片**（内联占位封面的渐变），
 * 属于「封面是全站唯一高饱和元素」里的封面，不是界面颜色。
 *
 * `brand-mark-image.tsx` 画的是 `next/og` ImageResponse 画布，Satori 不解析
 * CSS 变量 / Tailwind，色值必须内联；token 对齐写在该文件注释里，不走组件扫描。
 * 两个图标路由（`icon.tsx` / `apple-icon.tsx`）只调用它，本身不含色值，因此不在豁免名单里。
 *
 * 🔴 豁免按仓库相对路径精确匹配（而非 basename）：按 basename 匹配会让任何目录下
 * 同名的 `brand-mark-image.tsx` 一并逃逸扫描，豁免范围必须锁定到这一个文件。
 */
const EXEMPT_DIRS = ["fixtures"];
const EXEMPT_FILES = ["src/app/_components/brand-mark-image.tsx"];

// 见 design-tokens.test.ts 的同一处注释：jsdom 的全局 URL 与 fileURLToPath 不兼容
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

function toRepoRelativePath(fullPath: string): string {
  return relative(REPO_ROOT, fullPath).split(sep).join("/");
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXEMPT_DIRS.includes(entry)) {
        continue;
      }
      out.push(...collectFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      if (!EXEMPT_FILES.includes(toRepoRelativePath(full))) {
        out.push(full);
      }
    }
  }
  return out;
}

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
