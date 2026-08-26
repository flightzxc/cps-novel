"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AdminCapabilityState } from "@/contracts";
import type { PublishGateReason } from "@/contracts/publish-gate";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import {
  publishArticleAction,
  restoreNovelAction,
  takedownNovelAction,
  withdrawNovelAction,
  type ApplyPublishTransitionResult,
  type PublishActionResult,
  type RightsTransitionKind,
} from "../_actions";
import { describeMissingMetadataFields, describePublishGateReason } from "../_lib/publish-gate-copy";
import { describePublishLifecycleError, describeRightsTransition } from "../_lib/publish-outcome-copy";
import type { PrimaryArticleRef } from "../_lib/read-primary-article";

/**
 * The publish / withdraw / takedown / restore controls (PR-C3).
 *
 * Button *visibility* mirrors `applyNovelRightsTransition`'s own
 * `requireSourceStatus` preconditions (withdraw only from `published`,
 * takedown from anything but `takedown`, restore only from `takedown`) —
 * this does not reimplement that business rule, it just declines to offer a
 * control the server is guaranteed to refuse given the status already shown
 * on this page. "发布" is the one exception without a status-transition
 * precondition inside the gate itself; it is hidden only when the Article is
 * already `published` (nothing to do) — a `takedown` Novel still shows no
 * publish control here, but not because of a client-side gate reimplementation:
 * it is hidden because `applyPublishTransition`'s Hard Gate will reject it
 * every time with `rights_blocked`, whose guidance already says to restore
 * first, so offering the button would just be a guaranteed round trip to the
 * exact same advice this panel can show without one.
 */

function invalidInputCopy(code: "reason_required" | "reason_too_long" | "selection_required"): string {
  switch (code) {
    case "reason_required":
      return "请填写操作原因后再提交（会写入审计记录）。";
    case "reason_too_long":
      return "操作原因过长，请控制在 1000 字以内。";
    case "selection_required":
      return "未选择任何书目。";
  }
}

function actionErrorMessage(result: Extract<PublishActionResult<unknown>, { ok: false }>): string {
  if (result.kind === "access_denied") return errorEnvelopeCopy(result.envelope);
  if (result.kind === "lifecycle_error") return describePublishLifecycleError(result.code);
  return invalidInputCopy(result.code);
}

function PublishOutcomePanel({ result }: { result: ApplyPublishTransitionResult }) {
  if (result.outcome === "published") {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        <p className="font-medium">发布成功{result.firstPublish ? "——这是该书目首次对外发布" : ""}。</p>
        <p className="mt-1 text-xs text-emerald-700">
          公开页面缓存已失效。
          {result.firstPublish
            ? " IndexNow 与站点地图刷新已在服务端异步触发（对应功能开关关闭时会各自静默跳过）。发布接口未返回这两项调度各自的执行结果（成功/跳过/失败），本页面暂无法展示更细的状态——这是已知的发布服务接口缺口，需要发布服务补充返回值才能在此如实呈现。"
            : " 非首次发布不会再次触发 IndexNow / 站点地图刷新调度（那只在首次公开发布时发生一次）。"}
        </p>
      </div>
    );
  }
  if (result.outcome === "not_found") {
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
        对应文章不存在，请刷新页面后重试。
      </p>
    );
  }
  if (result.outcome === "conflict") {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        检测到并发修改（发布读取之后、写入之前，该书目的权利状态被另一次操作改动），本次发布已安全放弃、未写入——数据不会被破坏性覆盖。可直接重试。
      </p>
    );
  }
  // rejected
  const gate = result.gate;
  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <p className="font-medium">未通过发布门禁，共 {gate.reasons.length} 项：</p>
      <ul className="space-y-2">
        {gate.reasons.map((reason: PublishGateReason) => {
          const copy = describePublishGateReason(reason);
          const missing =
            reason === "required_metadata_missing"
              ? describeMissingMetadataFields(gate.requiredMetadataMissing)
              : null;
          return (
            <li key={reason} data-testid={`publish-gate-reason-${reason}`} className="border-l-2 border-red-300 pl-2">
              <p className="font-medium">{copy.label}</p>
              <p className="text-xs text-red-700">{copy.guidance}</p>
              {missing && <p className="text-xs text-red-700">{missing}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PublishLifecyclePanel({
  novelId,
  novelStatus,
  article,
  canPublish,
  canTakedown,
}: {
  novelId: string;
  novelStatus: string;
  article: PrimaryArticleRef | null;
  canPublish: AdminCapabilityState;
  canTakedown: AdminCapabilityState;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [publishResult, setPublishResult] = useState<ApplyPublishTransitionResult | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState<RightsTransitionKind | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  function openTransition(kind: RightsTransitionKind) {
    setReasonError(null);
    setPending(kind);
  }

  const publishBlocked = capabilityBlockReason("content:publish", canPublish);
  const takedownBlocked = capabilityBlockReason("content:takedown", canTakedown);

  const showPublish = article !== null && article.status !== "published" && novelStatus !== "takedown";
  const showWithdraw = novelStatus === "published";
  const showTakedown = novelStatus !== "takedown";
  const showRestore = novelStatus === "takedown";

  async function runPublish() {
    if (!article) return;
    setBusy(true);
    setNotice(null);
    setPublishResult(null);
    const result = await publishArticleAction({
      novelId,
      articleId: article.articleId,
      requestId: crypto.randomUUID(),
    });
    setBusy(false);
    if (!result.ok) {
      setNotice({ tone: "error", text: `发布失败：${actionErrorMessage(result)}` });
      return;
    }
    setPublishResult(result.data);
    if (result.data.outcome === "published") router.refresh();
  }

  async function runRightsTransition(kind: RightsTransitionKind) {
    const trimmed = reason.trim();
    if (!trimmed) {
      // Was a silent no-op before: the confirm dialog stayed open with no
      // feedback at all, and `invalidInputCopy("reason_required")` — the
      // exact text the server itself would return for the same condition —
      // was unreachable from this button. Surface it in place instead, so
      // the operator sees why nothing happened and the copy actually ships.
      setReasonError(invalidInputCopy("reason_required"));
      return;
    }
    setReasonError(null);
    setBusy(true);
    setNotice(null);
    const requestId = crypto.randomUUID();
    const call =
      kind === "withdraw"
        ? withdrawNovelAction({ novelId, requestId, reason: trimmed })
        : kind === "takedown"
          ? takedownNovelAction({ novelId, requestId, reason: trimmed })
          : restoreNovelAction({ novelId, requestId, reason: trimmed });
    const result = await call;
    setBusy(false);
    setPending(null);
    setReason("");
    const label = describeRightsTransition(kind).actionLabel;
    if (!result.ok) {
      setNotice({ tone: "error", text: `${label}失败：${actionErrorMessage(result)}` });
      return;
    }
    setNotice({
      tone: "ok",
      text: `${describeRightsTransition(kind).successMessage}（受影响文章数：${result.data.affectedArticleIds.length}）`,
    });
    setPublishResult(null);
    router.refresh();
  }

  const copy = pending ? describeRightsTransition(pending) : null;

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">发布与权利态操作</h2>

      {notice && (
        <p
          role="status"
          className={`rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {notice.text}
        </p>
      )}

      {publishResult && <PublishOutcomePanel result={publishResult} />}
      {publishResult?.outcome === "conflict" && (
        <button
          type="button"
          disabled={busy}
          className={buttonClassName("secondary")}
          onClick={runPublish}
          data-testid="publish-retry-conflict"
        >
          重试发布
        </button>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {showPublish && (
          <button
            type="button"
            disabled={busy || publishBlocked !== null}
            title={publishBlocked ?? undefined}
            className={buttonClassName("primary")}
            onClick={runPublish}
            data-testid="publish-action-publish"
          >
            发布
          </button>
        )}
        {showWithdraw && (
          <button
            type="button"
            disabled={busy || publishBlocked !== null}
            title={publishBlocked ?? undefined}
            className={buttonClassName("secondary")}
            onClick={() => openTransition("withdraw")}
            data-testid="publish-action-withdraw"
          >
            下架
          </button>
        )}
        {showTakedown && (
          <button
            type="button"
            disabled={busy || takedownBlocked !== null}
            title={takedownBlocked ?? undefined}
            className={buttonClassName("danger")}
            onClick={() => openTransition("takedown")}
            data-testid="publish-action-takedown"
          >
            版权/安全移除
          </button>
        )}
        {showRestore && (
          <button
            type="button"
            disabled={busy || takedownBlocked !== null}
            title={takedownBlocked ?? undefined}
            className={buttonClassName("secondary")}
            onClick={() => openTransition("restore")}
            data-testid="publish-action-restore"
          >
            恢复
          </button>
        )}
      </div>

      {publishBlocked && (showPublish || showWithdraw) && (
        <p className="text-xs text-amber-700">{publishBlocked}</p>
      )}
      {takedownBlocked && (showTakedown || showRestore) && (
        <p className="text-xs text-amber-700">{takedownBlocked}</p>
      )}
      {article === null && (
        <p className="text-xs text-gray-400">该书目暂无关联文章，无法执行发布。</p>
      )}

      <ConfirmDialog
        open={pending !== null}
        pending={busy}
        title={copy?.confirmTitle ?? ""}
        confirmLabel={copy?.confirmLabel ?? "确认"}
        confirmVariant={pending === "takedown" ? "danger" : "secondary"}
        body={
          <RightsTransitionConfirmBody
            kind={pending}
            reason={reason}
            onReason={(value) => {
              setReason(value);
              if (reasonError) setReasonError(null);
            }}
            reasonError={reasonError}
          />
        }
        onCancel={() => {
          if (busy) return;
          setPending(null);
          setReason("");
          setReasonError(null);
        }}
        onConfirm={() => {
          if (pending) void runRightsTransition(pending);
        }}
      />
    </section>
  );
}

function RightsTransitionConfirmBody({
  kind,
  reason,
  onReason,
  reasonError,
}: {
  kind: RightsTransitionKind | null;
  reason: string;
  onReason: (value: string) => void;
  reasonError: string | null;
}) {
  if (!kind) return null;
  const copy = describeRightsTransition(kind);
  return (
    <>
      <p data-testid={`rights-transition-warning-${kind}`}>{copy.warning}</p>
      <label className="block">
        <span className="mb-1 block text-xs text-gray-500">操作原因（必填，写入审计）</span>
        <input
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          aria-invalid={reasonError !== null}
          className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          placeholder={kind === "takedown" ? "例如：版权方要求下线" : "例如：运营决定临时下线"}
        />
      </label>
      {reasonError && (
        <p role="alert" data-testid="rights-transition-reason-error" className="text-xs text-red-700">
          {reasonError}
        </p>
      )}
    </>
  );
}
