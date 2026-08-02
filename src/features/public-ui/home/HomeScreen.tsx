import { Container } from "@/components/Container";
import { SectionHeader } from "@/components/SectionHeader";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { NovelCardView, NovelDetailView } from "@/features/public-ui/types";
import { FeaturedNovel } from "./FeaturedNovel";

/**
 * 首页页面壳。
 *
 * 结构：页头 → 主推位 → 作品网格 → 页脚。
 *
 * 区块小标题不带 emoji（四个竞品全部带，这是最省力的区隔点），
 * 也不使用任何暗示排名或热度的措辞——我们没有可信的排序信号。
 */
export function HomeScreen({
  featured,
  featuredDetailHref,
  featuredStartReadingHref,
  novels,
  browseAllHref,
  chrome,
}: {
  /** 主推的一本。没有时整个主推位不渲染，首页直接从网格开始。 */
  featured?: NovelDetailView;
  featuredDetailHref?: string;
  featuredStartReadingHref?: string;
  novels: NovelCardView[];
  browseAllHref?: string;
  chrome?: SiteChrome;
}) {
  return (
    <SiteShell chrome={chrome}>
      <Container>
        {featured && featuredDetailHref ? (
          <FeaturedNovel
            novel={featured}
            detailHref={featuredDetailHref}
            startReadingHref={featuredStartReadingHref}
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
