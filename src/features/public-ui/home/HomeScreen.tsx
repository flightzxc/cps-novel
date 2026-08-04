import { Container } from "@/components/Container";
import { SectionHeader } from "@/components/SectionHeader";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { NovelCardView, NovelDetailView } from "@/features/public-ui/types";
import { FeaturedHero, type FeaturedHeroItem } from "./FeaturedHero";
import { FeaturedNovel } from "./FeaturedNovel";

/**
 * 首页页面壳。
 *
 * 结构：页头 → 主推位 → 作品网格 → 页脚。
 *
 * 主推位有两种形态，由物料决定，不由配置决定：
 *   有横版主视觉 → 通栏出血 Hero + 轮播（FeaturedHero）
 *   一张都没有   → 封面编排版（FeaturedNovel），只需要竖版封面
 * 混合时只把有物料的放进轮播——把两种形态混在同一个轮播里会让节奏断掉。
 *
 * 区块小标题不带 emoji（四个竞品全部带，这是最省力的区隔点），
 * 也不使用任何暗示排名或热度的措辞：轮播顺序来自运营编排位，不是榜单。
 */
export interface FeaturedEntry {
  novel: NovelDetailView;
  detailHref: string;
  startReadingHref?: string;
}

export function HomeScreen({
  featuredList = [],
  novels,
  browseAllHref,
  chrome,
}: {
  /** 运营编排的主推列表（对应架构文档的 home_carousel_manual_slot），建议 4–6 本。 */
  featuredList?: FeaturedEntry[];
  novels: NovelCardView[];
  browseAllHref?: string;
  chrome?: SiteChrome;
}) {
  const heroItems: FeaturedHeroItem[] = featuredList.filter(
    (entry) => Boolean(entry.novel.heroImageUrl),
  );
  const hasHero = heroItems.length > 0;
  const fallback = !hasHero ? featuredList[0] : undefined;

  return (
    <SiteShell chrome={chrome} headerOverlay={hasHero}>
      {hasHero ? <FeaturedHero items={heroItems} /> : null}

      <Container>
        {fallback ? (
          <FeaturedNovel
            novel={fallback.novel}
            detailHref={fallback.detailHref}
            startReadingHref={fallback.startReadingHref}
          />
        ) : null}

        <section aria-labelledby="all-works" className="pt-12 pb-4 md:pt-16">
          <SectionHeader
            id="all-works"
            title="作品"
            action={
              browseAllHref ? (
                <a
                  href={browseAllHref}
                  className="text-novel-primary transition-colors hover:text-novel-primary-hover"
                >
                  查看全部
                </a>
              ) : undefined
            }
          />
          <BookGrid novels={novels} />
        </section>
      </Container>
    </SiteShell>
  );
}
