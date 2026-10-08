"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { enqueueRevenueSyncAction } from "../_actions";
import { shortTaskId } from "../_lib/active-task";
import { enqueueFailureCopy } from "../_lib/copy";
import { checkSyncRange, inclusiveSpanDays, rangeProblemCopy } from "../_lib/dates";

type Stage =
  | { readonly kind: "idle" }
  | { readonly kind: "confirming" }
  | { readonly kind: "submitting" }
  | { readonly kind: "created"; readonly taskId: string; readonly duplicate: boolean }
  | { readonly kind: "failed"; readonly message: string; readonly existingTaskId?: string };

/**
 * 「发起同步」表单。默认区间 = 最近 7 天（结束于北京时间今天，由服务端给）。
 *
 * 校验（begin ≤ end、跨度 ≤ 92 天、结束日期不晚于今天）只为少一次往返，**最终以服务端返回为准**；
 * 提交前必须过一次 `ConfirmDialog`——它会真的向上游发起查询，不能一点就发。
 *
 * `blocked`：已有活跃任务 / 没有可用账号时按钮禁用（原因由父级 server 组件在表单上方说明）。
 * 成功后按钮保持禁用直到页面刷新拿到最新 `activeTask`，避免刷新前的二次点击。
 *
 * 失败的呈现：后端业务 code → 中文（未知 code 显示原文）；授权类失败 → `errorEnvelopeCopy`
 * （含 2FA 过期、限流）。绝不读 `error.message`。
 */
export function SyncForm({
  today,
  defaultBegin,
  defaultEnd,
  blocked,
}: {
  today: string;
  defaultBegin: string;
  defaultEnd: string;
  blocked: boolean;
}) {
  const router = useRouter();
  const [begin, setBegin] = useState(defaultBegin);
  const [end, setEnd] = useState(defaultEnd);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submitting = stage.kind === "submitting";
  const created = stage.kind === "created";
  const disabled = blocked || submitting || created;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const check = checkSyncRange(begin, end, today);
    if (!check.ok) {
      setFieldError(rangeProblemCopy(check.problem));
      return;
    }
    setFieldError(null);
    setStage({ kind: "confirming" });
  }

  async function onConfirm() {
    setStage({ kind: "submitting" });
    try {
      const result = await enqueueRevenueSyncAction({
        beginDate: begin,
        endDate: end,
        requestId: crypto.randomUUID(),
      });
      if (result.ok) {
        setStage({ kind: "created", taskId: result.data.taskId, duplicate: result.data.duplicate });
        router.refresh();
        return;
      }
      if (result.kind === "enqueue_failed") {
        setStage({
          kind: "failed",
          message: enqueueFailureCopy(result.code),
          existingTaskId: result.existingTaskId,
        });
        // 已有活跃任务：刷新一下，让页面把那条任务摆出来。
        if (result.code === "revenue_sync_already_active") router.refresh();
        return;
      }
      setStage({ kind: "failed", message: errorEnvelopeCopy(result.envelope) });
    } catch {
      setStage({ kind: "failed", message: "提交失败，请检查网络后重试" });
    }
  }

  const spanDays = (() => {
    const check = checkSyncRange(begin, end, today);
    return check.ok ? inclusiveSpanDays(begin, end) : null;
  })();

  return (
    <>
      <form onSubmit={onSubmit} noValidate className="flex flex-wrap items-end gap-3" data-testid="revenue-sync-form">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">同步开始日期</span>
          <input
            type="date"
            value={begin}
            max={today}
            onChange={(event) => {
              setBegin(event.target.value);
              setFieldError(null);
            }}
            aria-label="同步开始日期"
            disabled={disabled}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">同步结束日期</span>
          <input
            type="date"
            value={end}
            max={today}
            onChange={(event) => {
              setEnd(event.target.value);
              setFieldError(null);
            }}
            aria-label="同步结束日期"
            disabled={disabled}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
          />
        </label>
        <button type="submit" disabled={disabled} className={buttonClassName("primary")}>
          {submitting ? "提交中…" : "发起同步"}
        </button>
        {spanDays !== null && <span className="pb-2 text-xs text-gray-500">共 {spanDays} 天</span>}
      </form>

      {fieldError && (
        <p role="alert" data-testid="revenue-sync-field-error" className="mt-2 text-xs text-red-600">
          {fieldError}
        </p>
      )}

      {stage.kind === "created" && (
        <p
          role="status"
          data-testid="revenue-sync-created"
          className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          {stage.duplicate ? "这次提交命中了已有的同步任务" : "同步任务已创建"}（
          <Link href={`/tasks/${stage.taskId}`} className="font-mono font-medium underline">
            任务 #{shortTaskId(stage.taskId)}
          </Link>
          ）。由主 worker 执行，完成后刷新本页即可看到数据。
        </p>
      )}

      {stage.kind === "failed" && (
        <p
          role="alert"
          data-testid="revenue-sync-failed"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {stage.message}
          {stage.existingTaskId && (
            <>
              {" "}
              <Link href={`/tasks/${stage.existingTaskId}`} className="font-mono font-medium underline">
                查看任务 #{shortTaskId(stage.existingTaskId)}
              </Link>
            </>
          )}
        </p>
      )}

      <ConfirmDialog
        open={stage.kind === "confirming" || stage.kind === "submitting"}
        title="确认发起同步"
        body={
          <p data-testid="revenue-sync-confirm-body">
            将向上游发起只读查询，同步 {begin} ~ {end} 共 {spanDays ?? "—"} 天。
          </p>
        }
        confirmLabel="确认同步"
        confirmVariant="primary"
        pending={submitting}
        onConfirm={onConfirm}
        onCancel={() => setStage({ kind: "idle" })}
      />
    </>
  );
}
