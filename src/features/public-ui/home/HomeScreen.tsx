import { Container } from "@/components/Container";
import { SectionHeader } from "@/components/SectionHeader";
import { BookGrid } from "@/features/public-ui/book/BookGrid";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { NovelCardView, NovelDetailView, SiteTag } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { FeaturedHero, type FeaturedHeroItem } from "./FeaturedHero";

/**
 * 首页页面壳。
 *
 * 结构：页头 → 主推位 → 作品网格 → 页脚。
 *
 * 主推位只有一种形态：通栏出血 Hero + 轮播（FeaturedHero），只要运营编排了
 * 主推列表就渲染——不再由「有没有横版主视觉」决定形态。
 *
 * 2026-09-19 前：这里按 `heroImageUrl` 是否存在，在 Hero 与封面编排版
 * （FeaturedNovel）之间二选一。Owner 已确认海阅不存在、也不会等横版素材，
 * 渠道只给竖版封面（实测全部 250×350）——继续按物料有无切形态，等于让首页
 * 主推位永久停在回落态。现在 Hero 恒渲染，缺横版素材时用竖封面做强模糊氛围
 * 底（见 `FeaturedHero` 内 `resolveHeroBackground` 的三档优先级）。
 * `FeaturedNovel` 不再被这里引用，保留为历史参照，理由见该文件顶部注释。
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
  locale,
  featuredList = [],
  novels,
  browseAllHref,
  chrome,
  categories = [],
}: {
  locale: SiteLocale;
  /** 运营编排的主推列表（对应架构文档的 home_carousel_manual_slot），建议 4–6 本。 */
  featuredList?: FeaturedEntry[];
  novels: NovelCardView[];
  browseAllHref?: string;
  chrome?: SiteChrome;
  categories?: readonly SiteTag[];
}) {
  const t = getPublicT(locale);
  /**
   * 2026-09-19 起不再按 `heroImageUrl` 过滤：主推列表里每一项都进 Hero，
   * `FeaturedHero` 自己按三档优先级（heroImageUrl 清晰 / coverUrl 模糊氛围底
   * / 都没有则纯底色）解析每一项的背景，这里不替它做预判。
   */
  const heroItems: FeaturedHeroItem[] = featuredList;
  const hasHero = heroItems.length > 0;
  /**
   * 主推位是否存在。以前这里还要跟 FeaturedNovel 回落项合并判断——现在只有
   * Hero 一种形态，`hasFeatured` 与 `hasHero` 等价，只保留这个名字是因为
   * 下面 `browseTopPadding` 的注释一直这么称呼它。
   */
  const hasFeatured = hasHero;
  /**
   * 浏览区（题材导航 + 作品网格）的顶部留白。
   *
   * 有主推位时走原稿 2a/2d 的 8px（移动 16px）：Hero 自己已经把下沿留白算进
   * 去了——信息组下方还有 72px 的组件内空间，浏览区再补一大段就会叠出一条
   * 谁也没打算要的空带。这里原本是 `pt-12 md:pt-16`（48/64px），叠上题材导航
   * 的 `pt-10 md:pt-14`（40/56px）和主推位的 `pb`，实测桌面端从按钮底沿到
   * 「作品」标题有 186px。
   *
   * 主推位整块缺席时（运营没编排任何主推，即 `featuredList` 为空）浏览区就是
   * 页头之后的第一块内容，8px 会让它直接贴到页头，这时仍要自己撑出一段常规
   * 页面留白。
   */
  const browseTopPadding = hasFeatured ? "pt-4 md:pt-2" : "pt-10 md:pt-14";

  return (
    <SiteShell locale={locale} chrome={chrome} headerOverlay={hasHero}>
      {hasHero ? <FeaturedHero items={heroItems} /> : null}

      <Container>
        {/* 浏览区：题材导航 + 作品网格。
            两者是同一件事的两半（「去哪儿找书」与「书在这儿」），所以共用一个
            顶部留白，由外层这一层给；题材导航不再自带 `pt`，也就不会在主推位
            和作品区之间单独占出一条上下都空的横带。

            🔴 导航放在区块小标题**之上**而不是分隔线之下：它是全站题材入口，
            不是这一格网格的筛选器。放到「作品」标题下面会让人以为点了就筛这
            个列表，同时也会把原稿「分隔线到书卡 32px（移动 24px）」挤掉。 */}
        <div className={browseTopPadding} data-testid="home-browse">
          {categories.length > 0 ? (
            <nav
              aria-label="Browse by category"
              data-testid="home-category-nav"
              className="mb-5 flex flex-wrap gap-2 md:mb-6"
            >
              {categories.map((category) => (
                <a
                  key={category.slug}
                  href={category.href}
                  className="rounded-full border border-novel-border px-3 py-1.5 text-sm text-novel-fg-muted transition-colors hover:border-novel-primary hover:text-novel-primary"
                >
                  {category.label}
                </a>
              ))}
            </nav>
          ) : null}

          <section aria-labelledby="all-works" className="pb-4">
            <SectionHeader
              id="all-works"
              title={t("home.works")}
              action={
                browseAllHref ? (
                  <a
                    href={browseAllHref}
                    className="text-novel-primary transition-colors hover:text-novel-primary-hover"
                  >
                    {t("home.viewAll")}
                  </a>
                ) : undefined
              }
            />
            <BookGrid locale={locale} novels={novels} />
          </section>
        </div>
      </Container>
    </SiteShell>
  );
}
