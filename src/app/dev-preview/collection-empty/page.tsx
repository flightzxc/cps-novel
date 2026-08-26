import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/** MOCK_ONLY 预览：聚合页的空状态 */
export default function EmptyCollectionPreviewPage() {
  const t = getPublicT(PUBLIC_SITE_LOCALE);
  return (
    <CollectionScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE, "collection")}
      title="Suspense"
      description={t("collection.genreDescription")}
      novels={[]}
      emptyMessage={t("collection.genreEmpty")}
    />
  );
}
