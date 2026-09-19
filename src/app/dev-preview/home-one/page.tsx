import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import {
  MOCK_CATEGORIES,
  MOCK_FEATURED_LIST,
  MOCK_NOVEL_CARDS,
} from "@/features/public-ui/fixtures/mock-content";
import {
  devPreviewFirstChapterPath,
  devPreviewNovelPath,
} from "@/features/public-ui/fixtures/preview-paths";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * MOCK_ONLY 预览：主推**恰好一本**的边界态。
 *
 * 这是露头轮播三档数量里最小的一档（另两档见 `/dev-preview/home-two` 与
 * `/dev-preview/home`）：
 *   1 本  → 不露头、不渲染 dots。做环形的话左右露出的都是它自己。
 *   2 本  → 单侧预览
 *   ≥3 本 → 环形，左右各一个不同的邻居
 *
 * 判据写在 `FeaturedHero` 的 `useLoop = count >= 3` 与 `count > 1 ? dots`。
 *
 * 这一档单独留一页，还因为它是 Hero 高度的一个验算点：2026-09-20 首屏密度轮
 * 把 Hero 从「居中自平衡」改成显式 pt/pb 之后，banner 顶沿不再随 dots 的有无
 * 浮动——这一页与 `/dev-preview/home` 的 banner 应该落在同一个 y 上。
 */
export default function HomeOneFeaturedPreviewPage() {
  return (
    <HomeScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE, "home")}
      featuredList={MOCK_FEATURED_LIST.slice(0, 1).map((novel) => ({
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
