import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_NOVEL_CARDS } from "@/features/public-ui/fixtures/mock-content";

/** MOCK_ONLY 预览：语言 / 题材聚合（两者共用同一个屏幕与同一种卡片） */
export default function CollectionPreviewPage() {
  return (
    <CollectionScreen
      chrome={mockChrome("collection")}
      title="言情"
      description="这个题材下当前可以阅读的全部作品。"
      novels={MOCK_NOVEL_CARDS}
    />
  );
}
