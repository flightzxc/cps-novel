import Link from "next/link";

import type { AdminNovelListItemView } from "@/contracts";
import { formatDateTime, taskStatusLabel } from "@/features/admin-ui/content-view";

import { ExceptionBadges, NovelStatusBadge } from "./content-badges";

/**
 * Optional selection column, driven entirely by the caller — this component
 * never owns selection state itself. Omitting this prop (the default for
 * every call site until PR-C3) renders exactly the markup it always has: no
 * checkbox column, no `<input>` anywhere, which is what
 * `tests/ui/admin-novels-list.test.tsx`'s "每行只提供查看入口，不提供任何写操作控件"
 * still asserts for that zero-prop call.
 */
export type NovelsTableSelection = {
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (novelId: string) => void;
  /** True disables (not hides) that row's checkbox — a row mid-request, for instance. */
  readonly disabled?: (novel: AdminNovelListItemView) => boolean;
  readonly allSelected: boolean;
  readonly someSelected: boolean;
  readonly onToggleAll: () => void;
};

/**
 * Novel list table.
 *
 * Layout is CPS parity with `dramas-list-client.tsx:199-360`: `bg-gray-50`
 * header, `divide-y divide-gray-100` body, `px-4 py-3` cells, a two-line
 * identity cell (name over id) and a right-aligned actions column.
 *
 * One CPS feature is deliberately still absent:
 *
 * - **No edit or delete icon.** The actions column holds a single "查看" link.
 *
 * The other — selection checkboxes — is no longer absent as of PR-C3: P2-04's
 * original header here explained the omission as "P2-04 implements no
 * mutation, so a checkbox column would be a control that selects rows for
 * nothing." PR-C3 is that mutation (batch publish), so the column exists now,
 * strictly opt-in via {@link NovelsTableSelection} — see that type's doc
 * comment for why every pre-existing call site is unaffected. The header
 * checkbox (C-17, 2026-09-08) is also aligned with CPS
 * `dramas-list-client.tsx:202-211`: `checked`/`indeterminate` driven by the
 * caller's `allSelected`/`someSelected`, `onChange` wired to `onToggleAll`.
 *
 * The columns themselves are `CPS_PARITY_ADAPTED`. CPS shows 平台/题材/分类/集数;
 * a novel's operational questions are different — how many chapters actually
 * landed versus what upstream claims, how many are materialised for preview, and
 * whether the last sync left an exception behind.
 */
export function NovelsTable({
  novels,
  selection,
}: {
  novels: readonly AdminNovelListItemView[];
  selection?: NovelsTableSelection;
}) {
  if (novels.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center text-gray-400 shadow-sm">
        没有符合条件的书目
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            {selection && (
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="选择当前页"
                  checked={selection.allSelected}
                  disabled={selection.disabled?.(novels[0]) ?? false}
                  ref={(el) => {
                    if (el) el.indeterminate = selection.someSelected && !selection.allSelected;
                  }}
                  onChange={selection.onToggleAll}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </th>
            )}
            <th className="px-4 py-3 text-left font-medium text-gray-500">书目</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">语种</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">章节</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">试读落地</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">同步</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">异常</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">更新时间</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {novels.map((novel) => (
            <tr key={novel.novelId} className="hover:bg-gray-50">
              {selection && (
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${novel.title}`}
                    data-testid={`novel-select-${novel.novelId}`}
                    checked={selection.selected.has(novel.novelId)}
                    disabled={selection.disabled?.(novel) ?? false}
                    onChange={() => selection.onToggle(novel.novelId)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                </td>
              )}
              <td className="px-4 py-3">
                <p className="font-medium text-gray-900">{novel.title}</p>
                <p className="text-xs text-gray-400">{novel.businessId}</p>
                <p className="text-xs text-gray-400">/{novel.slug}</p>
              </td>
              <td className="px-4 py-3 text-gray-600">{novel.locale}</td>
              <td className="px-4 py-3">
                <NovelStatusBadge status={novel.status} />
              </td>
              <td className="px-4 py-3 text-gray-600">
                {/*
                  Both numbers, always. `totalChapterCount` is upstream's claim
                  and `chapterRowCount` is what exists locally; showing only one
                  hides an incomplete catalogue sync.
                */}
                <span data-testid={`chapter-rows-${novel.novelId}`}>{novel.chapterRowCount}</span>
                <span className="text-gray-400"> / {novel.totalChapterCount}</span>
              </td>
              <td className="px-4 py-3 text-gray-600">
                <span data-testid={`materialized-${novel.novelId}`}>
                  {novel.preview.materializedChapterCount}
                </span>
                {novel.preview.policyCountMatchesActual === false && (
                  <span className="ml-1 text-xs text-purple-700">
                    （策略 {novel.preview.policyChapterCount}）
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-xs text-gray-500">
                {novel.sync.latestTask ? (
                  <>
                    <p>{taskStatusLabel(novel.sync.latestTask.taskStatus)}</p>
                    <p className="text-gray-400">
                      {formatDateTime(novel.sync.latestTask.updatedAt)}
                    </p>
                  </>
                ) : (
                  <span className="text-gray-400">无同步记录</span>
                )}
                <p className="text-gray-400">来源 {novel.sync.sourceItemCount}</p>
              </td>
              <td className="px-4 py-3">
                <ExceptionBadges exceptions={novel.sync.exceptions} />
              </td>
              <td className="px-4 py-3 text-gray-500">{formatDateTime(novel.updatedAt)}</td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={`/novels/${novel.novelId}`}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  查看
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
