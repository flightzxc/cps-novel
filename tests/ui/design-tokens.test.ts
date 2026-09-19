import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WCAG_AA_NON_TEXT,
  WCAG_AA_TEXT,
  contrastRatio,
  isPureBlack,
  isPureWhite,
  relativeLuminance,
} from "@/design/contrast";

/**
 * 设计 token 的对比度契约。
 *
 * 这个测试直接解析 src/styles/globals.css 里的**实际色值**再重算对比度——
 * 不是照抄文档里的数字。所以改色值而不满足门槛会在这里失败，
 * 「WCAG AA 达标」不再是一句口头承诺。
 */

// jsdom 环境下全局 URL 是 jsdom 的实现，Node 的 fileURLToPath 不认它，
// 所以先把 import.meta.url 单独转成真实路径字符串，再用 path 拼接。
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../src/styles/globals.css"), "utf8");

// 注释里也写了色号（说明文字），解析前先去掉，否则会把注释当声明读进来
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取出某个选择器下的声明块。本文件里这些块都不含嵌套花括号。 */
function declarationsOf(selector: string): Record<string, string> {
  const index = cssWithoutComments.indexOf(`${selector} {`);
  expect(index, `globals.css 里找不到选择器 ${selector}`).toBeGreaterThan(-1);

  const start = cssWithoutComments.indexOf("{", index) + 1;
  const end = cssWithoutComments.indexOf("}", start);
  const body = cssWithoutComments.slice(start, end);

  const result: Record<string, string> = {};
  for (const segment of body.split(";")) {
    const match = /(--[\w-]+)\s*:\s*([\s\S]+)/.exec(segment.trim());
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

const root = declarationsOf(":root");
const site = declarationsOf(".site");

const readerLight = {
  bg: root["--reader-light-bg"],
  fg: root["--reader-light-fg"],
  fgMuted: root["--reader-light-fg-muted"],
};
const readerDark = {
  bg: root["--reader-dark-bg"],
  fg: root["--reader-dark-fg"],
  fgMuted: root["--reader-dark-fg-muted"],
};

describe("设计 token · 结构", () => {
  it("站点作用域声明了全部必需的颜色 token", () => {
    const required = [
      "--novel-bg",
      "--novel-bg-elevated",
      "--novel-bg-raised",
      "--novel-fg",
      "--novel-fg-muted",
      "--novel-fg-subtle",
      "--novel-border",
      "--novel-border-strong",
      "--novel-primary",
      "--novel-primary-hover",
      "--novel-accent",
      "--novel-accent-hover",
      "--novel-on-accent",
      "--novel-danger",
      "--novel-success",
      "--novel-focus",
    ];

    for (const token of required) {
      expect(site[token], `.site 缺少 ${token}`).toBeTruthy();
    }
  });

  it("阅读作用域的浅深两套调色板都齐全", () => {
    for (const value of [
      readerLight.bg,
      readerLight.fg,
      readerLight.fgMuted,
      root["--reader-light-selection"],
      readerDark.bg,
      readerDark.fg,
      readerDark.fgMuted,
      root["--reader-dark-selection"],
    ]) {
      expect(value).toBeTruthy();
    }
  });

  it("建立了 .site 与 .reader 两个作用域", () => {
    expect(css).toContain(".site {");
    expect(css).toContain(".reader {");
  });

  it("阅读主题是三态：跟随系统为默认，手动选择优先级更高", () => {
    // 跟随系统 + 手动浅色共用一套浅色值
    expect(css).toContain('.reader[data-reader-theme="light"]');
    expect(css).toContain('.reader[data-reader-theme="system"]');
    // 系统为深色时，仅对 system 态生效
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*\.reader\[data-reader-theme="system"\]/,
    );
    // 手动深色是独立选择器，写在媒体查询之后，因此优先级更高
    const systemDarkAt = css.search(/@media \(prefers-color-scheme: dark\)/);
    const manualDarkAt = css.indexOf('.reader[data-reader-theme="dark"] {');
    expect(manualDarkAt).toBeGreaterThan(systemDarkAt);
  });

  it("补水前的防闪规则存在，且比 system 的两条规则更具体", () => {
    // 服务端不知道读者存过什么主题，阅读区只能先按 system 渲染。章节布局里的
    // 内联脚本在补水前把偏好写到 <html data-reader-pref-theme>，这两条规则据此
    // 提前压过 system 的表现，否则手动选过浅/深色的读者会闪一帧相反的配色。
    for (const theme of ["light", "dark"]) {
      expect(css).toContain(
        `:root[data-reader-pref-theme="${theme}"] .reader[data-reader-theme="system"]`,
      );
    }

    // 必须写在 system 的浅色规则与深色媒体查询**之后**：这两条规则和它们的
    // 特异性差距只有一个属性选择器，靠的是"后来者胜"，顺序反了就压不住。
    const systemDarkAt = css.search(/@media \(prefers-color-scheme: dark\)/);
    const prefDarkAt = css.indexOf(
      ':root[data-reader-pref-theme="dark"] .reader[data-reader-theme="system"]',
    );
    expect(prefDarkAt).toBeGreaterThan(systemDarkAt);
  });

  it("封面比例只有一个定义处", () => {
    const occurrences = css.match(/--novel-cover-aspect\s*:/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  /**
   * 单一定义源。承重点是「组件只能引用不能自造」：同一个 token 在基础块里
   * 出现两次，谁生效就取决于书写顺序，改一处不会全改到。
   *
   * 🔴 响应式覆盖是**合法的**第二处，所以这条不能简单放宽成「允许两次」——
   * 那样基础块里真多写一遍也照样通过。判据是分开算：
   *   基础块（任何 @media 之外）必须恰好 1 次；
   *   多出来的每一次都必须落在一个**带宽度条件**的 @media 里。
   * 2026-09-20 首屏密度轮新增了 768–1199 的平板档，就是走的第二条。
   */
  function definitionSites(token: string) {
    // 先扫出所有 @media 块的区间与条件（媒体块可嵌套，按花括号配对找结尾）
    const medias: { start: number; end: number; cond: string }[] = [];
    const mre = /@media([^{]*)\{/g;
    let m: RegExpExecArray | null;
    while ((m = mre.exec(css)) !== null) {
      let depth = 1;
      let i = mre.lastIndex;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth += 1;
        else if (css[i] === "}") depth -= 1;
        i += 1;
      }
      medias.push({ start: m.index, end: i, cond: m[1].trim() });
    }
    const sites: (string | null)[] = [];
    const re = new RegExp(`${token}\\s*:`, "g");
    let d: RegExpExecArray | null;
    while ((d = re.exec(css)) !== null) {
      const host = medias.find((x) => d!.index >= x.start && d!.index < x.end);
      sites.push(host ? host.cond : null);
    }
    return sites;
  }

  it("Hero 的每个 token 在基础块里只定义一次，额外定义只能来自响应式断点", () => {
    for (const token of [
      "--novel-hero-mask",
      "--novel-hero-mask-mobile",
      "--novel-hero-scrim-x",
      "--novel-hero-scrim-y",
      "--novel-hero-scrim-y-mobile",
      "--novel-hero-height",
      "--novel-hero-height-mobile",
      "--novel-hero-banner-height",
      "--novel-hero-banner-w",
      "--novel-hero-banner-gap",
      "--novel-hero-cover-width",
      "--novel-hero-info-width",
    ]) {
      const sites = definitionSites(token);
      const base = sites.filter((c) => c === null);
      const responsive = sites.filter((c) => c !== null);

      expect(base, `${token} 在基础块里应当只定义一次，实际 ${base.length} 次`).toHaveLength(1);
      for (const cond of responsive) {
        expect(cond, `${token} 的额外定义必须来自宽度断点，实际条件是「${cond}」`).toMatch(
          /\bwidth\b/,
        );
      }
    }
  });

  /**
   * 平板档（768–1199）的存在性与自洽。
   *
   * 这一档是 2026-09-20 首屏密度轮补的，修的是一个既有缺陷：在它出现之前
   * banner 宽度在 ≥768 的所有宽度上都写死 1000px，而 768 的视口根本放不下，
   * banner 左右被 Hero 的 overflow-hidden 切掉、连露头都看不见。
   *
   * 断言的是「宽度不再是固定值」这条修复本身，而不是某个具体像素——具体
   * 几何由跨宽度实测把关，写死在这里只会变成第二份需要同步的真源。
   */
  it("平板档存在，且 banner 宽度跟着视口走而不是再写死一个数", () => {
    const band = css.match(
      /@media \(min-width: 768px\) and \(max-width: 1199px\)\s*\{[\s\S]*?\n\}/,
    );
    expect(band, "缺少 768–1199 的平板档").not.toBeNull();
    const body = band![0];
    expect(body).toMatch(/--novel-hero-banner-w:\s*min\(1000px,\s*calc\(100vw - \d+px\)\)/);
    // 高度与封面必须同时覆盖：只改宽度会让桌面档的封面比例落到窄 banner 上
    expect(body).toMatch(/--novel-hero-banner-height:/);
    expect(body).toMatch(/--novel-hero-cover-width:/);
    // Hero 改成显式 pt/pb 排布后，banner 高度一变，Hero 总高必须跟着重算
    expect(body).toMatch(/--novel-hero-height:/);
  });

  it("mask 是渐隐而不是纯色遮罩——纯色压暗消不掉图片的边", () => {
    expect(root["--novel-hero-mask"]).toMatch(/linear-gradient/);
    // 末端必须完全透明，图像才会被溶解掉
    expect(root["--novel-hero-mask"]).toMatch(/rgba\(0,\s*0,\s*0,\s*0\)\s*100%/);
    expect(root["--novel-hero-mask-mobile"]).toMatch(/rgba\(0,\s*0,\s*0,\s*0\)\s*100%/);
  });

  it("纵向压黑末端并入页面底色，Hero 才能无缝长进页面", () => {
    const pageBg = site["--novel-bg"];
    expect(root["--novel-hero-scrim-y"].toLowerCase()).toContain(`${pageBg} 100%`);
    expect(root["--novel-hero-scrim-y-mobile"].toLowerCase()).toContain(`${pageBg} 100%`);
  });

  it("不引入任何 Web Font", () => {
    expect(css).not.toMatch(/@font-face/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import url\(/);
  });
});

describe("设计 token · 纯黑与纯白禁用", () => {
  it("基底不用纯黑", () => {
    expect(isPureBlack(site["--novel-bg"])).toBe(false);
    expect(isPureBlack(readerDark.bg)).toBe(false);
  });

  it("正文不用纯白", () => {
    expect(isPureWhite(site["--novel-fg"])).toBe(false);
    expect(isPureWhite(readerLight.bg)).toBe(false);
    expect(isPureWhite(readerDark.fg)).toBe(false);
  });
});

describe("设计 token · WCAG AA 对比度", () => {
  const textPairs: [string, string, string][] = [
    ["主文本 / 基底", site["--novel-fg"], site["--novel-bg"]],
    ["主文本 / 卡片底", site["--novel-fg"], site["--novel-bg-elevated"]],
    ["主文本 / 抬升底", site["--novel-fg"], site["--novel-bg-raised"]],
    ["次要文本 / 基底", site["--novel-fg-muted"], site["--novel-bg"]],
    ["次要文本 / 卡片底", site["--novel-fg-muted"], site["--novel-bg-elevated"]],
    ["次要文本 / 抬升底", site["--novel-fg-muted"], site["--novel-bg-raised"]],
    ["第三级文本 / 基底", site["--novel-fg-subtle"], site["--novel-bg"]],
    ["第三级文本 / 卡片底", site["--novel-fg-subtle"], site["--novel-bg-elevated"]],
    ["链接色 / 基底", site["--novel-primary"], site["--novel-bg"]],
    ["链接色 / 卡片底", site["--novel-primary"], site["--novel-bg-elevated"]],
    ["主按钮文字 / 纸色填充", site["--novel-on-accent"], site["--novel-accent"]],
    ["主按钮文字 / 纸色悬停", site["--novel-on-accent"], site["--novel-accent-hover"]],
    ["描边按钮文字 / 基底", site["--novel-fg"], site["--novel-bg"]],
    ["下架色 / 基底", site["--novel-danger"], site["--novel-bg"]],
    ["下架色 / 卡片底", site["--novel-danger"], site["--novel-bg-elevated"]],
    ["成功色 / 基底", site["--novel-success"], site["--novel-bg"]],
    ["阅读浅色 正文 / 底", readerLight.fg, readerLight.bg],
    ["阅读浅色 次要 / 底", readerLight.fgMuted, readerLight.bg],
    ["阅读深色 正文 / 底", readerDark.fg, readerDark.bg],
    ["阅读深色 次要 / 底", readerDark.fgMuted, readerDark.bg],
  ];

  it.each(textPairs)("%s 达到正文 4.5:1", (_label, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  const nonTextPairs: [string, string, string][] = [
    ["焦点环 / 基底", site["--novel-focus"], site["--novel-bg"]],
    ["焦点环 / 卡片底", site["--novel-focus"], site["--novel-bg-elevated"]],
    ["交互边界 / 基底", site["--novel-border-strong"], site["--novel-bg"]],
    ["交互边界 / 卡片底", site["--novel-border-strong"], site["--novel-bg-elevated"]],
  ];

  it.each(nonTextPairs)("%s 达到非文本 3:1", (_label, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
  });
});

describe("Hero 文字对比度 · 最坏情况", () => {
  /**
   * 🔴 2026-09-19 结构改向后，这一节的**前提整个换了**，不是改了个数字。
   *
   * 旧前提：文字压在整屏主视觉上，靠左向压黑保证对比度，所以要按「底下是
   * 一张纯白图 + 压黑层最低不透明度 0.9」算最坏情况。
   *
   * 新结构：Hero 主体是居中 banner，正文落在 `--novel-bg-elevated` 这块
   * **完全不透明**的实体面上。底下是什么图与正文对比度**再无关系**——
   * 这不是把门槛调松，而是把「封面亮度影响正文可读性」这整类问题从结构上
   * 消掉了。所以最坏情况就是实体面本身的色值，不需要任何 alpha 合成假设。
   *
   * 左向压黑与纵向压黑仍然保留，但职责只剩「页头叠在 Hero 上仍可读」和
   * 「底部并入页面底色」，不再参与正文对比度，故不在本节断言范围内。
   */
  /** banner 是不透明实体面，最坏情况就是它自己 —— 与底下的图无关。 */
  const BANNER_SURFACE = site["--novel-bg-elevated"];
  const composited = {
    r: parseInt(BANNER_SURFACE.slice(1, 3), 16),
    g: parseInt(BANNER_SURFACE.slice(3, 5), 16),
    b: parseInt(BANNER_SURFACE.slice(5, 7), 16),
  };

  it("左向压黑的起点与文字列内取值确实是我们假设的那两站", () => {
    // 起点必须比文字列内那一站更黑，否则最坏值假设不成立
    expect(root["--novel-hero-scrim-x"]).toMatch(/rgba\(10,\s*12,\s*17,\s*0\.96\)\s*0%/);
    expect(root["--novel-hero-scrim-x"]).toMatch(/rgba\(10,\s*12,\s*17,\s*0\.9\)\s*26%/);
  });

  it("书名色压在纯白图上仍达到 7:1", () => {
    const ratio = contrastRatio(site["--novel-fg-on-media"], composited);
    expect(ratio, `实测 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(7);
  });

  it("简介色压在纯白图上仍达到 7:1", () => {
    const ratio = contrastRatio(site["--novel-fg-muted-on-media"], composited);
    expect(ratio, `实测 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(7);
  });

  it("压在图上的文字比常规前景更亮——底下是不可控图像，不是纯色", () => {
    expect(relativeLuminance(site["--novel-fg-on-media"])).toBeGreaterThan(
      relativeLuminance(site["--novel-fg"]),
    );
    expect(relativeLuminance(site["--novel-fg-muted-on-media"])).toBeGreaterThan(
      relativeLuminance(site["--novel-fg-muted"]),
    );
  });

  it("即便退到纯白底也不用纯白字", () => {
    expect(isPureWhite(site["--novel-fg-on-media"])).toBe(false);
  });

  it("banner 底是不透明实体面，正文对比度不再随封面亮度浮动", () => {
    // 组件用的是 `bg-novel-bg-elevated`（无 alpha 后缀）。这条断言钉的是
    // 「最坏情况等于实体面本身」这个前提：一旦有人给它加回 /90 之类的透明度，
    // 底下的图就会重新参与合成，本节的结论就不再成立。
    const hero = readFileSync(
      resolve(here, "../../src/features/public-ui/home/FeaturedHero.tsx"),
      "utf8",
    );
    expect(hero).toMatch(/bg-novel-bg-elevated(?![/\w-])/);
    // 带 alpha 后缀（bg-novel-bg-elevated/90 之类）就说明底下的图又参与合成了
    expect(hero).not.toMatch(/bg-novel-bg-elevated\//);
  });
});
