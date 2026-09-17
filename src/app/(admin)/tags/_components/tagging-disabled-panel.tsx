import { taggingFlagChecklist, type TaggingFlagState } from "../_lib/tagging-flag-checklist";

/**
 * Rendered instead of the page's real content when
 * `FEATURE_P2_06_5_TAGGING` is off -- same "envName / on / note" checklist
 * shape and amber-panel-with-badge-rows visual language as
 * `catalog-sync/_components/catalog-scan-trigger-form.tsx`'s `FlagChecklist`,
 * so an operator who has seen that one on `/catalog-sync` recognizes this
 * one immediately.
 *
 * This is a pure display component (no `"use client"`, no state) so
 * `/categories`, `/tags/canonical` and `/tags/mappings` (all Server
 * Components) can render it directly without ever calling into
 * `@/server/tagging/admin-service`.
 */
export function TaggingDisabledPanel({
  state,
  title = "标签功能当前未启用",
}: {
  state: TaggingFlagState;
  title?: string;
}) {
  return (
    <div
      role="status"
      data-testid="tagging-disabled-panel"
      className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-8"
    >
      <h2 className="text-sm font-semibold text-amber-900">{title}</h2>
      <p className="mt-2 text-sm text-amber-800">
        这不是数据问题，而是运行配置未开启对应 Feature Flag。请对照下方状态开启所需项后刷新页面。
      </p>
      <ul className="mt-3 space-y-1.5 text-xs">
        {taggingFlagChecklist(state).map((row) => (
          <li key={row.envName} data-testid={`tagging-flag-row-${row.envName}`} className="flex items-start gap-1.5">
            <span
              className={`mt-0.5 inline-flex shrink-0 rounded px-1.5 py-0.5 font-mono font-medium ${
                row.on ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
              }`}
            >
              {row.on ? "已开启" : "未开启"}
            </span>
            <span>
              <code>{row.envName}</code> — {row.note}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Shown above an otherwise-normal read-only page when the master read gate
 * is on but the write gate is off -- data renders as usual; only the write
 * UI beneath it is disabled (each client component folds `writeEnabled` into
 * its own capability check and explains why next to the disabled control,
 * so this banner only needs to set expectations up front, not duplicate that
 * explanation).
 */
export function TaggingWriteDisabledNotice() {
  return (
    <p
      role="status"
      data-testid="tagging-write-disabled-notice"
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      标签管理写入功能当前未开启（<code>FEATURE_P2_06_5_TAG_ADMIN_WRITE</code>
      =false）。以下为只读视图，编辑按钮已禁用。
    </p>
  );
}
