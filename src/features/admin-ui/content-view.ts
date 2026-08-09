import type { AdminContentExceptionCode } from "@/contracts";
import type { LabelKind, NovelChapterStatus, NovelStatus } from "@/domain/database-statuses";

/**
 * Presentation vocabulary for the content-management screens.
 *
 * Shape is CPS parity: `{ label, color }` keyed by the raw status value, exactly
 * like CPS `src/lib/constants.ts:26` (`COMMON_STATUS_MAP`) and its siblings, so
 * a badge is a lookup rather than a chain of ternaries. The *values* are not
 * parity — CPS has a two-state active/inactive axis and novels have a five-state
 * lifecycle, so each label is written against
 * `DATABASE_STATUS_SEMANTICS.novel` rather than guessed from the CPS wording.
 */
export type StatusBadge = { readonly label: string; readonly color: string };

export const NOVEL_STATUS_BADGES: Readonly<Record<NovelStatus, StatusBadge>> = Object.freeze({
  draft: { label: "草稿", color: "bg-gray-100 text-gray-800" },
  ready: { label: "就绪未公开", color: "bg-blue-100 text-blue-800" },
  published: { label: "已发布", color: "bg-green-100 text-green-800" },
  unpublished: { label: "已下线", color: "bg-amber-100 text-amber-800" },
  takedown: { label: "已撤回", color: "bg-red-100 text-red-800" },
});

export const CHAPTER_STATUS_BADGES: Readonly<Record<NovelChapterStatus, StatusBadge>> =
  Object.freeze({
    preview: { label: "可试读", color: "bg-green-100 text-green-800" },
    locked: { label: "锁定", color: "bg-gray-100 text-gray-800" },
    stale: { label: "上游过期", color: "bg-amber-100 text-amber-800" },
    withdrawn: { label: "已撤回", color: "bg-red-100 text-red-800" },
  });

/**
 * Source-label kind vocabulary (P2-06).
 *
 * Same lookup shape as {@link NOVEL_STATUS_BADGES}: `source_label` carries no
 * Chinese label of its own — it is an unexplained upstream dictionary — so
 * these four strings are authored here rather than derived from
 * `DATABASE_STATUS_SEMANTICS`, which has no `source_label` entry to derive
 * from. `language` deliberately does not become a code → language-name map:
 * that mapping already has one source of truth, `locale-canonical.ts`, and a
 * second one here would be exactly the drift it exists to prevent. This badge
 * only ever labels the *kind* "language", never a language value.
 */
export const LABEL_KIND_BADGES: Readonly<Record<LabelKind, StatusBadge>> = Object.freeze({
  series_type: { label: "题材", color: "bg-indigo-100 text-indigo-800" },
  recommend: { label: "推荐位", color: "bg-pink-100 text-pink-800" },
  language: { label: "语言", color: "bg-cyan-100 text-cyan-800" },
  agency: { label: "机构", color: "bg-teal-100 text-teal-800" },
});

/**
 * Exception codes are the whole point of the sync column.
 *
 * Each carries the operator-facing consequence, not a restatement of the code:
 * "同步任务失败" says what happened, `chapter_materialization_failed` does not.
 */
export const CONTENT_EXCEPTION_BADGES: Readonly<
  Record<AdminContentExceptionCode, StatusBadge>
> = Object.freeze({
  source_item_stale: { label: "上游条目过期", color: "bg-amber-100 text-amber-800" },
  chapter_materialization_failed: { label: "章节落地失败", color: "bg-red-100 text-red-800" },
  sync_item_failed: { label: "同步条目失败", color: "bg-red-100 text-red-800" },
  sync_task_failed: { label: "同步任务失败", color: "bg-red-100 text-red-800" },
  sync_completed_with_errors: { label: "同步部分失败", color: "bg-amber-100 text-amber-800" },
  preview_count_mismatch: { label: "试读计数不符", color: "bg-purple-100 text-purple-800" },
});

const TASK_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pending: "待处理",
  processing: "处理中",
  completed: "已完成",
  completed_with_errors: "部分失败",
  failed: "失败",
  disabled: "已停用",
  success: "成功",
  skipped: "已跳过",
});

const TASK_MODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  dry_run: "演练",
  apply: "执行",
});

/** Unknown values pass through verbatim: inventing a label would hide new data. */
export function taskStatusLabel(value: string): string {
  return TASK_STATUS_LABELS[value] ?? value;
}

export function taskModeLabel(value: string): string {
  return TASK_MODE_LABELS[value] ?? value;
}

/**
 * CPS `src/lib/utils.ts:10` `formatDate`, ported verbatim in behaviour.
 *
 * The `zh-CN` locale and the `-` for empty are both deliberate: operators read
 * these tables next to CPS all day, and a different empty marker or date order
 * across the two backends is a real source of misreading.
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : String(value);
}
