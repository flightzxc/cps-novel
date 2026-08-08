import type { AdminChapterDetailView } from "@/contracts";
import { formatCount, formatDateTime } from "@/features/admin-ui/content-view";

import { ChapterStatusBadge } from "./content-badges";

/**
 * Chapter metadata, rendered server-side.
 *
 * Everything here is safe to render on navigation. The body is not, so it is not
 * on this component — it is fetched on demand by `ChapterContentViewer`.
 */
export function ChapterDetailPanel({ chapter }: { chapter: AdminChapterDetailView }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
        章节信息
      </h2>
      <dl className="px-4 py-3">
        <div className="flex gap-3 py-1.5 text-sm">
          <dt className="w-28 shrink-0 text-gray-500">章节号</dt>
          <dd className="text-gray-900">第 {chapter.canonicalChapterNumber} 章</dd>
        </div>
        <div className="flex gap-3 py-1.5 text-sm">
          <dt className="w-28 shrink-0 text-gray-500">标题</dt>
          <dd className="text-gray-900">
            {chapter.title ?? <span className="text-gray-400">未命名</span>}
          </dd>
        </div>
        <div className="flex gap-3 py-1.5 text-sm">
          <dt className="w-28 shrink-0 text-gray-500">状态</dt>
          <dd>
            <ChapterStatusBadge status={chapter.status} />
          </dd>
        </div>
        <div className="flex gap-3 py-1.5 text-sm">
          <dt className="w-28 shrink-0 text-gray-500">正文</dt>
          <dd className="text-gray-900">
            {chapter.hasContent ? (
              <span className="text-green-700">已落地</span>
            ) : (
              <span className="text-gray-400">未落地</span>
            )}
          </dd>
        </div>
        <div className="flex gap-3 py-1.5 text-sm">
          <dt className="w-28 shrink-0 text-gray-500">字数</dt>
          <dd className="text-gray-900">{formatCount(chapter.charCount)}</dd>
        </div>
        <div className="flex gap-3 py-1.5 text-sm">
          <dt className="w-28 shrink-0 text-gray-500">内容指纹</dt>
          <dd className="font-mono text-xs text-gray-600">{chapter.contentHashPrefix ?? "-"}</dd>
        </div>
        <div className="flex gap-3 py-1.5 text-sm">
          <dt className="w-28 shrink-0 text-gray-500">落地时间</dt>
          <dd className="text-gray-900">{formatDateTime(chapter.materializedAt)}</dd>
        </div>
        <div className="flex gap-3 py-1.5 text-sm">
          <dt className="w-28 shrink-0 text-gray-500">上游更新</dt>
          <dd className="text-gray-900">{formatDateTime(chapter.sourceUpdatedAt)}</dd>
        </div>
      </dl>
    </section>
  );
}

/** Upstream chapter provenance. Identifiers and names only — no payload. */
export function ChapterSourcesPanel({ chapter }: { chapter: AdminChapterDetailView }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
        上游来源
      </h2>
      <div className="px-4 py-3">
        {chapter.sources.length === 0 ? (
          <p className="text-sm text-gray-400">暂无来源条目</p>
        ) : (
          <div className="space-y-3">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">上游章节 ID</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">上游章节号</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">上游标题</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">状态</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">最近可见</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {chapter.sources.map((source) => (
                  <tr key={source.sourceId}>
                    <td className="px-3 py-2 font-mono text-xs text-gray-600">
                      {source.externalChapterId}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {source.sourceChapterNumber ?? "-"}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {source.chapterShowName ?? source.chapterName ?? "-"}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{source.status}</td>
                    <td className="px-3 py-2 text-gray-500">{formatDateTime(source.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {chapter.sourcesTruncated && (
              <p className="text-xs text-amber-700">来源条目较多，仅展示最近更新的一部分。</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
