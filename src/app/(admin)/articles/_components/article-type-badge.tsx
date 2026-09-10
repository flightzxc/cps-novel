import type { ArticleType } from "@/domain/database-statuses";
import { ARTICLE_TYPE_BADGES } from "@/features/admin-ui/content-view";

/**
 * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
 * the article list's "类型" column badge — same pill geometry and "shared
 * vocabulary, per-domain component" split as `./article-status-badge.tsx`'s
 * `ArticleStatusBadge`/`./article-seo-visibility-badge.tsx`'s
 * `ArticleSeoVisibilityBadge` (both files' own doc comments explain why the
 * pill class string is copied rather than imported across the
 * `novels`-scoped boundary; this component keeps the same discipline).
 */
const PILL = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium";

export function ArticleTypeBadge({ articleType }: { articleType: ArticleType }) {
  const badge = ARTICLE_TYPE_BADGES[articleType];
  return (
    <span className={`${PILL} ${badge.color}`} data-testid={`article-type-${articleType}`}>
      {badge.label}
    </span>
  );
}
