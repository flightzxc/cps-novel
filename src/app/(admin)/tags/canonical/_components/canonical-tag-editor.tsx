"use client";

import { useEffect, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type {
  AdminCanonicalTagDetailView,
  AdminCanonicalTagKeywordView,
  AdminCanonicalTagView,
  AdminTagAuditEntryView,
} from "@/contracts";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { TagAuditLog } from "../../_components/tag-audit-log";
import { LocaleFieldEditor } from "./locale-field-editor";

type TranslationRow = { locale: string; displayName: string };

/**
 * Inline edit panel for one Canonical Tag, rendered by `CanonicalTagsClient`
 * inside the expanded row. Purely a form layer: every mutation is delegated
 * to the parent through `onSetStatus` / `onReplaceTranslations` /
 * `onReplaceAliases` so the parent owns the single busy/notice state and the
 * `x-request-id` ↔ body `requestId` pairing (see that file for why the two
 * must be generated together).
 *
 * `stableId` and `slug` are immutable identity, shown here for reference only
 * — nothing in this component can write to either. `keywords` has no writer
 * at all this round: the block below is fetched read-only from the detail
 * route and renders zero input/select/button[type=submit] controls, per the
 * "keyword is classifier-frozen authority" boundary this package documents.
 */
export function CanonicalTagEditor({
  tag,
  disabled,
  onSetStatus,
  onReplaceTranslations,
  onReplaceAliases,
}: {
  tag: AdminCanonicalTagView;
  disabled: boolean;
  onSetStatus: (status: "active" | "inactive") => void;
  onReplaceTranslations: (translations: readonly TranslationRow[]) => void;
  onReplaceAliases: (aliases: readonly string[]) => void;
}) {
  const [status, setStatus] = useState<"active" | "inactive">(tag.active ? "active" : "inactive");
  const [translations, setTranslations] = useState<TranslationRow[]>(
    tag.translations.map((item) => ({ ...item })),
  );
  const [aliases, setAliases] = useState<string[]>([...tag.aliases]);

  const [keywords, setKeywords] = useState<readonly AdminCanonicalTagKeywordView[] | null>(null);
  // P2-06.5 CPS-parity F1: the detail route's response already carries
  // `tag.audit` (up to 20 entries) alongside `tag.keywords` — both are
  // read off this one GET, so rendering the change-log section below never
  // costs a second request. `detailError` (renamed from `keywordsError`)
  // gates both sections: a failure here means the whole detail fetch
  // failed, not just one half of it.
  const [audit, setAudit] = useState<readonly AdminTagAuditEntryView[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // The list projection this editor's rows come from carries only
  // `keywordSummary` (a count), never the per-keyword array — that field is
  // detail-only (`projectCanonicalTag(..., detail: true)`). Opening the
  // editor is the explicit read gesture that justifies the extra GET; this is
  // a read, not a mutation, so it carries no `x-request-id`.
  //
  // No reset-to-null at the top of the effect: `keywords`/`audit`/`detailError`
  // already start `null`, and this effect's only dependency is `tag.id`,
  // which never changes without the parent remounting this whole component
  // via its `key={tag.id}:{tag.updatedAt}` (see `CanonicalTagsClient`) — so
  // there is never a second run to reset from.
  useEffect(() => {
    let cancelled = false;
    adminFetch<AdminCanonicalTagDetailView>(
      `/api/admin/canonical-tags?id=${encodeURIComponent(tag.id)}`,
    ).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setKeywords(result.data.tag.keywords ?? []);
        setAudit(result.data.tag.audit ?? []);
      } else {
        setDetailError(errorEnvelopeCopy(result.envelope));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tag.id]);

  function updateAlias(index: number, value: string) {
    setAliases((prev) => prev.map((item, i) => (i === index ? value : item)));
  }
  function removeAlias(index: number) {
    setAliases((prev) => prev.filter((_, i) => i !== index));
  }
  function addAlias() {
    setAliases((prev) => [...prev, ""]);
  }

  return (
    <div className="space-y-5" data-testid={`canonical-tag-editor-${tag.id}`}>
      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        <span>
          stableId <span className="font-mono text-gray-700">{tag.stableId}</span>
        </span>
        <span>
          slug <span className="font-mono text-gray-700">{tag.slug}</span>
        </span>
      </div>

      <section className="space-y-2" data-testid={`canonical-tag-status-form-${tag.id}`}>
        <h3 className="text-xs font-semibold text-gray-500">状态</h3>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSetStatus(status);
          }}
        >
          <select
            value={status}
            disabled={disabled}
            onChange={(event) => setStatus(event.target.value as "active" | "inactive")}
            aria-label={`Canonical Tag 状态 · ${tag.slug}`}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
          <button type="submit" disabled={disabled} className={buttonClassName("primary", "px-3 py-1.5 text-xs")}>
            更新状态
          </button>
        </form>
      </section>

      <section className="space-y-2" data-testid={`canonical-tag-translations-form-${tag.id}`}>
        <h3 className="text-xs font-semibold text-gray-500">译名（全量替换）</h3>
        {/*
          Fixed-locale editor, not free text: see `LocaleFieldEditor`'s doc
          comment. `translations` here stays the full `TranslationRow[]`
          this section submits — the editor just owns how it's populated.
        */}
        <LocaleFieldEditor value={translations} onChange={setTranslations} disabled={disabled} />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onReplaceTranslations(translations)}
            className={buttonClassName("primary", "px-3 py-1.5 text-xs")}
          >
            保存译名
          </button>
        </div>
      </section>

      <section className="space-y-2" data-testid={`canonical-tag-aliases-form-${tag.id}`}>
        <h3 className="text-xs font-semibold text-gray-500">别名（全量替换）</h3>
        <div className="space-y-2">
          {aliases.map((alias, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <input
                value={alias}
                disabled={disabled}
                onChange={(event) => updateAlias(index, event.target.value)}
                placeholder="别名"
                aria-label={`别名 ${index + 1}`}
                className="w-44 rounded border border-gray-300 px-2 py-1 text-xs"
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeAlias(index)}
                className={buttonClassName("ghost", "px-2 py-1 text-xs")}
              >
                移除
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={addAlias}
            className={buttonClassName("secondary", "px-2 py-1 text-xs")}
          >
            添加别名
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onReplaceAliases(aliases)}
            className={buttonClassName("primary", "px-3 py-1.5 text-xs")}
          >
            保存别名
          </button>
        </div>
      </section>

      {/*
        Read-only. No input, no select, no submit button — keywords are
        managed by the frozen classifier/keyword authority (see
        `ClassifierDiagnosticsPanel`), not by this admin screen. Rendering a
        writer here would imply this UI can edit what only the classifier
        pipeline actually owns.
      */}
      <section className="space-y-2" data-testid={`canonical-tag-keywords-${tag.id}`}>
        <h3 className="text-xs font-semibold text-gray-500">
          Keyword（{tag.keywordSummary.active}/{tag.keywordSummary.total} 启用 · 由冻结的 classifier 授权管理，此处只读）
        </h3>
        {detailError ? (
          <p className="text-xs text-red-700">{detailError}</p>
        ) : keywords === null ? (
          <p className="text-xs text-gray-400">加载中…</p>
        ) : keywords.length === 0 ? (
          <p className="text-xs text-gray-400">该 Canonical Tag 暂无 keyword。</p>
        ) : (
          <ul className="space-y-1">
            {keywords.map((keyword) => (
              <li
                key={keyword.keywordId}
                className="flex flex-wrap items-center gap-2 text-xs text-gray-600"
                data-testid={`canonical-tag-keyword-${keyword.keywordId}`}
              >
                <span className="font-mono">{keyword.value}</span>
                <span className="text-gray-400">{keyword.matchMode}</span>
                <span className="text-gray-400">{keyword.scriptBuckets.join(", ")}</span>
                <span className="text-gray-400">{keyword.lexiconVersion}</span>
                <StatusBadge tone={keyword.active ? "success" : "neutral"}>
                  {keyword.active ? "启用" : "停用"}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        CPS parity (P2-06.5 F1): the same detail response's `tag.audit`
        rendered as a change log, mirroring CPS `home-carousel/page.tsx`'s
        操作日志 section. No second request — see the effect above.
      */}
      <section className="space-y-2" data-testid={`canonical-tag-audit-${tag.id}`}>
        <h3 className="text-xs font-semibold text-gray-500">变更历史</h3>
        {detailError ? (
          <p className="text-xs text-red-700">{detailError}</p>
        ) : audit === null ? (
          <p className="text-xs text-gray-400">加载中…</p>
        ) : (
          <TagAuditLog entries={audit} testId={`canonical-tag-audit-log-${tag.id}`} />
        )}
      </section>
    </div>
  );
}
