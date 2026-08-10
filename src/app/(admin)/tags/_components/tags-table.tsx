import Link from "next/link";

import type { AdminSourceLabelView } from "@/contracts";

import type { TagActivityFilter } from "./tag-filters";
import { LabelKindBadge } from "./tag-badges";

/**
 * Source-label dictionary table.
 *
 * Layout is CPS parity with `/novels`' `NovelsTable`: `bg-gray-50` header,
 * `divide-y divide-gray-100` body, `px-4 py-3` cells. Density is CPS-`/tags`
 * parity (`components/tags/tags-client.tsx`): a mono primary-identity cell, a
 * colour-pill kind column, and a bare-number count column.
 *
 * Four columns, and the row-trailing link is deliberately not a fifth
 * "operations" column in spirit — there is nothing here to operate on. It is a
 * cross-reference into `/novels?labelId=…`, the same kind of read-only jump
 * `NovelsTable` already makes from a row to its detail page. No create, edit,
 * delete or merge control exists anywhere on this screen; P2-06 is a read
 * vertical slice over `source_label`, same as P2-04 was for `novel`.
 *
 * ## Known ambiguity: `external_label_value` is not a dictionary key by itself
 *
 * `source_label`'s unique index is `(channel_app_id, label_kind,
 * external_label_value)` — see `prisma/schema.prisma`
 * `source_label_identity_key`. The *same* raw value under the *same* kind can
 * legitimately be two different rows if two different channel apps both
 * returned it; today there is exactly one channel app in the data so every
 * value happens to look unique, but that is an artefact of the current
 * dataset, not a guarantee. This table intentionally has no `channel_app`
 * column and does not group or de-duplicate by `externalLabelValue` — each row
 * is one `labelId`, and the "查看关联小说" link is keyed on that `labelId`. If a
 * future channel app introduces a same-named row, do **not** "fix" this into a
 * `GROUP BY externalLabelValue`: that would merge two distinct upstream
 * dictionary entries into one link target and silently point an operator at
 * the wrong novel set.
 */
export function TagsTable({
  labels,
  activity,
}: {
  labels: readonly AdminSourceLabelView[];
  activity: TagActivityFilter;
}) {
  if (labels.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center shadow-sm">
        <p className="text-gray-400">
          {activity === "history" ? "暂无历史标签" : "没有符合条件的标签"}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-500">标签原值</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">类型</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">展示名</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">关联小说数</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">
              <span className="sr-only">关联小说</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {labels.map((label) => (
            <tr key={label.labelId} className="hover:bg-gray-50">
              <td className="px-4 py-3">
                <span className="font-mono text-sm font-medium text-gray-900">
                  {label.externalLabelValue}
                </span>
                <span className="ml-2 text-xs text-gray-400">{label.labelId}</span>
              </td>
              <td className="px-4 py-3">
                <LabelKindBadge kind={label.labelKind} />
              </td>
              <td className="px-4 py-3 text-gray-600">
                {/*
                  No `?? label.externalLabelValue` fallback here, on purpose.
                  The raw value and the display name are different fields: the
                  raw value is the token the channel sent, the display name is
                  the channel's own readable name for it, and only `language`
                  and `agency` carry one at all. Substituting the raw value
                  where no display name exists would read to an operator as
                  "this row has a display name," which is false and is exactly
                  the kind of compensating UI this project forbids. A missing
                  display name renders as "—", nothing more.
                */}
                {label.displayValue ?? <span className="text-gray-400">—</span>}
              </td>
              <td className="px-4 py-3 text-gray-600" data-testid={`novel-count-${label.labelId}`}>
                {label.novelCount}
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={`/novels?labelId=${encodeURIComponent(label.labelId)}`}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  data-testid={`view-linked-novels-${label.labelId}`}
                >
                  查看关联小说
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
