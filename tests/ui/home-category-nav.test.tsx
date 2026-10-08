import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MOCK_CATEGORIES, MOCK_NOVEL_CARDS } from "@/features/public-ui/fixtures/mock-content";
import {
  CATEGORY_SCROLL_RATIO,
  CategoryNav,
  readCategoryScrollState,
} from "@/features/public-ui/home/CategoryNav";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import type { SiteTag } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { CATALOGS, loadMessages } from "@/lib/locale/messages";
import { MessagesProvider } from "@/lib/locale/messages/MessagesProvider";
import { renderWithMessages } from "./render-with-messages";

/**
 * PN-16 · 桌面首页题材导航：单行横向滚动 + 溢出箭头（Owner 2026-10-08）。
 *
 * jsdom 没有布局引擎，`scrollWidth / clientWidth / scrollLeft` 恒为 0。这里把这三个量
 * 垫在 `HTMLElement.prototype` 上、只对题材导航这一个元素生效，由用例按场景设值；
 * 箭头状态在挂载时量一次（布局副作用）、之后每次 `scroll` / `resize` 事件再量。
 * `scrollBy` 同样是 jsdom 没有的，换成 mock 来断言「往哪边、滚多少、什么节奏」。
 *
 * 真实的几何（一行高度、点击后 scrollLeft 的变化、RTL 下的符号约定）在浏览器验收里取，
 * 这里钉的是决策逻辑与类名契约。
 */

const NAV_TESTID = "home-category-nav";

/** 55 个分类，对应审计里英语首页的真实规模。 */
const MANY: SiteTag[] = Array.from({ length: 55 }, (_, i) => ({
  slug: `c${i}`,
  label: `Category ${i}`,
  href: `/category/c${i}`,
}));

const metrics = { scrollWidth: 0, clientWidth: 0, scrollLeft: 0 };
const scrollBy = vi.fn();
const scrollIntoView = vi.fn();

type Metric = keyof typeof metrics;

function setMetrics(next: Partial<typeof metrics>) {
  Object.assign(metrics, next);
}

/** 内容 3000、视口 1000 → 最大可滚 2000。 */
const OVERFLOW = { scrollWidth: 3000, clientWidth: 1000 };
const MAX = OVERFLOW.scrollWidth - OVERFLOW.clientWidth;
const PAGE = Math.round(OVERFLOW.clientWidth * CATEGORY_SCROLL_RATIO);

beforeEach(() => {
  setMetrics({ scrollWidth: 0, clientWidth: 0, scrollLeft: 0 });
  scrollBy.mockClear();
  scrollIntoView.mockClear();
  for (const key of ["scrollWidth", "clientWidth", "scrollLeft"] as Metric[]) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === NAV_TESTID ? metrics[key] : 0;
      },
      set() {},
    });
  }
  Object.defineProperty(HTMLElement.prototype, "scrollBy", {
    configurable: true,
    writable: true,
    value: scrollBy,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  for (const key of ["scrollWidth", "clientWidth", "scrollLeft", "scrollBy", "scrollIntoView"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("dir");
  document.documentElement.removeAttribute("lang");
});

function nav() {
  return screen.getByTestId(NAV_TESTID);
}

function arrows() {
  return {
    prev: screen.queryByRole("button", { name: "Previous" }) as HTMLButtonElement | null,
    next: screen.queryByRole("button", { name: "Next" }) as HTMLButtonElement | null,
  };
}

/** 改完几何量后触发一次 scroll，等价于用户滚动后浏览器派发的事件。 */
function scrollTo(scrollLeft: number) {
  setMetrics({ scrollLeft });
  fireEvent.scroll(nav());
}

function renderNav(ui = <CategoryNav categories={MANY} />) {
  return renderWithMessages(ui);
}

describe("1 · 箭头的出现与禁用", () => {
  it("不溢出：两个箭头都不渲染", () => {
    setMetrics({ scrollWidth: 1000, clientWidth: 1000 });
    renderNav();

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("差 1px 以内的亚像素溢出不算溢出（scrollWidth/clientWidth 是取整的）", () => {
    setMetrics({ scrollWidth: 1001, clientWidth: 1000 });
    renderNav();

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("溢出且在最左：上一组禁用，只有下一组可点", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    const { prev, next } = arrows();
    expect(prev).not.toBeNull();
    expect(next).not.toBeNull();
    expect(prev!.disabled).toBe(true);
    expect(next!.disabled).toBe(false);
  });

  it("中间位置：两个箭头都可点", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 700 });
    renderNav();

    const { prev, next } = arrows();
    expect(prev!.disabled).toBe(false);
    expect(next!.disabled).toBe(false);
  });

  it("最右：下一组禁用，只有上一组可点", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: MAX });
    renderNav();

    const { prev, next } = arrows();
    expect(prev!.disabled).toBe(false);
    expect(next!.disabled).toBe(true);
  });

  it("滚动过程中状态跟着变：最左 → 中间 → 最右 → 回到最左", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    expect(arrows().prev!.disabled).toBe(true);
    expect(arrows().next!.disabled).toBe(false);

    scrollTo(900);
    expect(arrows().prev!.disabled).toBe(false);
    expect(arrows().next!.disabled).toBe(false);

    scrollTo(MAX);
    expect(arrows().prev!.disabled).toBe(false);
    expect(arrows().next!.disabled).toBe(true);

    scrollTo(0);
    expect(arrows().prev!.disabled).toBe(true);
    expect(arrows().next!.disabled).toBe(false);
  });

  it("高 DPI 的小数 scrollLeft：差 1px 以内算到头", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: MAX - 0.5 });
    renderNav();
    expect(arrows().next!.disabled).toBe(true);

    scrollTo(0.5);
    expect(arrows().prev!.disabled).toBe(true);
  });

  it("到头只禁用、不卸载：键盘用户连点到头时焦点所在的按钮还在 DOM 里", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 1200 });
    renderNav();

    const nextBefore = arrows().next!;
    nextBefore.focus();
    scrollTo(MAX);

    expect(arrows().next).toBe(nextBefore);
    expect(nextBefore.disabled).toBe(true);
    expect(document.activeElement).toBe(nextBefore);
  });

  it("窗口缩放后重新判断（没有 ResizeObserver 时退回 window resize）", () => {
    setMetrics({ scrollWidth: 1000, clientWidth: 1000 });
    renderNav();
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    setMetrics(OVERFLOW);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryAllByRole("button")).toHaveLength(2);

    setMetrics({ scrollWidth: 800, clientWidth: 800 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("有 ResizeObserver 时观察 nav 和每一个标签（网页字体换入后标签变宽，nav 盒子没变）", () => {
    const observed: Element[] = [];
    let notify: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    setMetrics({ scrollWidth: 1000, clientWidth: 1000 });
    renderNav();

    expect(observed).toContain(nav());
    for (const chip of Array.from(nav().querySelectorAll("a"))) {
      expect(observed).toContain(chip);
    }
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    setMetrics(OVERFLOW);
    act(() => notify());
    expect(screen.queryAllByRole("button")).toHaveLength(2);
  });

  it("纯函数：RTL 标准约定（0 → 负数）与 LTR（0 → 正数）给出同一套边界判断", () => {
    const at = (scrollLeft: number) => readCategoryScrollState({ ...OVERFLOW, scrollLeft });

    for (const sign of [1, -1]) {
      expect(at(sign * 0)).toEqual({ overflowing: true, canPrev: false, canNext: true });
      expect(at(sign * 600)).toEqual({ overflowing: true, canPrev: true, canNext: true });
      expect(at(sign * MAX)).toEqual({ overflowing: true, canPrev: true, canNext: false });
    }
  });
});

describe("2 · 点击翻页（从左到右）", () => {
  it("下一组：向右（+）滚约一屏，平滑", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    fireEvent.click(arrows().next!);

    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({ left: PAGE, behavior: "smooth" });
    expect(PAGE).toBeGreaterThan(0);
  });

  it("上一组：向左（−）滚约一屏，平滑", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 1200 });
    renderNav();

    fireEvent.click(arrows().prev!);

    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({ left: -PAGE, behavior: "smooth" });
  });

  it("幅度跟着可视宽度走：clientWidth × 比例，取整，且不超过一屏", () => {
    setMetrics({ scrollWidth: 5000, clientWidth: 1234, scrollLeft: 0 });
    renderNav();

    fireEvent.click(arrows().next!);

    const { left } = scrollBy.mock.calls[0][0] as { left: number };
    expect(left).toBe(Math.round(1234 * CATEGORY_SCROLL_RATIO));
    expect(left).toBeLessThanOrEqual(1234);
    expect(left).toBeGreaterThan(1234 / 2);
  });

  it("用户偏好减少动效：不做平滑，直接跳（behavior: auto）", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    );
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    fireEvent.click(arrows().next!);

    expect(scrollBy).toHaveBeenCalledWith({ left: PAGE, behavior: "auto" });
  });

  it("不会自动滚动：挂载、重新量尺寸都不调用 scrollBy", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();
    scrollTo(500);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(scrollBy).not.toHaveBeenCalled();
  });
});

describe("3 · 从右到左：箭头与滚动方向镜像", () => {
  function renderRtl() {
    return renderNav(
      <div dir="rtl">
        <CategoryNav categories={MANY} />
      </div>,
    );
  }

  it("下一组（向前）在 RTL 下向左（−）滚，上一组向右（+）", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: -1200 });
    renderRtl();

    fireEvent.click(arrows().next!);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -PAGE, behavior: "smooth" });

    fireEvent.click(arrows().prev!);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: PAGE, behavior: "smooth" });
  });

  it("幅度与 LTR 相同，只是符号相反", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: -1200 });
    renderRtl();

    fireEvent.click(arrows().next!);
    fireEvent.click(arrows().prev!);

    const [nextCall, prevCall] = scrollBy.mock.calls.map(([arg]) => (arg as { left: number }).left);
    expect(nextCall).toBe(-PAGE);
    expect(prevCall).toBe(PAGE);
  });

  it("RTL 的 scrollLeft 是 0 → 负数：0 是起始端（上一组禁用），负的最大值是末端（下一组禁用）", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderRtl();
    expect(arrows().prev!.disabled).toBe(true);
    expect(arrows().next!.disabled).toBe(false);

    scrollTo(-700);
    expect(arrows().prev!.disabled).toBe(false);
    expect(arrows().next!.disabled).toBe(false);

    scrollTo(-MAX);
    expect(arrows().prev!.disabled).toBe(false);
    expect(arrows().next!.disabled).toBe(true);

    scrollTo(0);
    expect(arrows().prev!.disabled).toBe(true);
    expect(arrows().next!.disabled).toBe(false);
  });

  it("方向取点击当下的 dir，不取渲染时的快照（语言软跳转后 <html dir> 才被改写）", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    fireEvent.click(arrows().next!);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: PAGE, behavior: "smooth" });

    document.documentElement.setAttribute("dir", "rtl");
    fireEvent.click(arrows().next!);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -PAGE, behavior: "smooth" });

    document.documentElement.setAttribute("dir", "ltr");
    fireEvent.click(arrows().next!);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: PAGE, behavior: "smooth" });
  });

  it("箭头图形：两枚都带 rtl:-scale-x-100，且没有无前缀的变换类（LTR 不变）", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 700 });
    renderRtl();

    for (const button of [arrows().prev!, arrows().next!]) {
      const icon = button.querySelector("svg")!;
      expect(icon.classList.contains("rtl:-scale-x-100")).toBe(true);
      const unconditional = Array.from(icon.classList).filter((token) =>
        /^-?(?:scale|rotate|translate|skew)(?:-|$)/.test(token),
      );
      expect(unconditional).toEqual([]);
    }
  });

  it("箭头位置靠 DOM 顺序 + flex 行随 dir 镜像：[上一组][nav][下一组]，不写任何物理左右类", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 700 });
    renderRtl();

    const strip = screen.getByTestId("home-category-strip");
    expect(Array.from(strip.children)).toEqual([arrows().prev, nav(), arrows().next]);

    const physical = /^(?:[a-z0-9[\]&>:_-]+:)*-?(?:(?:left|right|ml|mr|pl|pr)-|text-(?:left|right)$|border-[lr](?:-|$)|rounded-(?:l|r|tl|tr|bl|br)(?:-|$))/;
    for (const element of [strip, arrows().prev!, arrows().next!]) {
      expect(Array.from(element.classList).filter((token) => physical.test(token))).toEqual([]);
    }
  });

  it("首页整合：阿拉伯语首页（DocumentLocaleSync 把 <html dir> 设成 rtl）下，下一组向左，标签是阿拉伯语 aria-label", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    render(<HomeScreen locale="ar" novels={MOCK_NOVEL_CARDS} categories={MANY} />);

    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    const ar = loadMessages("ar").pagination;
    const next = screen.getByRole("button", { name: ar.next });
    const prev = screen.getByRole("button", { name: ar.previous });

    fireEvent.click(next);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -PAGE, behavior: "smooth" });
    expect((prev as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("4 · 可访问性", () => {
  it("箭头是 <button type=button>，带 aria-label，并用 aria-controls 指向滚动区", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 700 });
    renderNav();

    const { prev, next } = arrows();
    for (const button of [prev!, next!]) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("aria-label")).toBeTruthy();
      expect(button.getAttribute("aria-controls")).toBe(nav().id);
      // 图形只是装饰，名字全靠 aria-label
      expect(button.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    }
    expect(nav().id).not.toBe("");
  });

  it("aria-label 复用现有的 pagination.previous / pagination.next，15 个语种都用各自的现成译文（不新增文案键）", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 700 });
    const locales = Object.keys(CATALOGS) as SiteLocale[];
    expect(locales).toHaveLength(15);

    for (const locale of locales) {
      const messages = loadMessages(locale);
      const { unmount } = render(
        <MessagesProvider locale={locale} messages={messages}>
          <CategoryNav categories={MANY} />
        </MessagesProvider>,
      );
      const labels = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
      expect(labels, locale).toEqual([messages.pagination.previous, messages.pagination.next]);
      for (const label of labels) {
        expect(label, locale).toBeTruthy();
      }
      unmount();
    }
  });

  it("Tab 序：[上一组] → 全部标签 → [下一组]；标签都是带 href 的 <a>，没有 tabindex，箭头也没有", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 700 });
    renderNav();

    const strip = screen.getByTestId("home-category-strip");
    const focusable = Array.from(strip.querySelectorAll<HTMLElement>("a, button"));
    expect(focusable).toHaveLength(MANY.length + 2);
    expect(focusable[0]).toBe(arrows().prev);
    expect(focusable[focusable.length - 1]).toBe(arrows().next);
    for (const element of focusable) {
      expect(element.hasAttribute("tabindex"), element.outerHTML).toBe(false);
    }
    const chips = Array.from(nav().querySelectorAll("a"));
    expect(chips).toHaveLength(MANY.length);
    chips.forEach((chip, index) => {
      expect(chip.getAttribute("href")).toBe(MANY[index].href);
    });
  });

  it("标签获得焦点时就近滚进可视区（block/inline: nearest）", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    const far = nav().querySelectorAll("a")[40] as HTMLElement;
    far.focus();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(far);
  });

  it("箭头不挡标签：它们是 nav 的兄弟、在文档流里占位，不用 absolute / fixed / sticky 叠在标签上", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 700 });
    renderNav();

    for (const button of [arrows().prev!, arrows().next!]) {
      expect(nav().contains(button)).toBe(false);
      expect(button.parentElement).toBe(screen.getByTestId("home-category-strip"));
      // 按钮本身不脱离文档流。`before:absolute` 是撑大点击区的伪元素，下一条单独约束它的外扩量。
      const overlay = Array.from(button.classList).filter((token) =>
        /^(?:md:)?(?:absolute|fixed|sticky)$/.test(token),
      );
      expect(overlay).toEqual([]);
    }
  });

  it("点击区外扩（约 44px 目标）只外扩 5px，小于箭头与标签之间的 gap-2（8px）——伸不到标签上", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 700 });
    renderNav();

    const strip = screen.getByTestId("home-category-strip");
    expect(strip.classList.contains("md:gap-2")).toBe(true);
    const gap = 0.5 * 16; // gap-2 = 0.5rem

    for (const button of [arrows().prev!, arrows().next!]) {
      const inset = Array.from(button.classList)
        .map((token) => /^before:-inset-\[(\d+)px\]$/.exec(token))
        .find(Boolean);
      expect(inset, "箭头应当用 before:-inset-[Npx] 撑大点击区").toBeTruthy();
      expect(Number(inset![1])).toBeGreaterThan(0);
      expect(Number(inset![1])).toBeLessThan(gap);
    }
  });

  it("手机上箭头是 display:none（hidden，md:inline-flex 才显示）——移出 Tab 序与读屏树", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 700 });
    renderNav();

    for (const button of [arrows().prev!, arrows().next!]) {
      const cls = button.className.split(/\s+/);
      expect(cls).toContain("hidden");
      expect(cls).toContain("md:inline-flex");
    }
  });
});

describe("5 · 手机布局不变", () => {
  /** 改前 nav 上不带 md: 前缀的全部类名（取自 76128ea 的 HomeScreen.tsx）。 */
  const MOBILE_NAV_CLASSES_BEFORE = [
    "-mx-5",
    "mb-4",
    "flex",
    "flex-nowrap",
    "gap-2",
    "overflow-x-auto",
    "overscroll-x-contain",
    "px-5",
    "[scrollbar-width:none]",
    "[&::-webkit-scrollbar]:hidden",
  ];
  /** 改前标签 <a> 上不带 md: 前缀的全部类名。 */
  const MOBILE_CHIP_CLASSES_BEFORE = [
    "shrink-0",
    "rounded-full",
    "border",
    "border-novel-border",
    "px-3",
    "py-1.5",
    "text-sm",
    "whitespace-nowrap",
    "text-novel-fg-muted",
    "transition-colors",
    "hover:border-novel-primary",
    "hover:text-novel-primary",
  ];

  const unprefixed = (element: Element) =>
    Array.from(element.classList)
      .filter((token) => !token.startsWith("md:"))
      .sort();

  it("nav 上不带 md: 前缀的类名与改前逐个相同", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    expect(unprefixed(nav())).toEqual([...MOBILE_NAV_CLASSES_BEFORE].sort());
  });

  it("每个标签上不带 md: 前缀的类名与改前逐个相同", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    const chips = Array.from(nav().querySelectorAll("a"));
    expect(chips).toHaveLength(MANY.length);
    for (const chip of chips) {
      expect(unprefixed(chip)).toEqual([...MOBILE_CHIP_CLASSES_BEFORE].sort());
    }
  });

  it("新增的外层容器只有 md: 前缀的类名——手机下是普通块级 div，不产生任何布局", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    const strip = screen.getByTestId("home-category-strip");
    expect(strip.tagName).toBe("DIV");
    const classes = Array.from(strip.classList);
    expect(classes.length).toBeGreaterThan(0);
    for (const token of classes) {
      expect(token.startsWith("md:"), `外层容器出现了手机也生效的类名「${token}」`).toBe(true);
    }
    expect(strip.hasAttribute("style")).toBe(false);
  });

  it("桌面只加不改：nav 的 md: 类名是 弹性占满 + 一圈 4px 内边距（容下焦点环）与等量负外边距，没有换行或溢出可见", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    const desktop = Array.from(nav().classList)
      .filter((token) => token.startsWith("md:"))
      .sort();
    expect(desktop).toEqual([
      "md:-mb-1",
      "md:-mt-1",
      "md:-mx-1",
      "md:flex-1",
      "md:min-w-0",
      "md:px-1",
      "md:py-1",
    ]);
  });

  it("标签的数据、顺序、链接原样：文字与 href 与传入一致，nav 的 aria-label 不变", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    renderNav();

    const chips = Array.from(nav().querySelectorAll("a"));
    expect(chips.map((chip) => chip.textContent)).toEqual(MANY.map((tag) => tag.label));
    expect(chips.map((chip) => chip.getAttribute("href"))).toEqual(MANY.map((tag) => tag.href));
    expect(nav().getAttribute("aria-label")).toBe("Browse by category");
    expect(nav().tagName).toBe("NAV");
  });
});

describe("6 · 首页整合", () => {
  it("HomeScreen 把题材导航放进浏览区，溢出时出现箭头；没有分类时整块不渲染", () => {
    setMetrics({ ...OVERFLOW, scrollLeft: 0 });
    const { unmount } = render(
      <HomeScreen locale="en" novels={MOCK_NOVEL_CARDS} categories={MANY} />,
    );

    const browse = screen.getByTestId("home-browse");
    expect(browse.contains(screen.getByTestId("home-category-strip"))).toBe(true);
    expect(arrows().next).not.toBeNull();
    unmount();

    render(<HomeScreen locale="en" novels={MOCK_NOVEL_CARDS} categories={[]} />);
    expect(screen.queryByTestId("home-category-strip")).toBeNull();
    expect(screen.queryByTestId(NAV_TESTID)).toBeNull();
  });

  it("分类少、没有溢出时（夹具 4 个）首页不显示任何箭头", () => {
    setMetrics({ scrollWidth: 600, clientWidth: 600 });
    render(<HomeScreen locale="en" novels={MOCK_NOVEL_CARDS} categories={MOCK_CATEGORIES} />);

    expect(screen.queryAllByRole("button", { name: /^(Previous|Next)$/ })).toHaveLength(0);
  });
});
