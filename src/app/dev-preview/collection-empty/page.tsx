import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { getPublicT } from "@/lib/locale/messages";

/** MOCK_ONLY 预览：聚合页的空状态 */
export default function EmptyCollectionPreviewPage() {
  const t = getPublicT();
  return (
    <CollectionScreen
      chrome={mockChrome("collection")}
      title="Suspense"
      description={t("collection.genreDescription")}
      novels={[]}
      emptyMessage={t("collection.genreEmpty")}
    />
  );
}
