import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";

/** MOCK_ONLY 预览：聚合页的空状态 */
export default function EmptyCollectionPreviewPage() {
  return (
    <CollectionScreen
      chrome={mockChrome("collection")}
      title="悬疑"
      description="这个题材下当前可以阅读的全部作品。"
      novels={[]}
      emptyMessage="这个题材下暂时没有可以阅读的作品。"
    />
  );
}
