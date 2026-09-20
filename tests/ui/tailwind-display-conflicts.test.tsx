import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { BookGrid } from "@/features/public-ui/book/BookGrid";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import {
  MOCK_CATEGORIES,
  MOCK_FEATURED_LIST,
  MOCK_NOVEL_CARDS,
} from "@/features/public-ui/fixtures/mock-content";
import type { NovelCardView } from "@/features/public-ui/types";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * `line-clamp-*` 与 display 工具类的同层冲突守卫。
 *
 * --- 这条用例是被一个真实缺陷换来的（2026-09-20）------------------------------
 * `line-clamp-N` 是靠把 display 设成 `-webkit-box` 生效的。同一个变体前缀里再写
 * 一个 display 工具类（`block` / `hidden` / `flex` …），两者同层，胜负由生成的
 * CSS 顺序决定而不是书写顺序——实测 `block` 赢。赢了之后 `-webkit-line-clamp`
 * 属性**仍然在**（`getComputedStyle` 照样读到 "2"），但没有 `-webkit-box` 就完全
 * 不起作用，**截断静默失效**。
 *
 * 当时的写法是 `hidden ... md:line-clamp-2 md:block`，本意是「窄屏藏起来、
 * md 起显示并截断 2 行」。真实素材 UAT 下越南语简介渲染了 **6 行**。
 *
 * 🔴 为什么整轮单测 + 三个视口的截图都没抓到：`dev-preview` 的 mock 文案本来就
 * 不足 2 行，书卡 mock 更是**没有 summary 字段**，那条分支根本不渲染。
 * 「渲染出来看着对」在这里等于没测——必须有一条与内容长度无关的结构断言。
 *
 * 所以这条用例断言的是**类名组合本身**，不是渲染结果：只要同层同时出现
 * clamp 与 display，就判失败，不管当前 fixture 的文案有多长。
 *
 * 正确写法：display 交给**外层 div**，clamp 留在内层元素上。
 */

const DISPLAY_UTILITIES = new Set([
  "block",
  "inline",
  "inline-block",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "hidden",
  "contents",
  "flow-root",
  "table",
]);

/** 返回该 className 里「同一变体前缀同时有 clamp 与 display」的所有前缀描述。 */
function displayConflicts(className: string): string[] {
  const buckets = new Map<string, string[]>();
  for (const token of className.split(/\s+/).filter(Boolean)) {
    // 变体前缀取最后一个冒号之前的部分；`md:text-[15px]` → md / text-[15px]。
    // 方括号里带冒号的任意值（如 `md:[mask-image:var(--x)]`）会被切歪，但切出来
    // 的 base 既不是 clamp 也不在 display 表里，不会产生误报。
    const at = token.lastIndexOf(":");
    const prefix = at === -1 ? "" : token.slice(0, at);
    const base = at === -1 ? token : token.slice(at + 1);
    buckets.set(prefix, [...(buckets.get(prefix) ?? []), base]);
  }

  const conflicts: string[] = [];
  for (const [prefix, bases] of buckets) {
    const clamps = bases.filter((base) => /^line-clamp-\d+$/.test(base));
    const displays = bases.filter((base) => DISPLAY_UTILITIES.has(base));
    if (clamps.length > 0 && displays.length > 0) {
      conflicts.push(`前缀「${prefix || "(无)"}」: ${clamps.join(" ")} 撞上 ${displays.join(" ")}`);
    }
  }
  return conflicts;
}

/** 扫描整棵渲染结果。用渲染后的 className 而不是源码文本——模板字符串拼出来的
 *  类名（`${mobileOnlyHidden}`）静态扫描抓不到，正是漏掉书卡那处的原因。 */
function scan(container: HTMLElement): string[] {
  const found: string[] = [];
  for (const element of container.querySelectorAll<HTMLElement>("*")) {
    const className = element.getAttribute("class") ?? "";
    for (const conflict of displayConflicts(className)) {
      found.push(`<${element.tagName.toLowerCase()} class="${className}"> — ${conflict}`);
    }
  }
  return found;
}

/** 卡片 mock 没有 summary，这里补上——那条分支不渲染的话就什么也测不到。 */
const CARDS_WITH_SUMMARY: NovelCardView[] = MOCK_NOVEL_CARDS.map((novel) => ({
  ...novel,
  summary:
    "这一段刻意写得很长，长到必然超过任何一档截断上限，" +
    "这样一旦 display 冲突让截断失效，行为差异就是可观察的。",
}));

describe("line-clamp 不与同层 display 工具类共存", () => {
  it("自检：守卫本身能认出冲突写法", () => {
    // 这就是 2026-09-20 修掉的那个写法
    expect(displayConflicts("hidden md:line-clamp-2 md:block md:text-[15px]")).toHaveLength(1);
    expect(displayConflicts("mt-2 line-clamp-3 hidden md:block")).toHaveLength(1);
    // 正确写法：clamp 与 display 分属不同元素 / 不同前缀
    expect(displayConflicts("line-clamp-2 text-[15px] leading-[1.6]")).toHaveLength(0);
    expect(displayConflicts("hidden md:mt-3 md:block")).toHaveLength(0);
    // `line-clamp-none` 是「解除截断」，它本来就该带 display，不算冲突
    expect(displayConflicts("line-clamp-2 md:line-clamp-none")).toHaveLength(0);
  });

  it("首页整棵树（Hero + 首页档网格）没有冲突写法", () => {
    const { container } = render(
      <HomeScreen
        locale={PUBLIC_SITE_LOCALE}
        chrome={mockChrome(PUBLIC_SITE_LOCALE, "home")}
        featuredList={MOCK_FEATURED_LIST.map((novel) => ({ novel, detailHref: "/n" }))}
        novels={CARDS_WITH_SUMMARY}
        categories={MOCK_CATEGORIES}
      />,
    );
    expect(scan(container)).toEqual([]);
  });

  it("聚合页默认档网格没有冲突写法", () => {
    const { container } = render(
      <BookGrid locale={PUBLIC_SITE_LOCALE} novels={CARDS_WITH_SUMMARY} />,
    );
    expect(scan(container)).toEqual([]);
  });

  it("首页紧凑档网格没有冲突写法——真实缺陷就藏在这一档", () => {
    const { container } = render(
      <BookGrid locale={PUBLIC_SITE_LOCALE} novels={CARDS_WITH_SUMMARY} variant="home" />,
    );
    expect(scan(container)).toEqual([]);
  });
});
