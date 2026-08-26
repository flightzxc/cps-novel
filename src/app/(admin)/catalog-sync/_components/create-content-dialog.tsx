"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { buttonClassName } from "@/components/ui/button";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { applyContentCreationAction, dryRunContentCreationAction } from "../_actions";
import {
  describeCreateContentOutcome,
  type ContentCreationPlan,
  type CreateContentResult,
  type CreatedContentSummary,
  type OutcomeTone,
} from "../_lib/outcome-copy";
import type { SourceItemRow } from "../_lib/read-source-items";

/**
 * Two-step dry-run → apply dialog triggered from a `/catalog-sync` row.
 *
 * Opening it always runs a dry run first (`content:view`, no confirmation
 * needed — see `../_actions.ts`); the write only happens if the operator
 * explicitly clicks "确认创建" (P0-S13 task requirement: no one-click write).
 * Every {@link CreateContentResult} outcome renders through
 * `describeCreateContentOutcome`, so nothing the service can return is
 * silently swallowed — a blocked, conflicting or failed outcome ends the flow
 * with its own explanation rather than a generic "失败".
 */

type Stage =
  | { readonly kind: "loading" }
  | { readonly kind: "plan"; readonly plan: ContentCreationPlan }
  | { readonly kind: "result"; readonly result: CreateContentResult }
  | { readonly kind: "error"; readonly message: string };

const INVALID_INPUT_COPY: Readonly<Record<string, string>> = Object.freeze({
  invalid_novel_source_item_id: "来源条目标识无效，请刷新页面后重试",
  invalid_locale: "语种参数无效（内部错误），请联系工程排查",
  invalid_actor: "无法确认当前操作者身份，请重新登录后重试",
  invalid_request_id: "请求标识无效（内部错误），请刷新页面后重试",
});

/**
 * `data.ok` is narrowed by the caller before this runs; kept generic over
 * both action results (dry-run and apply) rather than duplicating the
 * failure-copy branch twice.
 */
function failureMessage(
  failure:
    | { readonly kind: "invalid_input"; readonly code: string }
    | { readonly kind: "access_denied"; readonly envelope: Parameters<typeof errorEnvelopeCopy>[0] },
): string {
  return failure.kind === "invalid_input"
    ? (INVALID_INPUT_COPY[failure.code] ?? "输入无效，请重试")
    : errorEnvelopeCopy(failure.envelope);
}

const TONE_STYLE: Readonly<Record<OutcomeTone, string>> = Object.freeze({
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  info: "border-blue-200 bg-blue-50 text-blue-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-900",
});

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-3 px-3 py-2 text-sm">
      <dt className="w-24 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-gray-900">{value}</dd>
    </div>
  );
}

function localeMismatchNotice(item: SourceItemRow): string | null {
  if (!item.sourceLocale) {
    return "该来源条目尚未识别出标准站点语种（语种归一 S7a 未接线），请先人工确认这确实是英文内容，再继续创建。";
  }
  if (item.sourceLocale !== "en") {
    return `该来源条目识别出的语种是「${item.sourceLocale}」，与本次将创建的「en」不一致，请确认这是预期行为。`;
  }
  return null;
}

function PlanPreview({ item, plan }: { item: SourceItemRow; plan: ContentCreationPlan }) {
  const mismatch = localeMismatchNotice(item);
  return (
    <div className="space-y-3">
      <p className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.info}`} role="status">
        尚未写入任何数据。以下字段将写入 Novel / Article（草稿状态），确认后才会真正创建。
      </p>
      {mismatch && (
        <p className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.warning}`} data-testid="locale-mismatch-notice">
          {mismatch}
        </p>
      )}
      <dl className="divide-y divide-gray-100 rounded-lg border border-gray-200">
        <Row label="语种" value={plan.locale} />
        <Row label="标题" value={plan.title} />
        <Row label="书目 slug" value={plan.novelSlug} />
        <Row label="文章 slug" value={plan.articleSlug} />
        <Row
          label="预览短码"
          value={`${plan.provisionalPublicPageShortId}（临时生成，仅供预览，实际创建会重新分配）`}
        />
        <Row label="总章节数" value={String(item.totalChapterCount)} />
        <Row label="付费起始章节" value={item.paidFromChapter === null ? "未设置" : String(item.paidFromChapter)} />
        <Row label="封面" value={item.coverUrl ?? "（无）"} />
        <Row label="简介" value={item.description || "（空）"} />
      </dl>
    </div>
  );
}

function CreatedSummary({ summary }: { summary: CreatedContentSummary }) {
  return (
    <>
      <dl className="divide-y divide-gray-100 rounded-lg border border-gray-200">
        <Row label="书目业务ID" value={summary.novelBusinessId} />
        <Row label="书目 slug" value={summary.novelSlug} />
        <Row label="文章 slug" value={summary.articleSlug} />
        <Row label="公开短码" value={summary.publicPageShortId} />
        <Row label="语种" value={summary.locale} />
      </dl>
      <Link
        href={`/novels/${summary.novelId}`}
        className="inline-block text-sm font-medium text-blue-700 underline-offset-2 hover:underline"
      >
        查看书目详情
      </Link>
    </>
  );
}

function ResultPanel({ result }: { result: CreateContentResult }) {
  const copy = describeCreateContentOutcome(result);
  return (
    <div className="space-y-3">
      <div
        role={copy.tone === "danger" ? "alert" : "status"}
        data-testid={`outcome-${result.outcome}`}
        className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE[copy.tone]}`}
      >
        <p className="font-medium">{copy.title}</p>
        <p className="mt-1">{copy.body}</p>
      </div>
      {(result.outcome === "created" || result.outcome === "already_exists") && (
        <CreatedSummary summary={result} />
      )}
    </div>
  );
}

export function CreateContentDialog({
  item,
  contentPublishGranted,
  contentPublishBlockedReason,
  onClose,
}: {
  item: SourceItemRow;
  contentPublishGranted: boolean;
  contentPublishBlockedReason: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  /**
   * Pure fetch-and-classify, no `setState` of its own — `react-hooks/set-
   * state-in-effect` (correctly) flags a `setState` called synchronously
   * from an effect body, and the mount effect below awaits this before
   * ever touching `stage`. Shared by that mount effect and the manual "重试"
   * button after a `concurrent_creation_conflict`, so the two callers can
   * never classify the same response differently.
   */
  async function fetchStage(): Promise<Stage> {
    const result = await dryRunContentCreationAction({
      novelSourceItemId: item.id,
      requestId: crypto.randomUUID(),
    });
    if (!result.ok) return { kind: "error", message: failureMessage(result) };
    return result.data.outcome === "dry_run"
      ? { kind: "plan", plan: result.data.plan }
      : { kind: "result", result: result.data };
  }

  // Dry run kicks off as soon as the dialog opens — the operator should not
  // have to click twice just to see the plan. `stage`'s own initial value is
  // already `{ kind: "loading" }`, so nothing here needs to set it again.
  useEffect(() => {
    let cancelled = false;
    fetchStage().then((next) => {
      if (!cancelled) setStage(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- item.id is the only input that should re-trigger a dry run
  }, [item.id]);

  function retryDryRun() {
    // A click handler, not an effect body — setting loading synchronously
    // here is the normal, encouraged shape.
    setStage({ kind: "loading" });
    void fetchStage().then(setStage);
  }

  async function confirmCreate() {
    setApplying(true);
    const result = await applyContentCreationAction({
      novelSourceItemId: item.id,
      requestId: crypto.randomUUID(),
    });
    setApplying(false);
    if (!result.ok) {
      setStage({ kind: "error", message: failureMessage(result) });
      return;
    }
    setStage({ kind: "result", result: result.data });
    // Only a real write changes anything the rest of the app can see; other
    // outcomes (already_exists, conflicts, ...) leave the row exactly as it
    // was, so refreshing would be a no-op flash, not a correction.
    if (result.data.outcome === "created") router.refresh();
  }

  const canConfirm = stage.kind === "plan";
  const showRetry = stage.kind === "result" && stage.result.outcome === "concurrent_creation_conflict";

  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        if (!applying) onClose();
      }}
      className="w-full max-w-lg rounded-xl border border-gray-200 p-0 text-gray-900 shadow-xl backdrop:bg-gray-900/40"
    >
      <div className="space-y-4 p-5">
        <h2 className="text-base font-semibold">创建内容 · {item.title}</h2>

        {stage.kind === "loading" && (
          <p role="status" className="text-sm text-gray-500">
            正在生成创建计划…
          </p>
        )}
        {stage.kind === "plan" && <PlanPreview item={item} plan={stage.plan} />}
        {stage.kind === "result" && <ResultPanel result={stage.result} />}
        {stage.kind === "error" && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
            {stage.message}
          </p>
        )}

        {canConfirm && !contentPublishGranted && contentPublishBlockedReason && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {contentPublishBlockedReason}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {showRetry && (
            <button type="button" onClick={retryDryRun} className={buttonClassName("secondary")}>
              重试
            </button>
          )}
          <button
            type="button"
            disabled={applying}
            onClick={onClose}
            className={buttonClassName("secondary")}
          >
            {stage.kind === "result" || stage.kind === "error" ? "关闭" : "取消"}
          </button>
          {canConfirm && (
            <button
              type="button"
              disabled={!contentPublishGranted || applying}
              onClick={confirmCreate}
              className={buttonClassName("primary")}
            >
              {applying ? "创建中…" : "确认创建"}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
