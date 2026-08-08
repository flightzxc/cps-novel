"use client";

import { useState } from "react";

import type { AdminChapterContentView } from "@/contracts";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { formatDateTime } from "@/features/admin-ui/content-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

type ViewerState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly content: AdminChapterContentView }
  | { readonly kind: "error"; readonly message: string };

/**
 * Chapter body viewer.
 *
 * ## Why the body is behind a click
 *
 * It would be easy to fetch on mount and let the operator "just see it". Two
 * reasons not to. The body is licensed prose, so `content:read` gates it
 * separately from the metadata that got the operator to this page — fetching on
 * mount would mean every navigation demands the stronger grant. And every read
 * writes an `operation_audit` row server-side; firing that on mount would fill
 * the audit with "the page was open" instead of "someone chose to read this".
 *
 * So the body is never part of the chapter list payload, never part of this
 * page's server render, and arrives only from an explicit request.
 *
 * ## What is deliberately not here
 *
 * No edit affordance, no "copy raw", no upstream payload panel — P2-04 is a read
 * slice, and a disabled placeholder button would still be a promise the phase
 * cannot keep.
 */
export function ChapterContentViewer({
  novelId,
  chapterId,
  hasContent,
}: {
  novelId: string;
  chapterId: string;
  hasContent: boolean;
}) {
  const [state, setState] = useState<ViewerState>({ kind: "idle" });

  if (!hasContent) {
    return (
      <p data-testid="chapter-content-absent" className="text-sm text-gray-500">
        该章节尚未落地正文，暂无内容可读。
      </p>
    );
  }

  const load = async () => {
    setState({ kind: "loading" });
    const params = new URLSearchParams({ novelId, chapterId });
    const result = await adminFetch<AdminChapterContentView>(
      `/api/admin/novels/chapters/content?${params.toString()}`,
    );
    setState(
      result.ok
        ? { kind: "loaded", content: result.data }
        : { kind: "error", message: errorEnvelopeCopy(result.envelope) },
    );
  };

  return (
    <div className="space-y-4">
      {state.kind !== "loaded" && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={load}
            disabled={state.kind === "loading"}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {state.kind === "loading" ? "读取中…" : "读取正文"}
          </button>
          <p className="text-xs text-gray-500">每次读取都会记录一条访问审计。</p>
        </div>
      )}

      {state.kind === "loading" && (
        <div
          aria-busy="true"
          aria-live="polite"
          data-testid="chapter-content-loading"
          className="space-y-2 rounded-xl border border-gray-200 bg-white p-6"
        >
          <span className="sr-only">正文读取中</span>
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="h-4 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      )}

      {state.kind === "error" && (
        <div
          role="alert"
          data-testid="chapter-content-error"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {state.message}
        </div>
      )}

      {state.kind === "loaded" && (
        <article data-testid="chapter-content-body" className="space-y-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>字数 {state.content.charCount}</span>
            <span>指纹 {state.content.contentHashPrefix}</span>
            <span>落地于 {formatDateTime(state.content.materializedAt)}</span>
          </div>
          {/*
            `whitespace-pre-wrap` keeps upstream paragraphing without ever
            interpreting the body as markup, and the fixed max height stops a
            2000-chapter novel from turning one page into an infinite scroll.
          */}
          <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-gray-200 bg-white p-6">
            <p className="whitespace-pre-wrap text-[15px] leading-8 text-gray-800">
              {state.content.body}
            </p>
          </div>
        </article>
      )}
    </div>
  );
}
