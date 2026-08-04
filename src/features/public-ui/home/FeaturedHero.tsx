"use client";

import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";
import { MetaList } from "@/components/MetaList";
import { TagList } from "@/components/Tag";
import type { NovelDetailView } from "@/features/public-ui/types";

/**
 * 首页主推位 · 通栏出血 Hero + 轮播。
 *
 * 「无边缘」是这个组件唯一真正的设计主张。沉浸感不来自「加一层黑蒙版」——
 * 那样图片的下边缘仍然在。它来自 mask：图像本身在底部被溶解掉，肉眼找不到边，
 * 图直接长进页面底色里。所以 `--novel-hero-mask` **不能用纯色遮罩替代**。
 *
 * 图层自下而上：底图 → mask 渐隐 → 左向压黑 → 纵向压黑 → 内容。
 *
 * 正文对比度由「压黑起点足够黑」保证，不靠挑图：物料是批量生成的，亮度不可控。
 * 文字锁在左侧 --novel-hero-text-width 内，该区间左向压黑不透明度不低于 0.9，
 * 即使底下是纯白图，合成后仍落在受控暗区。
 *
 * 轮播顺序来自运营人工编排位（架构文档的 home_carousel_manual_slot），
 * 🔴 **不表示排名**——文案里不出现「热门 / TOP / 排行 / 榜」任何一种措辞。
 */

/** 自动播放间隔。hover / focus-within / 用户偏好减少动效时暂停。 */
export const HERO_AUTOPLAY_MS = 7000;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export interface FeaturedHeroItem {
  novel: NovelDetailView;
  detailHref: string;
  /** 站内试读入口。没有可试读章节时不渲染该按钮。 */
  startReadingHref?: string;
}

export function FeaturedHero({
  items,
  eyebrow = "本期主推",
}: {
  items: FeaturedHeroItem[];
  eyebrow?: string;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const baseId = useId();

  // 用户偏好减少动效时不自动播放。要停的是定时器，不是过渡——光停过渡只会让
  // 内容无声无息地跳，比有动效更糟。用 useSyncExternalStore 订阅媒体查询，
  // 服务端快照恒为 false（服务端读不到用户偏好）。
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    () => false,
  );

  const count = items.length;
  const go = useCallback(
    (next: number) => {
      if (count > 0) {
        setIndex(((next % count) + count) % count);
      }
    },
    [count],
  );

  useEffect(() => {
    if (paused || reducedMotion || count < 2) {
      return;
    }
    const timer = window.setInterval(
      () => setIndex((i) => (i + 1) % count),
      HERO_AUTOPLAY_MS,
    );
    return () => window.clearInterval(timer);
  }, [paused, reducedMotion, count]);

  if (count === 0) {
    return null;
  }

  const current = items[index];
  const { novel } = current;

  function onKeyDown(event: KeyboardEvent) {
    if (count < 2) {
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
    }
  }

  return (
    <section
      role="region"
      aria-roledescription="轮播"
      aria-label="主推作品"
      data-testid="featured-hero"
      // 高度写死（移动 560 / 桌面 620），不随简介长短变化——切换时页面不能跳
      className="relative isolate w-full overflow-hidden h-[var(--novel-hero-height-mobile)] md:h-[var(--novel-hero-height)]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={onKeyDown}
    >
      {/* 底图 + mask：图像在底部被溶解，不留边缘。切换只改 opacity，
          不做位移——位移会把「无边缘」的错觉打破。 */}
      {items.map((item, i) => (
        <div
          key={item.novel.id}
          data-hero-layer="image"
          data-hero-active={i === index ? "true" : "false"}
          aria-hidden="true"
          className={
            "absolute inset-0 -z-30 bg-cover bg-center transition-opacity duration-300 ease-out motion-reduce:transition-none " +
            "[mask-image:var(--novel-hero-mask-mobile)] [-webkit-mask-image:var(--novel-hero-mask-mobile)] " +
            "md:[mask-image:var(--novel-hero-mask)] md:[-webkit-mask-image:var(--novel-hero-mask)] " +
            (i === index ? "opacity-100" : "opacity-0")
          }
          style={
            item.novel.heroImageUrl
              ? { backgroundImage: `url("${item.novel.heroImageUrl}")` }
              : undefined
          }
        />
      ))}

      {/* 左向压黑：保证白字对比度，起点必须足够黑 */}
      <div
        aria-hidden="true"
        data-hero-layer="scrim-x"
        className="pointer-events-none absolute inset-0 -z-20 bg-[image:var(--novel-hero-scrim-x)]"
      />

      {/* 纵向压黑：页头可读 + 底部并入页面底色 */}
      <div
        aria-hidden="true"
        data-hero-layer="scrim-y"
        className="pointer-events-none absolute inset-0 -z-10 bg-[image:var(--novel-hero-scrim-y-mobile)] md:bg-[image:var(--novel-hero-scrim-y)]"
      />

      {/* 内容：只渲染当前项的文本节点。
          移动端纵向排、dots 居中；桌面端横向排、dots 落到右下。
          dots 只有一份——渲染两份再用 CSS 藏一份，读屏会念两遍。 */}
      <div className="absolute inset-x-0 bottom-0 pb-7 md:pb-[72px]">
        <Container className="flex flex-col items-stretch gap-[18px] md:flex-row md:items-end md:justify-between md:gap-10">
          <div className="flex w-full flex-none flex-col items-start md:w-[var(--novel-hero-text-width)]">
            <p className="text-[11px] tracking-[0.2em] text-novel-fg-muted uppercase md:text-xs">
              {eyebrow}
            </p>

            <h2
              className="mt-3 line-clamp-3 font-novel-serif text-[22px] leading-[1.2] font-semibold tracking-tight text-novel-fg-on-media md:mt-[18px] md:text-[30px]"
            >
              <a href={current.detailHref} className="rounded-novel-sm">
                {novel.title}
              </a>
            </h2>

            <MetaList
              tone="on-media"
              className="mt-3 md:mt-[18px]"
              items={[
                { key: "locale", value: novel.locale.label },
                { key: "chapters", value: `共 ${novel.totalChapterCount} 章` },
              ]}
            />

            <TagList tags={novel.tags} className="mt-4" label={`《${novel.title}》标签`} />

            {/* 简介只取第一段：这里是引子，完整简介是详情页的事。
                移动 2 行 / 桌面 4 行截断，保证高度不随文案长短变化。 */}
            <p
              data-testid="featured-hero-summary"
              className="mt-3 line-clamp-2 text-[14.5px] leading-[1.6] text-novel-fg-muted-on-media md:mt-5 md:line-clamp-4 md:text-base md:leading-[1.7]"
            >
              {firstParagraph(novel.description)}
            </p>

            <div className="mt-5 flex w-full gap-2.5 md:mt-8 md:w-auto md:gap-3">
              {current.startReadingHref ? (
                <ButtonLink
                  href={current.startReadingHref}
                  variant="accent"
                  size="lg"
                  className="flex-1 md:flex-none"
                >
                  开始试读
                </ButtonLink>
              ) : null}
              <ButtonLink
                href={current.detailHref}
                variant="outline"
                size="lg"
                className="flex-1 md:flex-none"
              >
                查看详情
              </ButtonLink>
            </div>

          </div>

          {count > 1 ? (
            <HeroDots
              count={count}
              index={index}
              onSelect={go}
              baseId={baseId}
              className="flex self-center md:self-end md:pb-2.5"
            />
          ) : null}
        </Container>
      </div>

      {/* 切换时告知读屏用户当前在第几本 */}
      <p aria-live="polite" className="sr-only">
        第 {index + 1} 本，共 {count} 本：{novel.title}
      </p>
    </section>
  );
}

/** 简介在 Hero 上只取第一段。 */
function firstParagraph(description: string): string {
  return (
    description
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function HeroDots({
  count,
  index,
  onSelect,
  baseId,
  className = "",
}: {
  count: number;
  index: number;
  onSelect: (next: number) => void;
  baseId: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="切换主推作品"
      data-testid="featured-hero-dots"
      className={`items-center gap-1.5 md:gap-2 ${className}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          role="tab"
          id={`${baseId}-dot-${i}`}
          aria-selected={i === index}
          aria-label={`第 ${i + 1} 本`}
          onClick={() => onSelect(i)}
          className="rounded-novel-sm p-1"
        >
          <span
            aria-hidden="true"
            className={
              "block rounded-full transition-all duration-300 motion-reduce:transition-none " +
              (i === index
                ? "h-[3px] w-5 bg-novel-accent md:h-1 md:w-[26px]"
                : "h-[3px] w-[3px] bg-novel-accent/40 md:h-1 md:w-1")
            }
          />
        </button>
      ))}
    </div>
  );
}
