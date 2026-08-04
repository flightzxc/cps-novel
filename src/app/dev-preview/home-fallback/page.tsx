import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import {
  MOCK_FEATURED_LIST_NO_HERO,
  MOCK_NOVEL_CARDS,
} from "@/features/public-ui/fixtures/mock-content";

/**
 * MOCK_ONLY 预览：首页的**回落形态**。
 *
 * 主推列表里一本都没有横版主视觉 → 整体落回封面编排版（FeaturedNovel），
 * 页头也回到实底。回落必须是一个完整成立的版面，不是「Hero 少了张图」的残缺态。
 */
export default function HomeFallbackPreviewPage() {
  return (
    <HomeScreen
      chrome={mockChrome("home")}
      featuredList={MOCK_FEATURED_LIST_NO_HERO.map((novel) => ({
        novel,
        detailHref: "/dev-preview/novel",
        startReadingHref: novel.previewChapters.length > 0 ? "/dev-preview/chapter" : undefined,
      }))}
      novels={MOCK_NOVEL_CARDS}
      browseAllHref="/dev-preview/collection"
    />
  );
}
