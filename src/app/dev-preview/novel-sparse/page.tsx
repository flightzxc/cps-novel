import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_NOVEL_DETAIL_SPARSE } from "@/features/public-ui/fixtures/mock-content";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * MOCK_ONLY 预览：详情页的极端稀疏情况。
 * 无封面、无标签、无可试读章节、简介只有一句——版面必须仍然成立，
 * 且不得靠任何虚构元数据补密度。
 */
export default function SparseNovelDetailPreviewPage() {
  return (
    <NovelDetailScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE)}
      novel={MOCK_NOVEL_DETAIL_SPARSE}
    />
  );
}
