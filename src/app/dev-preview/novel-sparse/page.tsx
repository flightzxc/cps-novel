import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_NOVEL_DETAIL_SPARSE } from "@/features/public-ui/fixtures/mock-content";

/**
 * MOCK_ONLY 预览：详情页的极端稀疏情况。
 * 无封面、无标签、无可试读章节、简介只有一句——版面必须仍然成立，
 * 且不得靠任何虚构元数据补密度。
 */
export default function SparseNovelDetailPreviewPage() {
  return <NovelDetailScreen chrome={mockChrome()} novel={MOCK_NOVEL_DETAIL_SPARSE} />;
}
