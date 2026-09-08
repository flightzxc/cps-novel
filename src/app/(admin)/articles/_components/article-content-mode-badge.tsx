import type { ArticleContentMode } from "@/domain/database-statuses";
import { ARTICLE_CONTENT_MODE_BADGES } from "@/features/admin-ui/content-view";

/**
 * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
 * the article list's "内容模式" column badge — same pill geometry and
 * "shared vocabulary, per-domain component" split as `./article-status-badge.tsx`'s
 * `ArticleStatusBadge`. This badge's whole reason for existing (per the
 * plan's business narrative) is letting an operator spot "手动编辑" rows at a
 * glance before a batch re-generate would silently overwrite them — see
 * `./article-list.tsx`'s "含手动编辑" warning next to the 批量再生成 button,
 * which reads the same underlying field.
 */
const PILL = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium";

export function ArticleContentModeBadge({ contentMode }: { contentMode: ArticleContentMode }) {
  const badge = ARTICLE_CONTENT_MODE_BADGES[contentMode];
  return (
    <span className={`${PILL} ${badge.color}`} data-testid={`article-content-mode-${contentMode}`}>
      {badge.label}
    </span>
  );
}
