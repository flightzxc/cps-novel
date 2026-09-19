import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import {
  MOCK_CATEGORIES,
  MOCK_FEATURED_LIST_NO_IMAGE,
  MOCK_NOVEL_CARDS,
} from "@/features/public-ui/fixtures/mock-content";
import {
  devPreviewFirstChapterPath,
  devPreviewNovelPath,
} from "@/features/public-ui/fixtures/preview-paths";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * MOCK_ONLY 预览：首页 Hero 三档来源优先级里最兜底的一档——
 * 主推项既没有 heroImageUrl 也没有 coverUrl。
 *
 * Hero 仍然整体渲染（轮播、标题、简介、CTA 都在），只是不渲染任何图层，
 * 纯 `--novel-bg` 打底。真实生产数据不会走到这条路径——`getHomeCarouselItems`
 * 要求 `coverUrl` 非空才会把一篇文章放进轮播——这个预览只读的意义在于让
 * `FeaturedHero` 的第三档分支不是一段没人看过的代码。
 */
export default function HomeHeroPlainPreviewPage() {
  return (
    <HomeScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE, "home")}
      featuredList={MOCK_FEATURED_LIST_NO_IMAGE.map((novel) => ({
        novel,
        detailHref: devPreviewNovelPath(),
        startReadingHref:
          novel.previewChapters.length > 0 ? devPreviewFirstChapterPath() : undefined,
      }))}
      novels={MOCK_NOVEL_CARDS}
      browseAllHref="/dev-preview/collection"
      categories={MOCK_CATEGORIES}
    />
  );
}
