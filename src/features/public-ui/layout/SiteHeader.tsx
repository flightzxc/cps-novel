"use client";

import { useEffect, useId, useRef, useState } from "react";
import { BrandLockup } from "@/components/BrandMark";
import { Container } from "@/components/Container";
import type { NavItem } from "@/features/public-ui/types";

/** 页头高度（h-16）。overlay 模式下滚过这个距离就落回实底。 */
const HEADER_HEIGHT_PX = 64;

/**
 * 页头。恒在站点作用域（深色），不随阅读器主题翻转。
 *
 * 导航项由调用方注入——**URL 结构尚未冻结，组件不自行决定任何永久路由**。
 *
 * 刻意没有的东西：搜索（站内搜索不在本期范围）、账户入口、应用下载。
 * 语言入口是可选的：首发语种白名单尚未定案，只有一个语种时不渲染该入口。
 */
export function SiteHeader({
  brandHref = "/",
  navItems = [],
  localeNav,
  overlay = false,
}: {
  brandHref?: string;
  navItems?: NavItem[];
  /** 语言入口。只有在确实存在多个可发布语种时才由调用方传入。 */
  localeNav?: NavItem[];
  /**
   * 浮在主视觉 Hero 之上：无底色、无毛玻璃、无分隔线，仅靠 Hero 的纵向压黑保证可读。
   * 滚出 Hero 后自动恢复底色与分隔线。不传时行为与普通页头完全一致。
   */
  overlay?: boolean;
}) {
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

  const allItems =
    localeNav && localeNav.length > 0 ? [...navItems, ...localeNav] : navItems;

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
        <Container className="flex h-16 items-center justify-between gap-4">
          <BrandLockup size={32} href={brandHref} />

          {/* 桌面导航 */}
          <nav aria-label="主导航" className="hidden md:block">
            <ul className="flex list-none items-center gap-7 p-0">
              {allItems.map((item) => (
                <li key={item.href + item.label}>
                  <NavLink item={item} />
                </li>
              ))}
            </ul>
          </nav>

          {/* 移动端开关 */}
          <button
            ref={toggleRef}
            type="button"
            className="-mr-2 inline-flex h-10 w-10 items-center justify-center rounded-novel-md text-novel-fg-muted transition-colors hover:bg-novel-bg-raised hover:text-novel-fg md:hidden"
            aria-expanded={menuOpen}
            aria-controls={panelId}
            aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <svg
              width="20"
              height="20"
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
        </Container>

        {/* 移动端导航面板。关闭时整体不渲染，避免隐藏元素进入 Tab 序列。 */}
        {menuOpen ? (
          <div
            id={panelId}
            className="border-t border-novel-border bg-novel-bg md:hidden"
          >
            <Container as="nav" className="py-2">
              <ul className="flex list-none flex-col p-0">
                {allItems.map((item) => (
                  <li
                    key={item.href + item.label}
                    className="border-b border-novel-border last:border-b-0"
                  >
                    <NavLink
                      item={item}
                      className="block py-3.5"
                      onNavigate={() => setMenuOpen(false)}
                    />
                  </li>
                ))}
              </ul>
            </Container>
          </div>
        ) : null}
      </header>
    </>
  );
}

function NavLink({
  item,
  className = "",
  onNavigate,
}: {
  item: NavItem;
  className?: string;
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
      className={`text-sm transition-colors ${activeClasses} ${className}`}
    >
      {item.label}
    </a>
  );
}
