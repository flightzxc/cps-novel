import type { AdminContentExceptionCode } from "@/contracts";
import type { NovelChapterStatus, NovelStatus } from "@/domain/database-statuses";
import {
  CHAPTER_STATUS_BADGES,
  CONTENT_EXCEPTION_BADGES,
  NOVEL_STATUS_BADGES,
} from "@/features/admin-ui/content-view";

/**
 * Badge geometry is CPS parity — `rounded-full px-2 py-0.5 text-xs font-medium`,
 * the same pill CPS `dramas-list-client.tsx:305` renders — so a status reads the
 * same at a glance in either backend.
 */
const PILL = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium";

export function NovelStatusBadge({ status }: { status: NovelStatus }) {
  const badge = NOVEL_STATUS_BADGES[status];
  return (
    <span className={`${PILL} ${badge.color}`} data-testid={`novel-status-${status}`}>
      {badge.label}
    </span>
  );
}

export function ChapterStatusBadge({ status }: { status: NovelChapterStatus }) {
  const badge = CHAPTER_STATUS_BADGES[status];
  return (
    <span className={`${PILL} ${badge.color}`} data-testid={`chapter-status-${status}`}>
      {badge.label}
    </span>
  );
}

/**
 * An empty exception list renders "无异常" rather than nothing.
 *
 * A blank cell is ambiguous between "checked, clean" and "not evaluated", and
 * the whole reason this column exists is to be scanned down a page of twenty.
 */
export function ExceptionBadges({
  exceptions,
}: {
  exceptions: readonly AdminContentExceptionCode[];
}) {
  if (exceptions.length === 0) {
    return <span className="text-xs text-gray-400">无异常</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {exceptions.map((code) => {
        const badge = CONTENT_EXCEPTION_BADGES[code];
        return (
          <span key={code} className={`${PILL} ${badge.color}`} data-testid={`exception-${code}`}>
            {badge.label}
          </span>
        );
      })}
    </div>
  );
}
