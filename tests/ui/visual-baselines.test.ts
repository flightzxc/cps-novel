import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 视觉基准图的**清单校验**（P1-10）。
 *
 * 🔴 这**不是**自动截图回归。仓库里没有截图对比机制，本轮也明确不新增这类依赖。
 * 这个文件能证明的只有三件事：README 声明的 13 张图确实在库里、每张都是真 PNG
 * 且尺寸与声明的视口一致、目录里没有夹带未登记的图。像素级差异要靠
 * `baselines/README.md` 里那条 Chrome 命令重跑后人工比对——见本轮交付报告的
 * VISUAL_BASELINE_HASH_MATCH。
 *
 * 为什么值得写：基准图的失效方式往往不是"看起来不一样"，而是"某次提交漏了一张"
 * 或"换了台机器截出 2880×1800 的 HiDPI 图"。这两种都能在这里挡住，而且零依赖。
 */

const here = dirname(fileURLToPath(import.meta.url));
const baselineDir = resolve(here, "baselines");
const readme = readFileSync(resolve(baselineDir, "README.md"), "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(here, "../../package.json"), "utf8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

type BaselineEntry = { file: string; width: number; height: number };

/** 从 README 的覆盖范围表里解析出「文件 → 视口」，清单与文档因此不会各说各话。 */
function parseManifest(): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  for (const line of readme.split("\n")) {
    if (!line.startsWith("|") || !line.includes(".png")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const files = cells[1]
      .split("/")
      .map((token) => token.replace(/`/g, "").trim())
      .filter((token) => token.endsWith(".png"));
    const viewports = cells[3].split("/").map((token) => token.trim());
    expect(files.length, `${line} 的文件数与视口数对不上`).toBe(viewports.length);

    files.forEach((file, index) => {
      const match = /^(\d+)×(\d+)$/.exec(viewports[index]);
      expect(match, `无法解析视口 ${viewports[index]}`).not.toBeNull();
      entries.push({ file, width: Number(match![1]), height: Number(match![2]) });
    });
  }
  return entries;
}

/** 只读 PNG 头：签名 8 字节 + 长度 4 + "IHDR" 4 + 宽高各 4。 */
function readPngHeader(file: string): { width: number; height: number; bytes: number } {
  const buffer = readFileSync(resolve(baselineDir, file));
  expect(buffer.subarray(0, 8), `${file} 不是 PNG`).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(buffer.subarray(12, 16).toString("ascii"), `${file} 缺少 IHDR`).toBe("IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.byteLength,
  };
}

const MANIFEST = parseManifest();

describe("视觉基准 · 清单", () => {
  it("README 声明 13 张图", () => {
    expect(MANIFEST).toHaveLength(13);
  });

  it("声明的每张图都在库里，且不是空文件", () => {
    for (const { file } of MANIFEST) {
      const { bytes } = readPngHeader(file);
      // 截图失败时 Chrome 会留下 0 字节或只有几百字节的残留文件。
      expect(bytes, `${file} 太小，像是截图失败的残留`).toBeGreaterThan(10_000);
    }
  });

  it("目录里没有未登记的图——多出来的图不知道是哪一屏的", () => {
    const onDisk = readdirSync(baselineDir).filter((name) => name.endsWith(".png"));
    expect(onDisk.sort()).toEqual(MANIFEST.map((entry) => entry.file).sort());
  });

  it("每张图的像素尺寸与 README 声明的视口一致", () => {
    for (const { file, width, height } of MANIFEST) {
      const header = readPngHeader(file);
      expect(
        { file, width: header.width, height: header.height },
        `${file} 尺寸与声明不符（HiDPI 机器截图会是 2 倍）`,
      ).toEqual({ file, width, height });
    }
  });

  it("只有桌面 1440×900 与移动 390×844 两种视口，不混第三种", () => {
    const viewports = new Set(MANIFEST.map((entry) => `${entry.width}×${entry.height}`));
    expect([...viewports].sort()).toEqual(["1440×900", "390×844"]);
  });

  it("动态段改造后的章节基线指向第 1 章与末章，不是已删除的静态页", () => {
    // README 已记录路由从 /dev-preview/chapter 改为 /dev-preview/chapter/1。
    expect(readme).toContain("/dev-preview/chapter/1");
    expect(readme).toContain("/dev-preview/chapter/3");
    expect(MANIFEST.map((entry) => entry.file)).toContain("chapter-last-desktop.png");
  });
});

describe("视觉基准 · 不冒充自动回归", () => {
  it("README 自己写明这不是自动化视觉回归测试", () => {
    expect(readme).toContain("不是自动化视觉回归测试");
    expect(readme).toContain("基准图已入库");
  });

  it("仓库里确实没有截图对比依赖——有的话上面那句话就成了谎话", () => {
    const installed = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    });
    for (const name of [
      "pixelmatch",
      "resemblejs",
      "jest-image-snapshot",
      "playwright",
      "@playwright/test",
      "puppeteer",
      "cypress",
      "looks-same",
      "odiff-bin",
    ]) {
      expect(installed, `${name} 已安装，README 的免责声明需要同步更新`).not.toContain(name);
    }
  });

  it("重现命令仍然锁着可重现性所需的三个开关", () => {
    // 少任何一个，两次截图就不再逐字节可比：设备像素比会变、滚动条会画进图里、
    // 轮播会停在随机一张。
    expect(readme).toContain("--force-device-scale-factor=1");
    expect(readme).toContain("--hide-scrollbars");
    expect(readme).toContain("--virtual-time-budget=2500");
  });
});
