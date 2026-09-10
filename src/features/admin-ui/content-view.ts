import type { AdminContentExceptionCode } from "@/contracts";
import {
  ARTICLE_CONTENT_MODES,
  ARTICLE_TYPES,
  type ArticleContentMode,
  type ArticleSeoVisibility,
  type ArticleStatus,
  type ArticleType,
  type LabelKind,
  type NovelChapterStatus,
  type NovelSourceItemStatus,
  type NovelStatus,
} from "@/domain/database-statuses";

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

/**
 * C-20 (`分析_文章管理Parity缺口_2026-09-08.md` §六): the table-cell twin of
 * `article-filters.tsx`'s `ARTICLE_STATUS_LABELS`, and the shared spot both
 * that filter dropdown's option labels and `article-status-badge.tsx`'s
 * table-column badge now read from — replacing a Chinese label that used to
 * live only in the filter component with one location for both.
 *
 * Same four names as `NOVEL_STATUS_BADGES`'s `draft`/`published`/
 * `unpublished`/`takedown` (Article has no `ready` state), and the same
 * colors for each — the analysis doc's item #19 is a straight PORT (裸英文
 * 状态码 → 中文徽章), not an ADAPT, so there is no reason for the two
 * lifecycles' shared state names to read differently.
 */
export const ARTICLE_STATUS_BADGES: Readonly<Record<ArticleStatus, StatusBadge>> = Object.freeze({
  draft: { label: "草稿", color: "bg-gray-100 text-gray-800" },
  published: { label: "已发布", color: "bg-green-100 text-green-800" },
  unpublished: { label: "已下线", color: "bg-amber-100 text-amber-800" },
  takedown: { label: "已撤回", color: "bg-red-100 text-red-800" },
});

/**
 * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
 * table-column badge vocabulary for `Article.seoVisibility`. Labels and
 * colors are copied verbatim from CPS's own two mapping tables
 * (`cps-admin-v851-admin-host`'s `src/lib/constants.ts`'s
 * `SEO_VISIBILITY_LABEL`/`SEO_VISIBILITY_COLORS`) per the analysis doc's
 * explicit "标签与配色照抄 CPS" instruction — this is why these three colors
 * use CPS's own `text-700`/`text-600` shades rather than this file's usual
 * `text-800` convention (see {@link NOVEL_STATUS_BADGES}/
 * {@link ARTICLE_STATUS_BADGES} above): a verbatim-copy instruction takes
 * precedence over this file's own house style for this one vocabulary.
 *
 * `ARTICLE_SEO_VISIBILITY_OPTIONS` below carries the *longer* CPS filter/editor
 * wording (`SEO_VISIBILITY_OPTIONS` in CPS's `src/lib/article-v2-contract.ts`)
 * — CPS deliberately uses two different label sets for the same three values
 * (short badge vs. longer filter-dropdown/editor-pill copy), and this project
 * keeps that same split rather than collapsing it to one.
 */
export const ARTICLE_SEO_VISIBILITY_BADGES: Readonly<Record<ArticleSeoVisibility, StatusBadge>> = Object.freeze({
  public: { label: "公开", color: "bg-green-100 text-green-700" },
  seo_only: { label: "仅 SEO", color: "bg-blue-100 text-blue-700" },
  hidden: { label: "隐藏", color: "bg-gray-100 text-gray-600" },
});

export const ARTICLE_SEO_VISIBILITY_OPTIONS: ReadonlyArray<
  Readonly<{ value: ArticleSeoVisibility; label: string }>
> = Object.freeze([
  { value: "public", label: "公开收录" },
  { value: "seo_only", label: "仅 SEO（不展示）" },
  { value: "hidden", label: "隐藏（noindex）" },
]);

/**
 * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
 * `Article.articleType` vocabulary — filter dropdown option labels AND the
 * list's new "类型" badge column, both sourced from this one label map.
 * Unlike `ARTICLE_SEO_VISIBILITY_BADGES`/`ARTICLE_SEO_VISIBILITY_OPTIONS`
 * above (which deliberately keep CPS's own two *different* label sets — a
 * short badge vocabulary vs. a longer filter/editor one), there is only one
 * CPS label set here (`article-v2-contract.ts`'s `ARTICLE_TYPE_OPTIONS`) —
 * CPS never renders `articleType` as a list badge at all (this column is a
 * cps-novel-only display increment, see the plan's own "这一处是超出 CPS
 * 的展示增量" note), so there is no second CPS wording to preserve
 * separately. One label per value, reused for both surfaces.
 *
 * Labels are copied verbatim from CPS's `ARTICLE_TYPE_OPTIONS`
 * (`cps-admin-v851-admin-host`'s `src/lib/article-v2-contract.ts:182-187`),
 * with the one rename the plan calls out: CPS's `drama_article` → `novel_article`
 * relabels "剧集文章" → "小说文章" (aligning with the template-side rename
 * `src/lib/article-templates/applicable-article-type.ts` already made for
 * P2-02B). `listicle`/`guide` keep CPS's own slash-joined wording
 * ("榜单 / Listicle" / "指南 / Guide") verbatim — the plan's own prose
 * abbreviates these to "榜单 Listicle"/"指南 Guide" only because it is using
 * "/" as the *enumeration* separator between all four option names in one
 * sentence, not as a literal label edit; "选项文案照抄 CPS" and this round's
 * binding "copy CPS wording/values verbatim" instruction both point at the
 * actual CPS source string, not the plan's own inline shorthand for listing
 * it.
 */
export const ARTICLE_TYPE_LABELS: Readonly<Record<ArticleType, string>> = Object.freeze({
  novel_article: "小说文章",
  blog_article: "博客文章",
  listicle: "榜单 / Listicle",
  guide: "指南 / Guide",
});

export const ARTICLE_TYPE_OPTIONS: ReadonlyArray<Readonly<{ value: ArticleType; label: string }>> = Object.freeze(
  ARTICLE_TYPES.map((value) => Object.freeze({ value, label: ARTICLE_TYPE_LABELS[value] })),
);

/**
 * Colors are this repo's own choice (CPS has none to copy here — see the
 * doc comment on {@link ARTICLE_TYPE_LABELS} above): four visually distinct
 * hues not already used together on this same table row
 * ({@link ARTICLE_STATUS_BADGES}/{@link ARTICLE_SEO_VISIBILITY_BADGES} occupy
 * gray/green/amber/red and green/blue/gray respectively).
 */
export const ARTICLE_TYPE_BADGES: Readonly<Record<ArticleType, StatusBadge>> = Object.freeze({
  novel_article: { label: ARTICLE_TYPE_LABELS.novel_article, color: "bg-blue-100 text-blue-800" },
  blog_article: { label: ARTICLE_TYPE_LABELS.blog_article, color: "bg-purple-100 text-purple-800" },
  listicle: { label: ARTICLE_TYPE_LABELS.listicle, color: "bg-pink-100 text-pink-800" },
  guide: { label: ARTICLE_TYPE_LABELS.guide, color: "bg-cyan-100 text-cyan-800" },
});

/**
 * C-26: `Article.contentMode` vocabulary — same "one label map feeds both
 * the filter dropdown and the list badge column" shape as
 * {@link ARTICLE_TYPE_LABELS} above, for the same reason (CPS never renders
 * `contentMode` as a list badge either). Labels copied verbatim from CPS's
 * `CONTENT_MODE_OPTIONS` (`article-v2-contract.ts:209-212`).
 */
export const ARTICLE_CONTENT_MODE_LABELS: Readonly<Record<ArticleContentMode, string>> = Object.freeze({
  manual: "手动编辑",
  template: "使用模板",
});

export const ARTICLE_CONTENT_MODE_OPTIONS: ReadonlyArray<Readonly<{ value: ArticleContentMode; label: string }>> =
  Object.freeze(ARTICLE_CONTENT_MODES.map((value) => Object.freeze({ value, label: ARTICLE_CONTENT_MODE_LABELS[value] })));

/**
 * `manual` gets the amber "needs attention" color deliberately, not an
 * arbitrary pick: it is the same value the batch-再生成 "含手动编辑" warning
 * (`../../app/(admin)/articles/_components/article-list.tsx`) exists to flag
 * before an operator overwrites a human's hand edit — the badge and the
 * warning should read as the same signal at a glance.
 */
export const ARTICLE_CONTENT_MODE_BADGES: Readonly<Record<ArticleContentMode, StatusBadge>> = Object.freeze({
  manual: { label: ARTICLE_CONTENT_MODE_LABELS.manual, color: "bg-amber-100 text-amber-800" },
  template: { label: ARTICLE_CONTENT_MODE_LABELS.template, color: "bg-gray-100 text-gray-600" },
});

export const CHAPTER_STATUS_BADGES: Readonly<Record<NovelChapterStatus, StatusBadge>> =
  Object.freeze({
    preview: { label: "可试读", color: "bg-green-100 text-green-800" },
    locked: { label: "锁定", color: "bg-gray-100 text-gray-800" },
    stale: { label: "上游过期", color: "bg-amber-100 text-amber-800" },
    withdrawn: { label: "已撤回", color: "bg-red-100 text-red-800" },
  });

/**
 * Source-item vocabulary (P0-S13, `/catalog-sync`).
 *
 * Labels are written against `DATABASE_STATUS_SEMANTICS.novel_source_item`
 * (`src/domain/database-statuses.ts`), not guessed: `pending` is "mirrored but
 * not linked to a canonical Novel" — i.e. eligible for content creation —
 * `linked` already has its Novel/Article pair, `ignored` was deliberately
 * excluded without deleting the mirror, and `stale` disappeared from a
 * trustworthy upstream response and is excluded from ordinary selection.
 */
export const NOVEL_SOURCE_ITEM_STATUS_BADGES: Readonly<Record<NovelSourceItemStatus, StatusBadge>> =
  Object.freeze({
    pending: { label: "待创建", color: "bg-blue-100 text-blue-800" },
    linked: { label: "已建立书目", color: "bg-green-100 text-green-800" },
    ignored: { label: "已忽略", color: "bg-gray-100 text-gray-800" },
    stale: { label: "上游已过期", color: "bg-amber-100 text-amber-800" },
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

export {
  ADMIN_DISPLAY_TIME_ZONE,
  ADMIN_DISPLAY_TIME_ZONE_LABEL,
  ADMIN_TIME_ZONE_NOTE,
  formatDateTime,
} from "./datetime";

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : String(value);
}
