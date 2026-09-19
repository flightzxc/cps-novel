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
 * MOCK_ONLY 预览：主推**恰好两本**的边界态。
 *
 * 这一档单独留一个预览页，是因为它是露头轮播里唯一需要特判的数量：
 *   1 本  → 不露头（`/dev-preview/home-hero-plain` 那类单项场景）
 *   2 本  → **单侧**预览。做环形的话左右露出的会是同一本邻居，等于把同一本书
 *           复制到两边；所以只渲染一份，当前项在第 1 本时右侧露第 2 本，
 *           在第 2 本时左侧露第 1 本。
 *   ≥3 本 → 环形，左右各有一个不同的邻居（`/dev-preview/home`）
 *
 * 判据写在 `FeaturedHero` 的 `useLoop = count >= 3`。改那行务必回来看这一页。
 */
export default function HomeTwoFeaturedPreviewPage() {
  return (
    <HomeScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE, "home")}
      featuredList={MOCK_FEATURED_LIST.slice(0, 2).map((novel) => ({
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
