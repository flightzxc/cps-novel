import Link from "next/link";

import type { AdminChapterListItemView } from "@/contracts";
import { formatCount, formatDateTime } from "@/features/admin-ui/content-view";

import { ChapterStatusBadge } from "./content-badges";

/**
 * Chapter table — the novel's table of contents as operations sees it.
 *
 * CPS has no direct counterpart: its episode data is a scalar `episodeCount` on
 * the drama row, never an enumerated list, so this is `CPS_PARITY_ADAPTED` at
 * best — the table chrome is CPS's, the columns are new.
 *
 * `hasContent` is rendered as a word, not a tick: "已落地 / 未落地" is what an
 * operator is actually asking, and it sits next to the char count and hash
 * prefix that let two materialisations be told apart without opening either.
 * The body itself is never in this payload.
 */
export function ChaptersTable({
  novelId,
  chapters,
}: {
  novelId: string;
  chapters: readonly AdminChapterListItemView[];
}) {
  if (chapters.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-6 py-12 text-center text-gray-400 shadow-sm">
        该书目暂无章节
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-500">章节号</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">标题</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">正文</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">字数</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">内容指纹</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">落地时间</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">来源条目</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {chapters.map((chapter) => (
            <tr key={chapter.chapterId} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-600">第 {chapter.canonicalChapterNumber} 章</td>
              <td className="px-4 py-3 font-medium text-gray-900">
                {chapter.title ?? <span className="text-gray-400">未命名</span>}
              </td>
              <td className="px-4 py-3">
                <ChapterStatusBadge status={chapter.status} />
              </td>
              <td className="px-4 py-3">
                {chapter.hasContent ? (
                  <span className="text-green-700">已落地</span>
                ) : (
                  <span className="text-gray-400">未落地</span>
                )}
              </td>
              <td className="px-4 py-3 text-gray-600">{formatCount(chapter.charCount)}</td>
              <td className="px-4 py-3 font-mono text-xs text-gray-400">
                {chapter.contentHashPrefix ?? "-"}
              </td>
              <td className="px-4 py-3 text-gray-500">{formatDateTime(chapter.materializedAt)}</td>
              <td className="px-4 py-3 text-gray-600">{chapter.sourceItemCount}</td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={`/novels/${novelId}/chapters/${chapter.chapterId}`}
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
