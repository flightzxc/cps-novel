import type { ArticleStatus } from "@/domain/database-statuses";
import { ARTICLE_STATUS_BADGES } from "@/features/admin-ui/content-view";

/**
 * C-20 (`分析_文章管理Parity缺口_2026-09-08.md` §六, item #19): the article
 * list's status column used to render the raw English status code
 * (`draft`/`published`/…) — this renders the shared
 * `ARTICLE_STATUS_BADGES` Chinese label instead, as a colored pill.
 *
 * Same pill geometry as `../../novels/_components/content-badges.tsx`'s
 * `NovelStatusBadge` (`inline-flex rounded-full px-2 py-0.5 text-xs
 * font-medium`) — copied rather than imported across that `novels`-scoped
 * file boundary, the same discipline `article-filters.tsx` already
 * documents for `NOVEL_STATUS_BADGES` itself.
 */
const PILL = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium";

export function ArticleStatusBadge({ status }: { status: ArticleStatus }) {
  const badge = ARTICLE_STATUS_BADGES[status];
  return (
    <span className={`${PILL} ${badge.color}`} data-testid={`article-status-${status}`}>
      {badge.label}
    </span>
  );
}
