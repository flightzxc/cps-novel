import type { PublishGateReason } from "@/contracts/publish-gate";
import type { ArticlePublishBatchSummaryDto } from "@/server/task-admin";

import { describePublishGateReason } from "../../../novels/_lib/publish-gate-copy";

const SITEMAP_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  queued: "已触发，刷新任务已入队",
  coalesced: "已触发，并入正在进行的刷新",
  disabled: "站点地图自动刷新开关未开启，未触发",
  failed: "触发失败，等待下一次收尾重试",
});

function n(value: number): string {
  return value.toLocaleString("zh-CN");
}

/**
 * 批量发布批次的"发布结果"：已发布 / 发布检查拒绝（按原因汇总）/ 跳过 / 未尝试，
 * 以及试读与站点地图的收尾情况。数字全部来自服务端按条目行聚合的 DTO
 * （`loadArticlePublishBatchSummary`），这里只做展示。拒绝原因码用发布检查自己的中文
 * 文案（`describePublishGateReason`），与单篇发布被拒时的提示同一份。
 */
export function ArticlePublishBatchSummary({ summary }: { summary: ArticlePublishBatchSummaryDto }) {
  const reasons = Object.entries(summary.rejectedReasonCounts)
    .filter((entry): entry is [PublishGateReason, number] => typeof entry[1] === "number" && entry[1] > 0);
  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
      data-testid="article-publish-batch-summary"
    >
      <h2 className="font-medium text-gray-900">发布结果</h2>
      <p className="mt-1 text-sm text-gray-700" data-testid="article-publish-batch-counts">
        已发布 {n(summary.publishedCount)} 篇；
        发布检查未通过 {n(summary.rejectedCount)} 篇；
        执行时已不是草稿 {n(summary.notDraftCount)} 篇；
        已不存在 {n(summary.notFoundCount)} 篇；
        中止后未尝试 {n(summary.abortedUnattemptedCount)} 篇；
        待处理 {n(summary.unfinishedCount)} 篇
        {summary.otherFailedCount > 0 ? `；其它失败 ${n(summary.otherFailedCount)} 篇` : ""}。
      </p>
      {reasons.length > 0 && (
        <div
          className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900"
          data-testid="article-publish-batch-rejected-reasons"
        >
          <p>发布检查未通过的原因（一篇可能命中多条）：</p>
          <ul className="mt-1 space-y-1">
            {reasons.map(([reason, count]) => (
              <li key={reason} data-testid={`article-publish-batch-reason-${reason}`}>
                {describePublishGateReason(reason).label}：{n(count)} 篇
                <span className="ml-2 text-xs text-amber-800">{describePublishGateReason(reason).guidance}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">处理好之后，点页面上方的「重试失败项」；已经发布的文章不会被重复发布。</p>
        </div>
      )}
      <p className="mt-2 text-sm text-gray-700" data-testid="article-publish-batch-preview">
        {summary.skipPreview
          ? `试读：已按「发布时暂不抓试读」跳过，不建试读抓取任务${
            summary.preview.skippedBookCount !== null ? `（涉及 ${n(summary.preview.skippedBookCount)} 本书，可之后用补抓手段处理）` : ""
          }。`
          : `试读：每个子任务结束后合并建一次试读抓取任务，已完成 ${n(summary.preview.dispatchedChildCount)} 个子任务的派发，共 ${n(summary.preview.taskGroupCount)} 组抓取任务。`}
      </p>
      <p className="mt-1 text-sm text-gray-700" data-testid="article-publish-batch-sitemap">
        站点地图：{summary.sitemapRefresh
          ? `${SITEMAP_STATUS_LABEL[summary.sitemapRefresh.status] ?? summary.sitemapRefresh.status}（整批结束后触发，共 ${summary.sitemapRefresh.triggerCount} 次）。`
          : "整批结束后触发一次，尚未触发。"}
      </p>
    </section>
  );
}
