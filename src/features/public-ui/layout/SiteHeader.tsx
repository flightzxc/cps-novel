"use client";

import { useEffect, useId, useRef, useState } from "react";
import { BrandLockup } from "@/components/BrandMark";
import { Container } from "@/components/Container";
import type { NavItem } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { useT } from "@/lib/locale/messages/MessagesProvider";
import { LocaleSwitcher } from "./LocaleSwitcher";

/** 页头高度（h-16）。overlay 模式下滚过这个距离就落回实底。 */
const HEADER_HEIGHT_PX = 64;

/**
 * 页头。恒在站点作用域（深色），不随阅读器主题翻转。
 *
 * 导航项由调用方注入——**URL 结构尚未冻结，组件不自行决定任何永久路由**。
 *
 * 刻意没有的东西：账户入口、应用下载。
 * 语言入口是可选的：首发语种白名单尚未定案，只有一个语种时不渲染该入口。
 *
 * 站内搜索入口（PN-15）：由调用方传 `searchHref`，**有值才渲染**——后台开关关闭时
 * `chromeFromSiteSetting` 不给这个字段，页头里就没有任何搜索入口。它不进 `navItems`
 * （不改变 `navItems` 的形状），三处呈现：
 *
 * - 手机（< md）：页头右侧一个 44×44 的放大镜按钮，与菜单开关等大、间距 4px；
 * - 手机菜单面板：「首页 / 全部作品 / 搜索 / 语种」每行最小高 52px；
 * - 平板/桌面（≥ md）：导航里的第三项「放大镜 + 文字」。
 *
 * 手机页头方案 A（Owner 2026-10-09）：手机页头一行只有站标 + 两个等大按钮，语种按钮移进菜单面板
 * （`LocaleSwitcher` 的 `menuRow` 形态，列表与胶囊下拉同一份）。两个按钮 `shrink-0`，
 * 任何语种、任何文案长度都不会被压缩。
 */
export function SiteHeader({
  brandHref = "/",
  brandName,
  navItems = [],
  overlay = false,
  activeLocales = [],
  searchHref,
  searchCurrent = false,
}: {
  brandHref?: string;
  /** 站点品牌名。缺失或空白时 `BrandLockup` 回落到占位符。 */
  brandName?: string;
  navItems?: NavItem[];
  /**
   * 浮在主视觉 Hero 之上：无底色、无毛玻璃、无分隔线，仅靠 Hero 的纵向压黑保证可读。
   * 滚出 Hero 后自动恢复底色与分隔线。不传时行为与普通页头完全一致。
   */
  overlay?: boolean;
  /**
   * L10N P4：动态层 `getActiveLocales()` 结果，透传给 `LocaleSwitcher`。
   * 缺省按空数组处理——`LocaleSwitcher` 在"活跃集合 ∪ 当前语种"不足两项时
   * 不渲染任何 DOM，空数组与"只有 en 一个（且当前就是 en）"效果相同（都隐藏切换器）。
   * 空语种不在这个集合里，菜单不会列出它们（PN-09）；只有读者当前正在看的那个语种例外。
   */
  activeLocales?: readonly SiteLocale[];
  /** 站内搜索入口的地址；缺省 = 不渲染任何搜索入口（后台开关关闭）。 */
  searchHref?: string;
  /** 当前页是搜索页：搜索入口按「当前页」高亮。 */
  searchCurrent?: boolean;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  // 滚过一个页头的高度后落回实底。
  //
  // 这里判断的是「离页面顶端多远」，是一个固定像素阈值，所以直接读 scrollY 比
  // 观察一个哨兵元素更直接，也少一个 DOM 节点。监听器是 passive 的，不阻塞滚动；
  // 读 scrollY 不触发重排；每帧最多合并成一次状态更新。
  useEffect(() => {
    if (!overlay) {
      return;
    }

    let frame = 0;
    const sync = () => {
      frame = 0;
      setPinned(window.scrollY > HEADER_HEIGHT_PX);
    };
    const onScroll = () => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(sync);
      }
    };

    sync();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [overlay]);

  // 展开移动端菜单时必须落回实底，否则菜单会压在主视觉图上读不清
  const transparent = overlay && !pinned && !menuOpen;

  // Esc 关闭并把焦点交还给触发按钮，否则键盘用户会掉进页面顶部
  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <>
      <header
        data-testid="site-header"
        data-header-transparent={transparent ? "true" : "false"}
        className={
          transparent
            ? "absolute inset-x-0 top-0 z-30 border-b border-transparent bg-transparent"
            : "border-b border-novel-border bg-novel-bg"
        }
      >
        <Container className="flex h-16 items-center justify-between gap-3 md:gap-4">
          {/* 字标 32 → 40（+25%）。页头高度维持 h-16 不变：40px 字形在 64px
              页头里上下各余 12px，仍然宽裕，而抬高页头会直接从首屏预算里扣。
              40 是 BRAND_MARK_SIZES 里现成的一档，没有新增尺寸。 */}
          <BrandLockup size={40} href={brandHref} name={brandName} />

          {/* 平板/桌面（≥ md）：导航 + 语言胶囊。手机上这一层不生成盒子（`contents`）、
              导航 `hidden`、胶囊的触发按钮 `hidden`——页头一行里只剩站标和右侧两个按钮。 */}
          <div className="contents items-center gap-3 md:flex">
            {/* 桌面导航 */}
            <nav aria-label={t("nav.mainNav")} className="hidden md:block">
              <ul className="flex list-none items-center gap-7 p-0">
                {navItems.map((item) => (
                  <li key={item.href + item.label}>
                    <NavLink item={item} />
                  </li>
                ))}
                {searchHref ? (
                  <li>
                    <SearchNavLink
                      href={searchHref}
                      label={t("search.title")}
                      current={searchCurrent}
                    />
                  </li>
                ) : null}
              </ul>
            </nav>

            {/* 语言入口。只有在确实存在多个活跃语种时才渲染任何 DOM
                （`LocaleSwitcher` 组件自身在"活跃集合 ∪ 当前语种"不足两项
                时返回 null，L10N P4：活跃集由动态层 `getActiveLocales()`
                决定，不再是静态白名单）。这是本站唯一的语种切换入口——
                没有第二个通过 `navItems` 注入的旁路（WO-2 review：移除了
                此前从未被任何调用方填充过的 `SiteChrome.localeNav` 槽位）。
                手机上的语种入口是下面菜单面板里的 `menuRow` 形态，同一份逻辑。 */}
            <LocaleSwitcher activeLocales={activeLocales} />
          </div>

          {/* 手机（< md）：放大镜 + 菜单开关，等大的两个 44×44 按钮，间距 4px，`shrink-0`。
              开关的 `-me-2` 让按钮右缘离视口 12px（容器内边距 20px − 8px），与设计稿
              `padding: 0 12px 0 20px` 一致。两个按钮用同一组颜色类：首页主视觉上的透明页头里也一致可读。 */}
          <div className="flex items-center gap-1 md:hidden">
            {searchHref ? (
              <a
                href={searchHref}
                aria-label={t("search.title")}
                aria-current={searchCurrent ? "page" : undefined}
                className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-novel-md transition-colors hover:bg-novel-bg-raised hover:text-novel-fg ${
                  searchCurrent ? "text-novel-primary" : "text-novel-fg-muted"
                }`}
              >
                <SearchIcon size={22} />
              </a>
            ) : null}

            <button
              ref={toggleRef}
              type="button"
              className="-me-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-novel-md text-novel-fg-muted transition-colors hover:bg-novel-bg-raised hover:text-novel-fg"
              aria-expanded={menuOpen}
              aria-controls={panelId}
              aria-label={menuOpen ? t("nav.closeMenu") : t("nav.openMenu")}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                {menuOpen ? (
                  <path
                    d="M5 5l10 10M15 5L5 15"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                ) : (
                  <path
                    d="M3 6h14M3 10h14M3 14h14"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
          </div>
        </Container>

        {/* 移动端导航面板。关闭时整体不渲染，避免隐藏元素进入 Tab 序列。
            每行最小高 52px；分隔线用 `border-t` + `first:border-t-0`，这样末尾的语种行
            没渲染（只有一个语种）时，不会在最后一行下面多出一条线。 */}
        {menuOpen ? (
          <div
            id={panelId}
            className="border-t border-novel-border bg-novel-bg md:hidden"
          >
            <nav aria-label={t("nav.mainNav")}>
              <Container className="py-2">
                <ul className="flex list-none flex-col p-0">
                  {navItems.map((item) => (
                    <li
                      key={item.href + item.label}
                      className="border-t border-novel-border first:border-t-0"
                    >
                      <NavLink
                        item={item}
                        className="flex min-h-[52px] items-center"
                        textClass="text-[15px]"
                        onNavigate={() => setMenuOpen(false)}
                      />
                    </li>
                  ))}
                  {searchHref ? (
                    <li className="border-t border-novel-border first:border-t-0">
                      <SearchNavLink
                        href={searchHref}
                        label={t("search.title")}
                        current={searchCurrent}
                        className="flex min-h-[52px] items-center gap-2.5"
                        textClass="text-[15px]"
                        iconSize={18}
                        onNavigate={() => setMenuOpen(false)}
                      />
                    </li>
                  ) : null}
                  {/* 语种行：`LocaleSwitcher` 在可选语种不足两项时返回 null，这个 li 就是空的，`empty:hidden`
                      把它连同分隔线一起藏掉。 */}
                  <li className="border-t border-novel-border first:border-t-0 empty:hidden">
                    <LocaleSwitcher
                      variant="menuRow"
                      activeLocales={activeLocales}
                      onNavigate={() => setMenuOpen(false)}
                    />
                  </li>
                </ul>
              </Container>
            </nav>
          </div>
        ) : null}
      </header>
    </>
  );
}

function NavLink({
  item,
  className = "",
  textClass = "text-sm",
  onNavigate,
}: {
  item: NavItem;
  className?: string;
  /** 字号类。手机菜单面板用 15px（设计稿），桌面导航沿用 14px。 */
  textClass?: string;
  onNavigate?: () => void;
}) {
  // 活跃态用颜色 + 下划线双重编码，不只靠颜色——色觉障碍下颜色单独不成立
  const activeClasses = item.current
    ? "text-novel-primary underline decoration-2 underline-offset-8"
    : "text-novel-fg-muted hover:text-novel-fg";

  return (
    <a
      href={item.href}
      aria-current={item.current ? "page" : undefined}
      onClick={onNavigate}
      className={`${textClass} transition-colors ${activeClasses} ${className}`}
    >
      {item.label}
    </a>
  );
}

/**
 * 导航里的「搜索」项：放大镜 + 文字。当前页高亮规则与 `NavLink` 完全一致
 * （颜色 + 下划线 + `aria-current="page"`）。桌面导航里图标 16px，手机菜单里 18px。
 */
function SearchNavLink({
  href,
  label,
  current,
  className = "inline-flex items-center gap-1.5",
  textClass = "text-sm",
  iconSize = 16,
  onNavigate,
}: {
  href: string;
  label: string;
  current: boolean;
  className?: string;
  textClass?: string;
  iconSize?: number;
  onNavigate?: () => void;
}) {
  const activeClasses = current
    ? "text-novel-primary underline decoration-2 underline-offset-8"
    : "text-novel-fg-muted hover:text-novel-fg";

  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      onClick={onNavigate}
      className={`${textClass} transition-colors ${activeClasses} ${className}`}
    >
      <SearchIcon size={iconSize} />
      <span>{label}</span>
    </a>
  );
}

/** 放大镜（设计稿原图形，20×20 视口）。纯装饰：可访问名称在按钮 / 链接上。 */
function SearchIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="9" cy="9" r="5.75" stroke="currentColor" strokeWidth="1.75" />
      <path d="M13.25 13.25L17 17" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
