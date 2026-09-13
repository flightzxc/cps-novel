"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import type { CatalogBatchContext, CatalogSelection } from "@/domain/catalog-batch";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import {
  applyContentCreationBatchAction,
  readCatalogBatchContextAction,
  readCatalogBatchSummaryAction,
} from "../_actions";

type Stage = "loading" | "form" | "submitting" | "counting" | "error";
type Summary = { submittedCount: number | null; ineligibleCount: number | null };

function formatCount(value: number | null): string {
  return (value ?? 0).toLocaleString("zh-CN");
}

export function BatchCreateContentDialog({
  selection,
  contentPublishGranted,
  contentPublishBlockedReason,
  onClose,
  onSubmitted,
}: {
  selection: CatalogSelection;
  contentPublishGranted: boolean;
  contentPublishBlockedReason: string | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mountedRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  const selectionRef = useRef(selection);
  const requestIdRef = useRef(crypto.randomUUID());
  const submittedRef = useRef(false);
  const frozenTemplatesRef = useRef<Record<string, string> | null>(null);

  const [context, setContext] = useState<CatalogBatchContext | null>(null);
  const [templateKeys, setTemplateKeys] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<Stage>("loading");
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    dialogRef.current?.showModal();
    void readCatalogBatchContextAction({ selection: selectionRef.current, requestId: crypto.randomUUID() })
      .then((result) => {
        if (!mountedRef.current) return;
        if (!result.ok) {
          setMessage(result.kind === "access_denied" ? errorEnvelopeCopy(result.envelope) : "无法读取所选条目，请重试");
          setStage("error");
          return;
        }
        setContext(result.data);
        setStage("form");
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setMessage("无法读取所选条目，请重试");
        setStage("error");
      });
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function poll(id: string): Promise<void> {
    try {
      const result = await readCatalogBatchSummaryAction({ taskId: id, requestId: crypto.randomUUID() });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setMessage("无法读取任务统计，请在任务中心查看");
        setStage("error");
        return;
      }
      if (result.data.submittedCount !== null && result.data.ineligibleCount !== null) {
        setSummary(result.data);
        return;
      }
      if (["disabled", "failed", "expired"].includes(result.data.phase)) {
        setMessage("任务已提交，请在任务中心查看状态");
        setStage("error");
        return;
      }
      timerRef.current = window.setTimeout(() => {
        if (mountedRef.current) void poll(id);
      }, 900);
    } catch {
      if (!mountedRef.current) return;
      setMessage("无法读取任务统计，请在任务中心查看");
      setStage("error");
    }
  }

  async function submit(): Promise<void> {
    if (!context || !contentPublishGranted || taskId || submittedRef.current) return;
    submittedRef.current = true;
    frozenTemplatesRef.current ??= { ...templateKeys };
    setStage("submitting");
    try {
      const result = await applyContentCreationBatchAction({
        selection: selectionRef.current,
        templateKeysByLocale: frozenTemplatesRef.current,
        requestId: requestIdRef.current,
      });
      if (!mountedRef.current) return;
      if (!result.ok) {
        submittedRef.current = false;
        setMessage(result.kind === "access_denied" ? errorEnvelopeCopy(result.envelope) : "提交失败，请检查模板后重试");
        setStage("error");
        return;
      }
      setTaskId(result.data.taskId);
      onSubmitted();
      setStage("counting");
      void poll(result.data.taskId);
    } catch {
      if (!mountedRef.current) return;
      submittedRef.current = false;
      setMessage("提交失败，请重试");
      setStage("error");
    }
  }

  function chooseTemplate(locale: string, key: string): void {
    if (frozenTemplatesRef.current !== null) return;
    setTemplateKeys((current) => {
      const next = { ...current };
      if (key) next[locale] = key;
      else delete next[locale];
      return next;
    });
  }

  const canSubmit = Boolean(context) && contentPublishGranted && !taskId && !submittedRef.current && (stage === "form" || stage === "error");

  return (
    <dialog ref={dialogRef} onCancel={(event) => { event.preventDefault(); if (stage !== "submitting") onClose(); }} className="m-auto max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-gray-200 bg-white p-0 text-gray-900 shadow-xl backdrop:bg-gray-900/40">
      <div className="space-y-4 p-5">
        <h2 className="text-base font-semibold">批量创建内容</h2>
        {stage === "loading" && <p className="text-sm text-gray-600">正在读取模板配置…</p>}
        {context?.locales.map((locale) => (
          <label className="block text-sm text-gray-700" key={locale.locale}>
            {locale.locale}（{locale.eligibleCount} 条）
            <select value={templateKeys[locale.locale] ?? ""} disabled={frozenTemplatesRef.current !== null} onChange={(event) => chooseTemplate(locale.locale, event.target.value)} className="mt-1 w-full rounded border border-gray-300 bg-white p-2 text-gray-900 disabled:bg-gray-100 disabled:text-gray-500">
              <option value="">服务默认模板</option>
              {locale.templates.map((template) => <option value={template.key} key={template.key}>{template.name}</option>)}
            </select>
          </label>
        ))}
        {contentPublishBlockedReason && <p className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">{contentPublishBlockedReason}</p>}
        {taskId && <Link href={`/tasks/${taskId}`} className="text-sm text-blue-700 underline">查看任务</Link>}
        {stage === "counting" && <p role="status" className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">{summary ? <>任务已提交：{formatCount(summary.submittedCount)} 条<br />不符合创建条件：{formatCount(summary.ineligibleCount)} 条</> : "任务已提交，正在统计…"}</p>}
        {stage === "error" && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">{message}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClassName("secondary")} onClick={onClose} disabled={stage === "submitting"}>关闭</button>
          {!taskId && <button type="button" className={buttonClassName("primary")} disabled={!canSubmit} onClick={() => void submit()}>{stage === "submitting" ? "正在提交…" : "创建内容"}</button>}
        </div>
      </div>
    </dialog>
  );
}
