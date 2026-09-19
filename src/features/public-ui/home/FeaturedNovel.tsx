import { ButtonLink } from "@/components/Button";
import { CoverImage } from "@/components/CoverImage";
import { MetaList } from "@/components/MetaList";
import { TagList } from "@/components/Tag";
import type { NovelDetailView } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/**
 * 首页主推位 · 封面编排版 —— **2026-09-19 起首页不再使用它**。
 *
 * 停用原因：Owner 已确认海阅不存在、也不会等横版主视觉素材，渠道只提供竖版
 * 封面（实测全部 250×350）。继续让首页按「有没有 heroImageUrl」在这个组件与
 * FeaturedHero 之间二选一，等于让主推位永久停在这个回落态——于是改成
 * `FeaturedHero` 恒渲染，缺横版素材时直接用竖封面在 Hero 内部做强模糊氛围底
 * （`FeaturedHero` 的 `resolveHeroBackground` 三档优先级），不再需要这一版
 * 完全不同的双栏版面。`HomeScreen` 已经不再引用本文件。
 *
 * 保留这个文件（不删除）只是留作历史参照——它曾经是「回落必须是一个完整成立
 * 的版面」这条设计判断的实现，日后如果又出现「需要一个纯封面、非 Hero 的
 * 主推版面」的场景，这里有参照可查。🔴 它已经**不在**任何生产渲染路径上，
 * 也不再被 `/dev-preview/home-fallback` 通过 `HomeScreen` 间接渲染到——
 * 那个预览路由现在展示的是「Hero + coverUrl 模糊氛围底」这条生产正常路径，
 * 不是本文件。
 *
 * 以下是停用前的原始设计记录，供参照，不代表当前行为：
 *
 * 有物料时首页走 FeaturedHero（通栏出血 + 轮播）。这一版保留下来，因为回落必须
 * 是一个完整成立的版面，而不是「Hero 少了张图」的残缺态：它只需要一张竖版封面。
 *
 * 气场靠三处，都不花钱：封面给到足够大的尺寸、书名给到足够大的字号、
 * 上下给到足够多的空白。上方一条细规线 + 小号眉标做编排感。
 *
 * ⚠️ 本文件原有两句注释已作废，不要照旧引用：
 *   ①「不使用通栏宽幅 banner」——前提是「图源只有上游竖版封面」，
 *      而横版主视觉物料已确认可由运营批量提供，前提不成立；
 *   ②「没有轮播：我们没有可信的排序信号」——轮播顺序来自运营人工编排位
 *      （架构文档 §6.1 的 home_carousel_manual_slot，Owner 已裁决复用），
 *      不是排名算法，理由本身不成立。
 * 依据见 docs/p1/P1_10_VISUAL_DIRECTION.md 第五节与文末变更记录。
 */
export function FeaturedNovel({
  locale,
  novel,
  eyebrow,
  detailHref,
  startReadingHref,
}: {
  locale: SiteLocale;
  novel: NovelDetailView;
  eyebrow?: string;
  /** 详情页地址，由路由层注入 */
  detailHref: string;
  /** 站内试读入口。没有可试读章节时不渲染该按钮。 */
  startReadingHref?: string;
}) {
  const t = getPublicT(locale);
  return (
    // 留白收口（2026-09-19）：原为 `pt-12 pb-4 md:pt-20 md:pb-8` + 内层
    // `pt-6 md:pt-10`，桌面端页头到眉标之间空出 120px，下沿再叠上题材导航的
    // `pt-10 md:pt-14` 与作品区的 `pt-12 md:pt-16`。气场要的是「封面大、书名
    // 大、上下松」，不是「上下各留半屏」——上沿压到 80px（移动 56px），下沿
    // 只留 32px（移动 24px），其余交给浏览区按原稿 2a/2d 的 8px 承接。
    <section aria-labelledby="featured-title" className="pt-8 pb-6 md:pt-12 md:pb-8">
      <div className="border-t border-novel-border pt-6 md:pt-8">
        <p className="text-xs tracking-[0.2em] text-novel-fg-subtle uppercase">
          {eyebrow ?? t("home.featuredEyebrow")}
        </p>

        <div className="mt-6 grid gap-8 md:mt-10 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] md:gap-14">
          <div className="mx-auto w-full max-w-[240px] md:mx-0 md:max-w-none">
            <a href={detailHref} className="block rounded-novel-md">
              <CoverImage
                src={novel.coverUrl}
                alt={t("novel.coverAlt", { title: novel.title })}
                sizeHint="(min-width: 768px) 320px, 240px"
              />
            </a>
          </div>

          <div className="flex flex-col items-start">
            <h2
              id="featured-title"
              className="font-novel-serif text-3xl leading-[1.15] font-semibold tracking-tight text-balance text-novel-fg md:text-5xl"
            >
              <a href={detailHref} className="rounded-novel-sm hover:text-novel-primary transition-colors">
                {novel.title}
              </a>
            </h2>

            <MetaList
              className="mt-4"
              items={[
                { key: "locale", value: novel.locale.label },
                { key: "chapters", value: t("home.chapterCount", { count: novel.totalChapterCount }) },
              ]}
            />

            <TagList tags={novel.tags} className="mt-4" label={t("novel.tagsLabel")} />

            <p className="mt-6 max-w-[60ch] text-base leading-relaxed text-novel-fg-muted md:mt-7 md:text-lg">
              {novel.description}
            </p>

            <div className="mt-8 flex flex-wrap gap-3 md:mt-10">
              {startReadingHref ? (
                <ButtonLink href={startReadingHref} variant="accent" size="lg">
                  {t("home.startPreview")}
                </ButtonLink>
              ) : null}
              <ButtonLink href={detailHref} variant="outline" size="lg">
                {t("home.viewDetails")}
              </ButtonLink>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
