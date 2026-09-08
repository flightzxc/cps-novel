import type { ArticleSeoVisibility } from "@/domain/database-statuses";
import { ARTICLE_SEO_VISIBILITY_BADGES } from "@/features/admin-ui/content-view";

/**
 * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
 * the article list's "SEO 可见性" column badge — same pill geometry and
 * "shared vocabulary, per-domain component" split as `./article-status-badge.tsx`'s
 * `ArticleStatusBadge` (that file's own doc comment explains why the pill
 * class string is copied rather than imported across the `novels`-scoped
 * boundary; this component keeps the same discipline).
 */
const PILL = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium";

export function ArticleSeoVisibilityBadge({ seoVisibility }: { seoVisibility: ArticleSeoVisibility }) {
  const badge = ARTICLE_SEO_VISIBILITY_BADGES[seoVisibility];
  return (
    <span className={`${PILL} ${badge.color}`} data-testid={`article-seo-visibility-${seoVisibility}`}>
      {badge.label}
    </span>
  );
}
