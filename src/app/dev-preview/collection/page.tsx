import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_NOVEL_CARDS } from "@/features/public-ui/fixtures/mock-content";
import { getPublicT } from "@/lib/locale/messages";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/** MOCK_ONLY 预览：语言 / 题材聚合（两者共用同一个屏幕与同一种卡片） */
export default function CollectionPreviewPage() {
  const t = getPublicT(PUBLIC_SITE_LOCALE);
  return (
    <CollectionScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE, "collection")}
      title="Romance"
      description={t("collection.genreDescription")}
      novels={MOCK_NOVEL_CARDS}
    />
  );
}
