import Link from "next/link";

import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyRow, Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { formatDateTime } from "@/features/admin-ui/datetime";
import type { RevenueBatchRow } from "@/server/revenue";

import { shortTaskId } from "../_lib/active-task";
import { batchStatusView, reconciliationView } from "../_lib/copy";
import { formatCount, truncate } from "../_lib/format";

const MESSAGE_MAX_LENGTH = 80;

/**
 * 错误信息的着色只看**批次状态**，不看"有没有 message"：`completed` 批次也可能带一条提示
 * （被丢弃的坏日期行之类），那是备注，不是失败。
 */
function messageTone(status: string): string {
  if (status === "failed") return "text-red-700";
  if (status === "partial_failed") return "text-amber-700";
  return "text-gray-500";
}

function ErrorCell({ batch }: { batch: RevenueBatchRow }) {
  if (!batch.errorCode && !batch.errorMessage) return <span className="text-gray-400">—</span>;
  const tone = messageTone(batch.status);
  return (
    <div className={`space-y-0.5 text-xs ${tone}`}>
      {batch.errorCode && <div className="font-mono">{batch.errorCode}</div>}
      {batch.errorMessage && (
        <div title={batch.errorMessage} data-testid="revenue-batch-message">
          {truncate(batch.errorMessage, MESSAGE_MAX_LENGTH)}
        </div>
      )}
    </div>
  );
}

/** 最近 20 个同步批次。 */
export function BatchTable({ batches }: { batches: readonly RevenueBatchRow[] }) {
  return (
    <section aria-labelledby="revenue-batches-heading" data-testid="revenue-batches" className="space-y-2">
      <h2 id="revenue-batches-heading" className="text-sm font-semibold text-gray-900">
        同步记录
        <span className="ml-2 text-xs font-normal text-gray-500">最近 {batches.length} 批</span>
      </h2>
      <Table>
        <THead>
          <tr>
            <TH>创建时间</TH>
            <TH>区间</TH>
            <TH>状态</TH>
            <TH className="text-right">明细行数</TH>
            <TH>对账</TH>
            <TH>StarId</TH>
            <TH>错误码 / 信息</TH>
            <TH>任务</TH>
          </tr>
        </THead>
        <TBody>
          {batches.length === 0 ? (
            <EmptyRow colSpan={8}>还没有同步记录。点击上方「发起同步」拉取最近 7 天。</EmptyRow>
          ) : (
            batches.map((batch) => {
              const status = batchStatusView(batch.status);
              const reconciliation = reconciliationView(batch.reconciliationStatus);
              return (
                <tr key={batch.id} data-testid={`revenue-batch-${batch.id}`} data-status={batch.status}>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(batch.createdAt)}</TD>
                  <TD className="whitespace-nowrap font-mono text-xs">
                    {batch.beginDate} ~ {batch.endDate}
                  </TD>
                  <TD>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </TD>
                  <TD className="text-right tabular-nums">{formatCount(batch.detailRowCount)}</TD>
                  <TD>
                    {reconciliation ? (
                      <StatusBadge tone={reconciliation.tone}>{reconciliation.label}</StatusBadge>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </TD>
                  <TD className="font-mono text-xs">{batch.upstreamStarId ?? "—"}</TD>
                  <TD className="max-w-xs">
                    <ErrorCell batch={batch} />
                  </TD>
                  <TD className="text-xs">
                    {batch.genericTaskId ? (
                      <Link
                        href={`/tasks/${batch.genericTaskId}`}
                        title={batch.genericTaskId}
                        className="font-mono text-blue-600 hover:text-blue-700"
                      >
                        #{shortTaskId(batch.genericTaskId)}
                      </Link>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </TD>
                </tr>
              );
            })
          )}
        </TBody>
      </Table>
    </section>
  );
}
