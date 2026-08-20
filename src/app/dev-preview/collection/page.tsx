import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_NOVEL_CARDS } from "@/features/public-ui/fixtures/mock-content";
import { getPublicT } from "@/lib/locale/messages";

/** MOCK_ONLY 预览：语言 / 题材聚合（两者共用同一个屏幕与同一种卡片） */
export default function CollectionPreviewPage() {
  const t = getPublicT();
  return (
    <CollectionScreen
      chrome={mockChrome("collection")}
      title="Romance"
      description={t("collection.genreDescription")}
      novels={MOCK_NOVEL_CARDS}
    />
  );
}
