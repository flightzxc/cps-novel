"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent } from "react";
import type { SiteTag } from "@/features/public-ui/types";
import { useT } from "@/lib/locale/messages/MessagesProvider";

/**
 * 首页题材导航（PN-16，Owner 2026-10-08 拍板：桌面单行 + 左右箭头，手机不动）。
 *
 * --- 为什么要有这个组件 ----------------------------------------------------
 * 分类数量由上游内容决定（英语 55 个）。桌面端原先 `md:flex-wrap` 换行，55 个标签排成
 * 6 行，把作品区推到首屏以外。手机端早就是单行横滑，没有这个问题。
 * 只照 CPS 改成单行不够：CPS 没有箭头，桌面鼠标用户要靠 Shift+滚轮才够得到后面的分类。
 * 所以桌面单行之外，溢出时在两端放箭头，点一次翻约一屏。
 *
 * --- 布局（手机逐类名不变）-------------------------------------------------
 * `<nav>` 仍是滚动视口本身，**不带 md: 前缀的类名与改前逐字相同**（含 `mb-4`）；
 * 桌面只是把 `md:flex-wrap md:overflow-x-visible` 去掉，让 `flex-nowrap overflow-x-auto`
 * 在所有宽度都生效。外层包一层只有 `md:` 前缀类名的容器，手机下它是普通块级 div，
 * 布局零影响；桌面下它是一行 flex：[上一组] [nav] [下一组]。
 *
 * 🔴 `-mx-5 px-5` 这一对是承重的（原注释搬来）：`Container` 移动端是 `px-5`，负外边距把滚动
 * 视口撑回视口满宽，`px-5` 再把**内容**推回原来的左边距。少了负外边距，最后一个标签会停在容器
 * 内边距处、看不出"还能滑"；少了 `px-5`，第一个标签会贴死屏幕边缘。两个值必须跟 `Container`
 * 的移动端内边距一致，改那边要回来同步。桌面这一对换成 `md:-mx-1 md:px-1`（见下面焦点环一段）。标签必须 `shrink-0`，
 * 否则 flex 会把它们压扁塞进一行，既不溢出也就不会滚动。滚动条隐藏，`overscroll-x-contain`
 * 防止滑到尽头时触发浏览器的返回手势。
 *
 * 🔴 箭头是 nav 的**兄弟**，在文档流里占位，不叠在标签上——叠在上面的话，被箭头盖住的
 * 那一截标签点不到（要求：箭头不能挡住标签的点击区域）。代价是溢出时两端各让出
 * 一个箭头的宽度；两端槽位同时出现、同时消失，所以到头时不会因为箭头消失而让标签跳位。
 * 手机下箭头 `hidden`（`md:inline-flex` 才显示），display:none 同时把它们移出 Tab 序和读屏树。
 *
 * --- 箭头状态 --------------------------------------------------------------
 * - 不溢出（scrollWidth - clientWidth ≤ 1px）：两个箭头都不渲染。
 * - 溢出且在起始端：上一组 `disabled`，下一组可用；在末端反之；中间都可用。
 * 到头选择「禁用」而不是「卸载」：卸载一个正持有焦点的按钮会让焦点掉到 <body>，
 * 键盘用户连点到头后就迷路了；禁用则焦点位置保持，视觉上也左右对称。
 * 首次渲染（含服务端）不渲染箭头，水合后在布局副作用里量一次再决定——所以服务端 HTML 与
 * 客户端首次渲染一致，不会水合不匹配；箭头出现只改变横向宽度，标签栏高度始终是一行。
 *
 * --- 从右到左（RTL）-------------------------------------------------------
 * 方向有三处，全部「跟 dir 走」，不写死物理左右：
 *   1. 箭头摆放：DOM 顺序是 [上一组][nav][下一组]，flex 行在 `dir=rtl` 下自动镜像，
 *      上一组落在右（起始侧）、下一组落在左（末端侧）。
 *   2. 箭头图形：与 `Pagination` 同款 chevron + `rtl:-scale-x-100`，「向前」在从右到左时朝左。
 *   3. 滚动：见下。
 *
 * 🔴 scrollLeft 的符号约定各浏览器历史上不同（标准：RTL 下起始端 = 0、向末端滚是负数；
 * 旧 Chrome<85 / 旧 Safari：起始端是最大正值；IE/旧 Edge：起始端 0、向末端为正）。
 * 这里不去探测、不依赖符号，只用两条与约定无关的做法：
 *   - **移动**用 `scrollBy({ left })`——它是相对当前位置的**物理**位移（正数 = 内容向左走、
 *     视口向右看），不读 scrollLeft。所以「下一组」= LTR 取 +、RTL 取 −，仅此而已。
 *   - **判边**用 `Math.abs(scrollLeft)` 作为「离起始端的距离」：标准约定（≤0）与
 *     IE/旧 Edge 约定（≥0）下它都等于离起始端的距离。旧 WebKit 那种「起始端是最大正值」的
 *     约定在 Next 16 的浏览器基线（Chrome/Edge/Firefox 111+、Safari 16.4+）之外，
 *     不为它加探测代码。
 * 方向在**点击时**读 `closest("[dir]")`（与 `FeaturedHero` 的键盘翻转同一套口径）：`<html dir>`
 * 会在语言软跳转后被 `DocumentLocaleSync` 改写，渲染期快照会过期；也不用 getComputedStyle——
 * jsdom 不实现 dir 的继承，测试里恒为 ltr。
 *
 * --- 键盘与焦点 ------------------------------------------------------------
 * 箭头是 `<button type="button">`，带 aria-label 与 aria-controls；每个标签仍是真 `<a href>`，
 * 不加 tabIndex，Tab 序为 [上一组] → 全部标签 → [下一组]。标签获得焦点时，浏览器本身会
 * 把它滚进视野，这里再用 `scrollIntoView({ block/inline: "nearest" })` 显式兜一次：保证最小位移
 * 就位，且有测试钉住。
 *
 * 🔴 焦点环不能被 nav 裁掉：全站焦点样式（`globals.css` 的 `:where(.site, .reader) :focus-visible`，
 * 2px 实线 + 2px 偏移，即向外 4px）写在**无层**样式里，Tailwind 工具类在 `@layer utilities`
 * 里，层叠上永远赢不过它——所以在标签上写 `focus-visible:outline-offset-*` 是无效的（浏览器
 * 验收实测计算值仍是 2px）。nav 是 overflow 容器，会把环裁在它的 padding 盒之外，
 * 桌面单行时上下沿和首个标签的起始沿都在边上。解法是桌面给 nav 一圈 4px 内边距
 * （`md:px-1 md:py-1`）正好容下这圈环，再用等量负外边距（`md:-mx-1 md:-mt-1 md:-mb-1`）
 * 抵消，标签栏的外形尺寸、箭头间距、标签起点位置都与没有这圈内边距时逐像素一致。
 * 手机的内边距与负外边距不动（手机本来就有 `px-5`，只是上下沿同样会被裁——既有行为，本单不改）。
 * 分类栏不自动滚动：只有用户滚动、点箭头、键盘聚焦时才会动。
 */

/** 点一次箭头滚动的距离占可视宽度的比例：约一屏，留出 20% 让读者认得上下文。 */
export const CATEGORY_SCROLL_RATIO = 0.8;

/**
 * 边界容差（px）。scrollLeft 在高 DPI / 页面缩放下可能是小数，而 scrollWidth /
 * clientWidth 是取整的，「恰好到头」时两边会差不到 1px。
 */
const EDGE_EPSILON = 1;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export interface CategoryScrollState {
  /** 内容比视口宽，需要箭头。 */
  overflowing: boolean;
  /** 起始端之后还有内容被卷出（上一组可用）。 */
  canPrev: boolean;
  /** 末端之前还有内容没露出（下一组可用）。 */
  canNext: boolean;
}

const NO_OVERFLOW: CategoryScrollState = { overflowing: false, canPrev: false, canNext: false };

/**
 * 由三个几何量推出箭头状态。纯函数，不碰 DOM，方向无关：
 * `Math.abs(scrollLeft)` 是离**起始端**的距离（LTR 起始端在左，RTL 在右），见组件头部注释。
 */
export function readCategoryScrollState(metrics: {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}): CategoryScrollState {
  const max = metrics.scrollWidth - metrics.clientWidth;
  if (max <= EDGE_EPSILON) {
    return NO_OVERFLOW;
  }
  const fromStart = Math.min(Math.abs(metrics.scrollLeft), max);
  return {
    overflowing: true,
    canPrev: fromStart > EDGE_EPSILON,
    canNext: max - fromStart > EDGE_EPSILON,
  };
}

function isRtl(element: Element): boolean {
  return element.closest("[dir]")?.getAttribute("dir")?.toLowerCase() === "rtl";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

const ARROW_BASE =
  "relative hidden w-[2.125rem] shrink-0 items-center justify-center rounded-full border border-novel-border " +
  "text-novel-fg-muted transition-colors before:absolute before:-inset-[5px] " +
  "hover:border-novel-primary hover:text-novel-primary " +
  "disabled:pointer-events-none disabled:opacity-40 md:inline-flex";

function ArrowButton({
  direction,
  label,
  controls,
  disabled,
  onClick,
}: {
  direction: "prev" | "next";
  label: string;
  controls: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-controls={controls}
      disabled={disabled}
      onClick={onClick}
      data-testid={`home-category-${direction}`}
      className={ARROW_BASE}
    >
      <svg
        aria-hidden="true"
        className="h-4 w-4 rtl:-scale-x-100"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d={direction === "prev" ? "M15 19l-7-7 7-7" : "M9 5l7 7-7 7"}
        />
      </svg>
    </button>
  );
}

export function CategoryNav({ categories }: { categories: readonly SiteTag[] }) {
  const t = useT();
  const navId = useId();
  const navRef = useRef<HTMLElement>(null);
  const [scroll, setScroll] = useState<CategoryScrollState>(NO_OVERFLOW);

  const sync = useCallback(() => {
    const nav = navRef.current;
    if (!nav) {
      return;
    }
    const next = readCategoryScrollState(nav);
    // 三个布尔都没变就返回原对象，React 会跳过这次渲染——滚动事件一秒几十次。
    setScroll((prev) =>
      prev.overflowing === next.overflowing &&
      prev.canPrev === next.canPrev &&
      prev.canNext === next.canNext
        ? prev
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) {
      return;
    }
    sync();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", sync);
      return () => window.removeEventListener("resize", sync);
    }
    // 观察 nav 本身（窗口缩放、箭头出现挤窄视口）和每个标签（网页字体换入后标签变宽，
    // nav 的盒子没变、scrollWidth 变了，只观察 nav 会漏掉）。
    const observer = new ResizeObserver(sync);
    observer.observe(nav);
    for (const chip of Array.from(nav.children)) {
      observer.observe(chip);
    }
    return () => observer.disconnect();
  }, [categories, sync]);

  function scrollPage(direction: "prev" | "next") {
    const nav = navRef.current;
    if (!nav) {
      return;
    }
    const forward = direction === "next" ? 1 : -1;
    // 物理位移：LTR 下「向前」= 向右（+），RTL 下「向前」= 向左（−）。
    const physical = isRtl(nav) ? -forward : forward;
    nav.scrollBy({
      left: physical * Math.round(nav.clientWidth * CATEGORY_SCROLL_RATIO),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }

  function onFocus(event: FocusEvent<HTMLElement>) {
    if (event.target === event.currentTarget) {
      return;
    }
    (event.target as HTMLElement).scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  return (
    <div data-testid="home-category-strip" className="md:mb-5 md:flex md:items-stretch md:gap-2">
      {scroll.overflowing ? (
        <ArrowButton
          direction="prev"
          label={t("pagination.previous")}
          controls={navId}
          disabled={!scroll.canPrev}
          onClick={() => scrollPage("prev")}
        />
      ) : null}
      <nav
        ref={navRef}
        id={navId}
        aria-label="Browse by category"
        data-testid="home-category-nav"
        onScroll={sync}
        onFocus={onFocus}
        className={
          "-mx-5 mb-4 flex flex-nowrap gap-2 overflow-x-auto overscroll-x-contain px-5 " +
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
          "md:-mx-1 md:-mt-1 md:-mb-1 md:min-w-0 md:flex-1 md:px-1 md:py-1"
        }
      >
        {categories.map((category) => (
          <a
            key={category.slug}
            href={category.href}
            className="shrink-0 rounded-full border border-novel-border px-3 py-1.5 text-sm whitespace-nowrap text-novel-fg-muted transition-colors hover:border-novel-primary hover:text-novel-primary"
          >
            {category.label}
          </a>
        ))}
      </nav>
      {scroll.overflowing ? (
        <ArrowButton
          direction="next"
          label={t("pagination.next")}
          controls={navId}
          disabled={!scroll.canNext}
          onClick={() => scrollPage("next")}
        />
      ) : null}
    </div>
  );
}
