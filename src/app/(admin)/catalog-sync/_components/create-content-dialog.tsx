"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { buttonClassName } from "@/components/ui/button";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { SITE_LOCALE_LABELS, type SiteLocale } from "@/lib/locale/locale-canonical";

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

/**
 * `missing_locale`/`unsupported_locale` are real, reachable outcomes here
 * (L10N P2, matrix #3) — not defensive placeholders like the other three
 * codes below. Opening this dialog on a source item whose `sourceLocale` is
 * `NULL`, or resolves to a locale outside `SITE_LOCALES` (e.g.
 * `it`/`fil`/`ms`/`tr`), makes the auto-dry-run throw one of these, landing
 * the dialog straight in `stage: "error"` — the plan preview (and its
 * "确认创建" button) is never reached at all, so there is nothing further to
 * disable.
 */
const INVALID_INPUT_COPY: Readonly<Record<string, string>> = Object.freeze({
  invalid_novel_source_item_id: "来源条目标识无效，请刷新页面后重试",
  missing_locale: "该来源条目尚未识别出语种（sourceLocale 为空），无法创建内容。",
  unsupported_locale: "该来源条目识别出的语种不是本站已登记的语种，无法创建内容。",
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

/**
 * `plan.locale` is always identical to `item.sourceLocale` here — by the
 * time a dry run reaches `stage: "plan"` at all, `loadPlan`
 * (`src/server/content-creation/service.ts`) has already derived it from
 * that exact field and thrown `missing_locale`/`unsupported_locale`
 * otherwise (see `INVALID_INPUT_COPY`'s own doc comment) — so there is no
 * "mismatch" state left to warn about, only a read-only fact to display:
 * the code plus its 站点语种标签 (`SITE_LOCALE_LABELS`, the same registry
 * `template-manager.tsx`'s locale picker already uses for the same
 * purpose).
 */
function derivedLocaleDisplay(locale: SiteLocale): string {
  return `${locale}（${SITE_LOCALE_LABELS[locale]}）`;
}

function PlanPreview({ item, plan }: { item: SourceItemRow; plan: ContentCreationPlan }) {
  return (
    <div className="space-y-3">
      <p className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.info}`} role="status">
        尚未写入任何数据。以下字段将写入 Novel / Article（草稿状态），确认后才会真正创建。
      </p>
      <dl className="divide-y divide-gray-100 rounded-lg border border-gray-200">
        <Row label="语种" value={<span data-testid="derived-locale-display">{derivedLocaleDisplay(plan.locale)}</span>} />
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

function PreviewEnqueueNotice({ result }: { result: Extract<CreateContentResult, { outcome: "created" }> }) {
  const preview = result.previewEnqueue;
  if (!preview) return null;
  let message: string;
  if (!preview.queued) {
    message = preview.reason === "no_channel_account"
      ? "预览未入队：没有可唯一确定的有效渠道账户；内容已创建，可稍后人工补发。"
      : preview.reason === "mixed_channel_apps"
        ? "预览未入队：所选来源跨越多个渠道应用；内容已创建，可分渠道补发。"
        : preview.reason === "no_eligible_sources"
          ? "预览未入队：当前没有符合条件的来源条目。"
        : "预览未入队：提交后的入队步骤失败；内容已创建，可稍后人工补发。";
  } else if (preview.status === "enqueued" && preview.taskStatus === "disabled") {
    message = "预览任务已创建，但目录写闸关闭，任务状态为 disabled。";
  } else if (preview.status === "duplicate" || preview.status === "active_conflict") {
    message = "预览任务未重复创建：已存在相同或进行中的任务。";
  } else {
    message = "预览刷新任务已入队。";
  }
  return <p data-testid="preview-enqueue-result" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.info}`}>{message}</p>;
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
      {result.outcome === "created" && <PreviewEnqueueNotice result={result} />}
    </div>
  );
}

export function CreateContentDialog({
  item,
  contentPublishGranted,
  contentPublishBlockedReason,
  onClose,
  templateOptions = [],
}: {
  item: SourceItemRow;
  contentPublishGranted: boolean;
  contentPublishBlockedReason: string | null;
  onClose: () => void;
  /**
   * The full set fetched for the page (`catalog-sync/page.tsx`, across
   * every distinct `sourceLocale` present on the current page — see that
   * file's own comment), not pre-filtered to this one item. Filtered down
   * to `matchingTemplateOptions` below so the picker only ever offers a
   * template whose own `locale` actually matches this item's derived
   * locale (or the `{locale: null}` "all locales" wildcard
   * `article-templates/service.ts` still honors — P3's territory, not
   * removed here) — matrix #13's "模板选项按来源条目语种" requirement.
   */
  templateOptions?: readonly { readonly templateKey: string; readonly locale: string | null; readonly version: number }[];
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [applying, setApplying] = useState(false);
  const matchingTemplateOptions = templateOptions.filter(
    (template) => template.locale === null || template.locale === item.sourceLocale,
  );
  const [templateKey, setTemplateKey] = useState(matchingTemplateOptions[0]?.templateKey ?? "system-default-v1");

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
      templateKey,
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
  }, [item.id, templateKey]);

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
      templateKey,
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
        <label className="block text-sm text-gray-700">文章模板
          <select value={templateKey} onChange={(event) => setTemplateKey(event.target.value)} disabled={applying} className="mt-1 w-full rounded border border-gray-300 p-2">
            {matchingTemplateOptions.length === 0 && <option value="system-default-v1">system-default-v1（系统默认）</option>}
            {matchingTemplateOptions.map((template) => <option key={`${template.templateKey}:${template.version}`} value={template.templateKey}>{template.templateKey} · v{template.version}</option>)}
          </select>
        </label>

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
