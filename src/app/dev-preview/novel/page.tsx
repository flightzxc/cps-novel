import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_NOVEL_DETAIL } from "@/features/public-ui/fixtures/mock-content";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * MOCK_ONLY 预览：小说详情页。
 *
 * 推荐区块刻意不传数据——本轮不接推荐，无数据即整块不渲染，不留空框。
 */
export default function NovelDetailPreviewPage() {
  return (
    <NovelDetailScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE)}
      novel={MOCK_NOVEL_DETAIL}
    />
  );
}
