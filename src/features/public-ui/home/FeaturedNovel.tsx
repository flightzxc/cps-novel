import { ButtonLink } from "@/components/Button";
import { CoverImage } from "@/components/CoverImage";
import { MetaList } from "@/components/MetaList";
import { TagList } from "@/components/Tag";
import type { NovelDetailView } from "@/features/public-ui/types";

/**
 * 首页主推位 · 封面编排版 —— **无横版主视觉物料时的回落形态**。
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
  novel,
  eyebrow = "本期主推",
  detailHref,
  startReadingHref,
}: {
  novel: NovelDetailView;
  eyebrow?: string;
  /** 详情页地址，由路由层注入 */
  detailHref: string;
  /** 站内试读入口。没有可试读章节时不渲染该按钮。 */
  startReadingHref?: string;
}) {
  return (
    <section aria-labelledby="featured-title" className="pt-12 pb-4 md:pt-20 md:pb-8">
      <div className="border-t border-novel-border pt-6 md:pt-10">
        <p className="text-xs tracking-[0.2em] text-novel-fg-subtle uppercase">
          {eyebrow}
        </p>

        <div className="mt-6 grid gap-8 md:mt-10 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] md:gap-14">
          <div className="mx-auto w-full max-w-[240px] md:mx-0 md:max-w-none">
            <a href={detailHref} className="block rounded-novel-md">
              <CoverImage
                src={novel.coverUrl}
                alt={`《${novel.title}》封面`}
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
                { key: "chapters", value: `共 ${novel.totalChapterCount} 章` },
              ]}
            />

            <TagList tags={novel.tags} className="mt-4" label={`《${novel.title}》标签`} />

            <p className="mt-6 max-w-[60ch] text-base leading-relaxed text-novel-fg-muted md:mt-7 md:text-lg">
              {novel.description}
            </p>

            <div className="mt-8 flex flex-wrap gap-3 md:mt-10">
              {startReadingHref ? (
                <ButtonLink href={startReadingHref} variant="accent" size="lg">
                  开始试读
                </ButtonLink>
              ) : null}
              <ButtonLink href={detailHref} variant="outline" size="lg">
                查看详情
              </ButtonLink>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
