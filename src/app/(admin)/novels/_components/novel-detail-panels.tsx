import type { AdminNovelDetailView, AdminNovelLabelView } from "@/contracts";
import { LABEL_KINDS, type LabelKind } from "@/domain/database-statuses";
import {
  formatDateTime,
  LABEL_KIND_BADGES,
  taskModeLabel,
  taskStatusLabel,
} from "@/features/admin-ui/content-view";

import { ExceptionBadges, NovelStatusBadge } from "./content-badges";

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
        {title}
      </h2>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-28 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-gray-900">{children}</dd>
    </div>
  );
}

function yesNo(value: boolean): string {
  return value ? "是" : "否";
}

/**
 * Identity, lifecycle and description.
 *
 * `author`, `completionStatus`, `country` and `region` exist on the novel row
 * and are *not* rendered here. They are absent from `AdminNovelDetailView`
 * entirely, so this panel could not show them even by accident — see the
 * subtraction table in `src/contracts/admin-content.ts`.
 */
export function NovelIdentityPanel({ novel }: { novel: AdminNovelDetailView }) {
  return (
    <Panel title="书目身份">
      <dl>
        <Field label="标题">{novel.title}</Field>
        <Field label="业务 ID">
          <span className="font-mono text-xs">{novel.businessId}</span>
        </Field>
        <Field label="Slug">
          <span className="font-mono text-xs">/{novel.slug}</span>
        </Field>
        <Field label="语种">{novel.locale}</Field>
        <Field label="生命周期">
          <NovelStatusBadge status={novel.status} />
        </Field>
        <Field label="章节数">
          {novel.chapterRowCount} / 上游声明 {novel.totalChapterCount}
        </Field>
        <Field label="创建时间">{formatDateTime(novel.createdAt)}</Field>
        <Field label="更新时间">{formatDateTime(novel.updatedAt)}</Field>
        <Field label="简介">
          {novel.description ? (
            <p className="whitespace-pre-wrap text-sm leading-6">{novel.description}</p>
          ) : (
            <span className="text-gray-400">-</span>
          )}
        </Field>
      </dl>
    </Panel>
  );
}

/**
 * Preview policy beside the materialisation that actually happened.
 *
 * When the two counts disagree the mismatch is called out inline rather than
 * left for the reader to spot: that gap is what `preview_count_mismatch` fires
 * on, and it means the public preview surface and the policy disagree about how
 * much of the book is readable.
 */
export function NovelPreviewPanel({ novel }: { novel: AdminNovelDetailView }) {
  const policy = novel.previewPolicy;
  return (
    <Panel title="试读授权">
      {policy ? (
        <dl>
          <Field label="落地策略">{policy.materializationPolicy}</Field>
          <Field label="策略章节数">{policy.materializedChapterCount}</Field>
          <Field label="实际落地">
            <span data-testid="detail-materialized">
              {novel.preview.materializedChapterCount}
            </span>
            {novel.preview.policyCountMatchesActual === false && (
              <span className="ml-2 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                与策略不符
              </span>
            )}
          </Field>
          <Field label="可展示章节">{novel.preview.displayableChapterCount}</Field>
          <Field label="展示授权">{yesNo(policy.displayAuthorized)}</Field>
          <Field label="索引授权">{yesNo(policy.indexAuthorized)}</Field>
          <Field label="缓存授权">{yesNo(policy.cacheAuthorized)}</Field>
          <Field label="上限">{policy.maxMaterializedChapters}</Field>
          <Field label="最近刷新">{formatDateTime(policy.lastRefreshedAt)}</Field>
        </dl>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-500" data-testid="preview-policy-absent">
            该书目尚未登记试读策略。
          </p>
          <dl>
            <Field label="实际落地">{novel.preview.materializedChapterCount}</Field>
            <Field label="可展示章节">{novel.preview.displayableChapterCount}</Field>
          </dl>
        </div>
      )}
    </Panel>
  );
}

/** Latest sync attempt, source coverage and the exception set. */
export function NovelSyncPanel({ novel }: { novel: AdminNovelDetailView }) {
  const latest = novel.sync.latestTask;
  return (
    <Panel title="同步与异常">
      <dl>
        <Field label="异常">
          <ExceptionBadges exceptions={novel.sync.exceptions} />
        </Field>
        <Field label="来源条目">{novel.sync.sourceItemCount}</Field>
        <Field label="来源应用">
          {novel.sync.sourceAppCodes.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {novel.sync.sourceAppCodes.map((code) => (
                <span
                  key={code}
                  className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                >
                  {code}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-gray-400">-</span>
          )}
        </Field>
        <Field label="上游更新">{formatDateTime(novel.sync.latestSourceUpdatedAt)}</Field>
        <Field label="最近可见">{formatDateTime(novel.sync.latestSeenAt)}</Field>
        {latest ? (
          <>
            <Field label="最近任务">
              {latest.taskType}（{taskModeLabel(latest.mode)}）
            </Field>
            <Field label="任务状态">
              {taskStatusLabel(latest.taskStatus)} / 条目 {taskStatusLabel(latest.itemStatus)}
            </Field>
            <Field label="尝试次数">{latest.attemptCount}</Field>
            <Field label="请求时间">{formatDateTime(latest.requestedAt)}</Field>
            <Field label="结束时间">{formatDateTime(latest.finishedAt)}</Field>
          </>
        ) : (
          <Field label="最近任务">
            <span className="text-gray-400" data-testid="sync-task-absent">
              无同步记录
            </span>
          </Field>
        )}
      </dl>
    </Panel>
  );
}

/**
 * Upstream provenance.
 *
 * Carries identifiers and timestamps only. There is no raw upstream payload
 * here and no credential — the source row's channel account and its JWT are not
 * part of `AdminNovelSourceView` at all.
 */
export function NovelSourcesPanel({ novel }: { novel: AdminNovelDetailView }) {
  return (
    <Panel title="上游来源">
      {novel.sources.length === 0 ? (
        <p className="text-sm text-gray-400">暂无来源条目</p>
      ) : (
        <div className="space-y-3">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-500">渠道</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">来源应用</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">上游书 ID</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">上游语种</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">状态</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">最近可见</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {novel.sources.map((source) => (
                <tr key={source.sourceItemId}>
                  <td className="px-3 py-2 text-gray-600">
                    {source.channelName}
                    <span className="ml-1 text-xs text-gray-400">{source.channelCode}</span>
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {source.sourceAppName}
                    <span className="ml-1 text-xs text-gray-400">{source.sourceAppCode}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-600">
                    {source.externalBookId}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {source.sourceLanguageName ?? source.sourceLanguageCode}
                    {source.sourceLocale && (
                      <span className="ml-1 text-xs text-gray-400">→ {source.sourceLocale}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{source.status}</td>
                  <td className="px-3 py-2 text-gray-500">{formatDateTime(source.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {novel.sourcesTruncated && (
            <p className="text-xs text-amber-700" data-testid="sources-truncated">
              来源条目较多，仅展示最近更新的一部分。
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * Source labels (P2-06), grouped by `label_kind` and shown beside upstream
 * provenance for the same reason `NovelSourcesPanel` sits next to it: both
 * answer "what did the channel actually say about this book," just at a
 * different granularity — one row per source item versus one chip per
 * dictionary entry.
 *
 * Every registered `LabelKind` renders its own row even when this novel
 * carries no label of that kind — the same discipline `ExceptionBadges` uses
 * for an empty exception list (see that component's doc comment): a blank row
 * is ambiguous between "checked, this novel has none of this kind" and "not
 * evaluated," and a fixed four-row layout is what makes the distinction
 * visible at a glance instead of requiring the reader to count.
 */
export function NovelLabelsPanel({ novel }: { novel: AdminNovelDetailView }) {
  const byKind = new Map<LabelKind, AdminNovelLabelView[]>(LABEL_KINDS.map((kind) => [kind, []]));
  for (const label of novel.labels) {
    byKind.get(label.labelKind)?.push(label);
  }

  return (
    <Panel title="来源标签">
      <dl>
        {LABEL_KINDS.map((kind) => (
          <Field key={kind} label={LABEL_KIND_BADGES[kind].label}>
            <NovelLabelGroup labels={byKind.get(kind) ?? []} />
          </Field>
        ))}
      </dl>
    </Panel>
  );
}

/**
 * `displayValue` and `externalLabelValue` render in parallel, never as a
 * fallback of one for the other:
 *
 * - has a display value → the display value leads, the raw upstream value
 *   trails in parentheses as a small grey aside — the curated name is what an
 *   operator reads first, but the code it was derived from stays one glance
 *   away;
 * - no display value (true for every row today — the write side has not
 *   backfilled `display_value` yet) → only the raw value renders. It is never
 *   invented from anywhere, and in particular never from a UI-local
 *   code-to-name table: the one language-code mapping this project trusts is
 *   `src/lib/locale/locale-canonical.ts`, and a `language`-kind label with no
 *   `display_value` shows its upstream code exactly as given.
 */
function NovelLabelGroup({ labels }: { labels: readonly AdminNovelLabelView[] }) {
  if (labels.length === 0) {
    return <span className="text-xs text-gray-400">无标签</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((label) => (
        <span
          key={label.labelId}
          className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
          data-testid={`novel-label-${label.labelId}`}
        >
          {label.displayValue ?? label.externalLabelValue}
          {label.displayValue && (
            <span className="ml-1 text-gray-400">（{label.externalLabelValue}）</span>
          )}
        </span>
      ))}
    </div>
  );
}
