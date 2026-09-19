import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import {
  MOCK_CATEGORIES,
  MOCK_FEATURED_LIST_NO_HERO,
  MOCK_NOVEL_CARDS,
} from "@/features/public-ui/fixtures/mock-content";
import {
  devPreviewFirstChapterPath,
  devPreviewNovelPath,
} from "@/features/public-ui/fixtures/preview-paths";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * MOCK_ONLY 预览：**这是当前生产的正常路径**，不是回落态。
 *
 * 2026-09-19 前：主推列表里一本都没有横版主视觉时，首页整体落回封面编排版
 * （FeaturedNovel），页头回到实底。Owner 已确认海阅不存在、也不会等横版
 * 主视觉素材——渠道只给竖版封面（实测全部 250×350）——继续把这种情况当
 * 「回落」，等于让首页主推位永久停在这个所谓的例外态。
 *
 * 现在同样这份夹具（一本都没有 heroImageUrl，但都有 coverUrl）验证的是：
 * Hero 恒渲染、页头维持浮起态，每一项用竖封面做强模糊氛围底。这份夹具本来
 * 就没有 heroImageUrl、有 coverUrl，正好用来验证三档来源优先级里的第二档。
 */
export default function HomeFallbackPreviewPage() {
  return (
    <HomeScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE, "home")}
      featuredList={MOCK_FEATURED_LIST_NO_HERO.map((novel) => ({
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
