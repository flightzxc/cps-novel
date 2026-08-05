import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import {
  MOCK_FEATURED_LIST,
  MOCK_NOVEL_CARDS,
} from "@/features/public-ui/fixtures/mock-content";
import {
  devPreviewFirstChapterPath,
  devPreviewNovelPath,
} from "@/features/public-ui/fixtures/preview-paths";

/** MOCK_ONLY 预览：首页页面壳（有横版物料 → 通栏出血 Hero + 轮播） */
export default function HomePreviewPage() {
  return (
    <HomeScreen
      chrome={mockChrome("home")}
      featuredList={MOCK_FEATURED_LIST.map((novel) => ({
        novel,
        detailHref: devPreviewNovelPath(),
        startReadingHref:
          novel.previewChapters.length > 0 ? devPreviewFirstChapterPath() : undefined,
      }))}
      novels={MOCK_NOVEL_CARDS}
      browseAllHref="/dev-preview/collection"
    />
  );
}
