import Link from "next/link";

import { formatDateTime } from "@/features/admin-ui/content-view";
import type { PromoClaimBatchLifecycleDto } from "@/domain/catalog-batch";

import { systemHoldRecoveryHint, taskControlKindLabel } from "../../_lib/task-copy";

/**
 * 阶段2 第4步（施工任务 3.5，设计 §5.9）：生命周期批次详情页的"分片列表"与
 * "领取统计 / 预计完成时间"——只读展示，服务端组件（不需要客户端状态）。
 * `data` 由 `getAdminTaskDetail` 的 `catalogBatch.promoClaimLifecycle`
 * 提供，本组件只负责渲染，不做任何派生计算。
 */
export function PromoClaimShardList({ data }: { data: PromoClaimBatchLifecycleDto }) {
  const eta = data.etaMinutes;
  const etaLabel = eta === null
    ? "尚无法估算"
    : eta === 0
      ? "即将完成"
      : eta < 60
        ? `约 ${eta} 分钟`
        : `约 ${(eta / 60).toFixed(1)} 小时`;

  return (
    <section className="space-y-4" data-testid="promo-claim-shard-list">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-7">
        <SummaryCard label="总数" value={data.counts.total} />
        <SummaryCard label="已领取" value={data.counts.claimed} tone="green" />
        <SummaryCard label="已有推广码" value={data.counts.withCode} tone="green" />
        <SummaryCard label="人工核对" value={data.counts.manualReview} tone="amber" />
        <SummaryCard label="失败" value={data.counts.failed} tone="red" />
        <SummaryCard label="跳过" value={data.counts.skipped} tone="amber" />
        <SummaryCard label="剩余" value={data.counts.remaining} tone="blue" />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-gray-700">预计完成时间</p>
          <p className="text-sm text-gray-600" data-testid="promo-claim-eta">{etaLabel}</p>
        </div>
        {data.shardPlan && (
          <p className="mt-1 text-xs text-gray-400">
            共 {data.shardPlan.shardCount} 片
            {typeof data.shardPlan.shardSize === "number" && <>，每片 {data.shardPlan.shardSize} 本</>}
            ，窗口 {data.shardPlan.windowMinutes} 分钟
          </p>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50 text-xs uppercase tracking-wide text-gray-400">
            <tr>
              <th className="px-3 py-2">分片</th>
              <th className="px-3 py-2">状态</th>
              <th className="px-3 py-2">放行次数</th>
              <th className="px-3 py-2">放行时刻</th>
              <th className="px-3 py-2">截止时间</th>
              <th className="px-3 py-2">条目（总/领/码/核对/败/跳/余）</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.shards.map((shard) => {
              const holdHint = shard.holdReasonCode ? systemHoldRecoveryHint(shard.holdReasonCode) : undefined;
              return (
                <tr key={shard.taskId} data-testid="promo-claim-shard-row">
                  <td className="px-3 py-2">
                    <Link href={`/tasks/${shard.taskId}?family=generic`} className="text-blue-700 underline">
                      #{shard.shardIndex}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <div>{shard.holdKind ? taskControlKindLabel(shard.holdKind) : shard.status}</div>
                    {holdHint && <div className="mt-0.5 text-xs text-amber-700">{holdHint}</div>}
                  </td>
                  <td className="px-3 py-2">{shard.releaseCount}{shard.missedDeadlineCount > 0 && <span className="ml-1 text-xs text-amber-600">（错过 {shard.missedDeadlineCount} 次）</span>}</td>
                  <td className="px-3 py-2">{formatDateTime(shard.releasedAt)}</td>
                  <td className="px-3 py-2">{formatDateTime(shard.deadlineAt)}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {shard.totalCount} / {shard.claimedCount} / {shard.withCodeCount} / {shard.manualReviewCount} / {shard.failedCount} / {shard.skippedCount} / {shard.remainingCount}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: "green" | "amber" | "red" | "blue" }) {
  const toneClass = tone === "green"
    ? "border-green-100 bg-green-50/50 text-green-700"
    : tone === "amber"
      ? "border-amber-100 bg-amber-50/50 text-amber-700"
      : tone === "red"
        ? "border-red-100 bg-red-50/50 text-red-700"
        : tone === "blue"
          ? "border-blue-100 bg-blue-50/50 text-blue-700"
          : "border-gray-200 bg-white text-gray-900";
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${toneClass}`}>
      <p className="text-xs opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value.toLocaleString("zh-CN")}</p>
    </div>
  );
}
