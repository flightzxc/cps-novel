import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_NOVEL_DETAIL } from "@/features/public-ui/fixtures/mock-content";

/**
 * MOCK_ONLY 预览：小说详情页。
 *
 * 推荐区块刻意不传数据——本轮不接推荐，无数据即整块不渲染，不留空框。
 */
export default function NovelDetailPreviewPage() {
  return <NovelDetailScreen chrome={mockChrome()} novel={MOCK_NOVEL_DETAIL} />;
}
