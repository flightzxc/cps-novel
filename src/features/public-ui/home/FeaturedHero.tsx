"use client";

import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";
import { CoverImage } from "@/components/CoverImage";
import { MetaList } from "@/components/MetaList";
import { TagList } from "@/components/Tag";
import type { NovelDetailView } from "@/features/public-ui/types";
import { useT } from "@/lib/locale/messages/MessagesProvider";

/**
 * 首页主推位 · 居中 banner + 轮播。
 *
 * 🔴 **2026-09-19 结构改向。** 本组件原本的设计主张是「无边缘通栏出血」：
 * 整屏封面在底部被 mask 溶解、文字锁在左侧 340px 的压黑区内。该主张已被
 * Owner 推翻，原因是与海阅的真实素材不匹配——只有 250×350 竖封面、自带
 * 烘焙大字、6 张真实封面亮度跨度 3.5 倍。两轮实测证明参数只能在「整屏
 * 黑灰雾」与「漏出封面字形」之间摇摆，没有同时成立的取值。
 *
 * 现在的结构：外层仍是定高的出血区（承接页头叠放与下方浏览区的 8px 衔接），
 * 但**主体是居中的 banner**——左侧放清晰的竖封面，右侧放标题/元信息/标签/
 * 简介/CTA。背景层降级为轻量氛围，不再承担主视觉。
 *
 * 文字现在落在 banner 这块实体面（`bg-novel-bg-elevated`）上，不再压在图上，
 * 因此用常规前景色而不是 `*-on-media` 一族，对比度也不再依赖左向压黑。
 *
 * 轮播顺序来自运营人工编排位（架构文档的 home_carousel_manual_slot），
 * 🔴 **不表示排名**——文案里不出现「热门 / TOP / 排行 / 榜」任何一种措辞。
 *
 * --- Hero 永远出现（2026-09-19 起）-----------------------------------------
 * 海阅不存在横版主视觉素材，渠道只给竖版封面（实测全部 250×350）。Hero 不再
 * 由「有没有横版图」决定是否出现——只要主推列表非空，Hero 就渲染；`hasHero`
 * 判断挪到了 `HomeScreen`，这里的输入契约变成「给什么就渲染什么」。
 *
 * 每一项的底图按三档优先级解析（见 `resolveHeroBackground`）：
 *   1. `heroImageUrl` 存在 → 清晰铺底，不加模糊。这是将来才可能有的运营横版
 *      物料覆盖源，生产上恒为空，但这条分支必须留着且能工作。
 *   2. 否则 `coverUrl` 存在 → 竖封面强模糊氛围底。**这是当前生产的正常路径**。
 *   3. 两者都没有 → 不渲染图层，纯 `--novel-bg`。
 *
 * 模糊氛围底必须拆成两层元素（外层 mask+opacity+overflow-hidden、内层
 * filter+scale+背景图），不能合并：`transform: scale()` 会把 `mask-image`
 * 的渐隐边界一起缩放出去，底部融入 `--novel-bg` 的效果就没了。scale 存在的
 * 唯一理由是把 `filter: blur()` 在元素边缘采样出的透明虚边推出可视区——
 * 经验下界 ≈ `1 + 2*blur / min(盒宽, 盒高)`，改 blur 必须连带核对这条不等式。
 *
 * 🔴 滤镜链顺序固定为 `contrast() blur() brightness() saturate()`，不能打乱：
 * `contrast` 必须在最前，对**原始未模糊图像**先做动态范围压缩——它是唯一
 * 能把「6 张真实封面亮度跨度 3.5 倍」收敛到「合成后氛围区亮度跨度 ≤3 倍」
 * 的旋钮：`contrast(k)`（k<1）把每张图自己的均值向中灰拉，跟 `brightness`
 * 那种对所有图等比缩放、不改变彼此比值的全局乘法完全不同。放在 `blur` 之后
 * 效果减弱（模糊已经把极端像素摊平了一部分）。具体取值与调参依据见
 * `src/styles/globals.css` 的 `--novel-hero-cover-*` 一族注释。
 */
type HeroBackground =
  | { kind: "hero"; url: string }
  | { kind: "cover-atmosphere"; url: string }
  | { kind: "none" };

/** 底图来源优先级：heroImageUrl（清晰） > coverUrl（模糊氛围底） > 无。 */
function resolveHeroBackground(novel: NovelDetailView): HeroBackground {
  if (novel.heroImageUrl) {
    return { kind: "hero", url: novel.heroImageUrl };
  }
  if (novel.coverUrl) {
    return { kind: "cover-atmosphere", url: novel.coverUrl };
  }
  return { kind: "none" };
}

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
  eyebrow,
}: {
  items: FeaturedHeroItem[];
  eyebrow?: string;
}) {
  const t = useT();
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
      aria-roledescription={t("home.carouselRole")}
      aria-label={t("home.carouselLabel")}
      data-testid="featured-hero"
      // 高度写死（移动 340 / 桌面 560），不随简介长短变化——切换时页面不能跳
      className="relative isolate w-full overflow-hidden h-[var(--novel-hero-height-mobile)] md:h-[var(--novel-hero-height)]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={onKeyDown}
    >
      {/* 底图 + mask：图像在底部被溶解，不留边缘。切换只改 opacity，
          不做位移——位移会把「无边缘」的错觉打破。
          外层只管 mask/opacity/裁切；内层只管背景图/滤镜/scale——两者不能
          合并进同一个元素，见组件顶部注释「模糊氛围底必须拆成两层」。 */}
      {items.map((item, i) => {
        const background = resolveHeroBackground(item.novel);
        if (background.kind === "none") {
          // 两者都没有：不渲染图层，纯 --novel-bg 透出来。
          return null;
        }
        return (
          <div
            key={item.novel.id}
            data-hero-layer="image"
            data-hero-active={i === index ? "true" : "false"}
            data-hero-background={background.kind}
            aria-hidden="true"
            className={
              "absolute inset-0 -z-30 overflow-hidden transition-opacity duration-300 ease-out motion-reduce:transition-none " +
              "[mask-image:var(--novel-hero-mask-mobile)] [-webkit-mask-image:var(--novel-hero-mask-mobile)] " +
              "md:[mask-image:var(--novel-hero-mask)] md:[-webkit-mask-image:var(--novel-hero-mask)] " +
              (i === index ? "opacity-100" : "opacity-0")
            }
          >
            <div
              aria-hidden="true"
              data-hero-layer="image-fill"
              className={
                "absolute inset-0 bg-cover bg-center " +
                (background.kind === "cover-atmosphere"
                  ? "[filter:contrast(var(--novel-hero-cover-contrast))_blur(var(--novel-hero-cover-blur))_brightness(var(--novel-hero-cover-brightness))_saturate(var(--novel-hero-cover-saturate))] " +
                    "[transform:scale(var(--novel-hero-cover-scale))]"
                  : "")
              }
              style={{ backgroundImage: `url("${background.url}")` }}
            />
          </div>
        );
      })}

      {/* 左向压黑：结构改向后不再承担正文对比度（正文在不透明 banner 上），
          只剩「让左侧氛围不与 banner 抢注意力」这一个作用。 */}
      <div
        aria-hidden="true"
        data-hero-layer="scrim-x"
        className="pointer-events-none absolute inset-0 -z-20 bg-[image:var(--novel-hero-scrim-x)]"
      />

      {/* 纵向压黑：页头叠在 Hero 上仍可读 + 底部并入页面底色 */}
      <div
        aria-hidden="true"
        data-hero-layer="scrim-y"
        className="pointer-events-none absolute inset-0 -z-10 bg-[image:var(--novel-hero-scrim-y-mobile)] md:bg-[image:var(--novel-hero-scrim-y)]"
      />

      {/* 居中 banner —— 这一屏真正的主体。
          🔴 2026-09-19 结构改向：此前「整屏模糊封面当主视觉」的做法已废弃。
          海阅的素材只有 250×350 竖封面、自带烘焙大字、明暗跨度 3.5 倍，
          继续在 blur / contrast / brightness / saturate 上拉扯只会在
          「整屏黑灰雾」与「漏出封面字形」之间摇摆——两轮实测都证实了这点
          （过程记录见 globals.css 的 --novel-hero-cover-* 注释）。
          现在封面以**清晰**形态放进 banner 左侧，背景层降级为轻量氛围。

          只借「中心主舞台 + 清晰封面 + 文字右置」这个版面结构；配色、按钮、
          字体、圆角仍全部是 PulseNovel 自己的体系。

          dots 只有一份——渲染两份再用 CSS 藏一份，读屏会念两遍。 */}
      {/* pt 让开叠在 Hero 上的页头（移动 56 / 桌面 64），否则 banner 居中时
          会被页头压住——移动端 Hero 只有 340px，这个重叠非常明显。 */}
      <div className="absolute inset-0 flex items-center pt-14 md:pt-16">
        <Container className="flex flex-col items-center gap-4 md:gap-5">
          <div
            data-testid="featured-hero-banner"
            className={
              "flex w-full max-w-[var(--novel-hero-banner-max)] items-center gap-3.5 " +
              "rounded-novel-lg border border-novel-border bg-novel-bg-elevated p-3.5 " +
              "md:h-[var(--novel-hero-banner-height)] md:gap-9 md:p-7"
            }
          >
            {/* 封面：清晰、等比、不模糊。左封面右文字，移动端同构只是尺寸更小。
                移动端没有改成「上封面下文字」：实测长标题（越南语/俄语/葡语）
                在这个宽度下换到 2–3 行仍然成立，而纵向排会把 banner 顶到
                两倍高，反而挤掉下方的浏览区。 */}
            <a
              href={current.detailHref}
              data-testid="featured-hero-cover"
              className="block w-[104px] shrink-0 rounded-novel-md md:w-[var(--novel-hero-cover-width)]"
            >
              <CoverImage
                src={novel.coverUrl}
                alt={t("novel.coverAlt", { title: novel.title })}
                sizeHint="(min-width: 768px) 240px, 104px"
              />
            </a>

            <div className="flex min-w-0 flex-1 flex-col items-start md:max-w-[var(--novel-hero-info-width)]">
            <p className="text-[10px] tracking-[0.18em] text-novel-fg-muted uppercase md:text-xs">
              {eyebrow ?? t("home.featuredEyebrow")}
            </p>

            <h2
              className="mt-1.5 line-clamp-2 font-novel-serif text-[16px] leading-[1.25] font-semibold tracking-tight text-novel-fg md:mt-4 md:line-clamp-3 md:text-[30px] md:leading-[1.2]"
            >
              <a href={current.detailHref} className="rounded-novel-sm">
                {novel.title}
              </a>
            </h2>

            <MetaList
              className="mt-1.5 text-[12px] md:mt-4 md:text-sm"
              items={[
                { key: "locale", value: novel.locale.label },
                { key: "chapters", value: t("home.chapterCount", { count: novel.totalChapterCount }) },
              ]}
            />

            <TagList tags={novel.tags} className="mt-2 md:mt-3" label={t("novel.tagsLabel")} />

            {/* 简介只取第一段：这里是引子，完整简介是详情页的事。
                移动 2 行 / 桌面 4 行截断，保证高度不随文案长短变化。 */}
            <p
              data-testid="featured-hero-summary"
              className="mt-2 line-clamp-2 text-[12.5px] leading-[1.5] text-novel-fg-muted md:mt-4 md:line-clamp-3 md:text-base md:leading-[1.7]"
            >
              {firstParagraph(novel.description)}
            </p>

            {/* `flex-wrap` 是必需的，不是保险：按钮走 `whitespace-nowrap`，flex 项
                又有默认的 `min-width:auto`，所以两枚按钮**不会**被压窄——它们会
                一起把这一行顶宽。360px 宽的安卓机上实测（2026-09-19）：俄语
                「Начать ознакомление / Подробнее」把行宽顶出内容容器 49px，德语
                34px，越南语 13px，而 Hero 自身是 `overflow-hidden`，于是第二枚
                按钮不是溢出而是**被直接裁掉**，页面还不横向滚动，看不出哪里错了。
                换行后放不下的那枚自己占满一行，文案再长也只是多一行。 */}
            <div className="mt-3 flex w-full flex-wrap gap-2 md:mt-6 md:w-auto md:gap-3">
              {current.startReadingHref ? (
                <ButtonLink
                  href={current.startReadingHref}
                  variant="accent"
                  size="lg"
                  className="flex-1 md:flex-none"
                >
                  {t("home.startPreview")}
                </ButtonLink>
              ) : null}
              {/* 次级 CTA 移动端不渲染：文字列只有 ~210px，越南语 / 俄语这类长
                  文案两枚按钮必然换行，把 banner 顶到接近两倍高。详情入口在
                  封面和标题上仍然可达，不是把入口去掉。
                  🔴 `hidden` 必须加在**外层 div** 上，不能加在 ButtonLink 的
                  className 里：Button 的 BASE 自带 `inline-flex`，两条 display
                  工具类在同一层，胜负由生成的 CSS 顺序决定而不是书写顺序，
                  实测 `inline-flex` 赢，按钮照样显示。 */}
              <div className="hidden flex-1 md:block md:flex-none">
                <ButtonLink
                  href={current.detailHref}
                  variant="outline"
                  size="lg"
                  className="w-full md:w-auto"
                >
                  {t("home.viewDetails")}
                </ButtonLink>
              </div>
            </div>
            </div>

            {/* 右侧轻氛围区：本轮不做「下一本预览」，先留空，主次更干净。 */}
            <div aria-hidden="true" className="hidden flex-1 md:block" />
          </div>

          {count > 1 ? (
            <HeroDots
              count={count}
              index={index}
              onSelect={go}
              baseId={baseId}
              className="flex"
            />
          ) : null}
        </Container>
      </div>

      {/* 切换时告知读屏用户当前在第几本 */}
      <p aria-live="polite" className="sr-only">
        {t("home.slideStatus", { n: index + 1, count, title: novel.title })}
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
  const t = useT();
  return (
    <div
      role="tablist"
      aria-label={t("home.switchFeatured")}
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
          aria-label={t("home.slideLabel", { n: i + 1 })}
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
