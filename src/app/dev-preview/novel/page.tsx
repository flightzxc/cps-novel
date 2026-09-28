import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import { MOCK_NOVEL_CARDS, MOCK_NOVEL_DETAIL } from "@/features/public-ui/fixtures/mock-content";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

/**
 * MOCK_ONLY 预览：小说详情页。
 *
 * A4/B3（运营前端与 SEO 优化第一轮）：相关推荐 / 新书推荐传入假数据，用于
 * 人工验收两个模块的版面——生产路径的真实数据由
 * `src/app/_pages/novel-detail.tsx` 的 `loadRelatedAndNewReleases` 提供，
 * 这里只是让 dev-preview 能看到有数据时的版面。
 *
 * 🔴 两段切片不重叠（2026-09-29 主控复核）：`MOCK_NOVEL_CARDS` 共 10 本，
 * `related` 取前 6 本、`newReleases` 取剩下 4 本——同一本书不会同时出现在
 * 两个模块里，人工验收时不会被"两个模块显示了同一批书"误导。
 */
export default function NovelDetailPreviewPage() {
  return (
    <NovelDetailScreen
      locale={PUBLIC_SITE_LOCALE}
      chrome={mockChrome(PUBLIC_SITE_LOCALE)}
      novel={MOCK_NOVEL_DETAIL}
      related={MOCK_NOVEL_CARDS.slice(0, 6)}
      newReleases={MOCK_NOVEL_CARDS.slice(6, 10)}
    />
  );
}
