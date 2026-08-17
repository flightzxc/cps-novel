"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type {
  AdminCanonicalTagView,
  AdminCapabilityState,
  AdminTagMutationResultView,
} from "@/contracts";
import { adminFetch, type AdminFetchResult } from "@/features/admin-ui/admin-fetch";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { formatDateTime } from "@/features/admin-ui/content-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { CanonicalTagEditor } from "./canonical-tag-editor";

type TranslationRow = { locale: string; displayName: string };

/**
 * `translations` where `locale === "zh"` is the only source for the display
 * name column. If there is no `zh` row this returns `null` and the caller
 * renders "—" — never the slug, never another locale. Substituting either
 * would read to an operator as "this row has a Chinese name," which is false
 * and exactly the compensating UI `tags-table.tsx:83-93` forbids for the same
 * reason on `/tags`.
 */
function zhDisplayName(tag: AdminCanonicalTagView): string | null {
  return tag.translations.find((item) => item.locale === "zh")?.displayName ?? null;
}

/**
 * Every mutation call builds its own fresh `requestId` and threads the exact
 * same value into both the `x-request-id` header (via `adminFetch`'s
 * `requestId` option) and the JSON body's `requestId` field. The two must be
 * byte-identical — the route rejects otherwise with `invalid_tag_request` —
 * and a fresh id per call is what makes a retry-with-different-payload land
 * on `idempotency_conflict` instead of silently overwriting.
 */
function setStatus(canonicalTagId: string, expectedUpdatedAt: string, status: "active" | "inactive") {
  const requestId = crypto.randomUUID();
  return adminFetch<AdminTagMutationResultView>("/api/admin/canonical-tags", {
    method: "PUT",
    requestId,
    body: { action: "set_status", requestId, canonicalTagId, expectedUpdatedAt, status },
  });
}

function replaceTranslations(
  canonicalTagId: string,
  expectedUpdatedAt: string,
  translations: readonly TranslationRow[],
) {
  const requestId = crypto.randomUUID();
  return adminFetch<AdminTagMutationResultView>("/api/admin/canonical-tags", {
    method: "PUT",
    requestId,
    body: { action: "replace_translations", requestId, canonicalTagId, expectedUpdatedAt, translations },
  });
}

function replaceAliases(canonicalTagId: string, expectedUpdatedAt: string, aliases: readonly string[]) {
  const requestId = crypto.randomUUID();
  return adminFetch<AdminTagMutationResultView>("/api/admin/canonical-tags", {
    method: "PUT",
    requestId,
    body: { action: "replace_aliases", requestId, canonicalTagId, expectedUpdatedAt, aliases },
  });
}

export function CanonicalTagsClient({
  items,
  tagManage,
}: {
  items: readonly AdminCanonicalTagView[];
  tagManage: AdminCapabilityState;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const blocked = capabilityBlockReason("tag:manage", tagManage);
  const canManage = blocked === null;

  async function run<T>(label: string, call: () => Promise<AdminFetchResult<T>>): Promise<T | null> {
    setBusy(true);
    setNotice(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      // Copy is always the stable-code lookup, never a server string — the
      // envelope has no message field by design (`error-copy.ts`'s own rule).
      setNotice({
        tone: "error",
        text: `${label}失败：${errorEnvelopeCopy(result.envelope)}`,
        code: result.envelope.code,
      });
      return null;
    }
    setNotice({ tone: "ok", text: `${label}成功` });
    router.refresh();
    return result.data;
  }

  return (
    <div className="space-y-3">
      {blocked && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {blocked}
        </p>
      )}
      {notice && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          <p>{notice.text}</p>
          {/*
            revision_conflict / alias_collision mean the row on screen is
            stale. This offers a manual refresh — it never retries the same
            write automatically, which would risk silently overwriting
            whatever the other operator just committed.
          */}
          {notice.tone === "error" && (notice.code === "revision_conflict" || notice.code === "alias_collision") && (
            <button
              type="button"
              onClick={() => router.refresh()}
              className={buttonClassName("secondary", "mt-2 px-2 py-1 text-xs")}
            >
              刷新
            </button>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center shadow-sm">
          <p className="text-gray-400">没有符合条件的 Canonical Tag</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Slug</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">中文展示名</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">定义</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">译名 · 别名 · Keyword</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">更新时间</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">
                  <span className="sr-only">编辑</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((tag) => {
                const zh = zhDisplayName(tag);
                const expanded = expandedId === tag.id;
                return (
                  <Fragment key={tag.id}>
                    <tr className="hover:bg-gray-50" data-testid={`canonical-tag-row-${tag.id}`}>
                      <td className="px-4 py-3">
                        <span className="break-all font-mono text-xs font-medium text-gray-900">{tag.slug}</span>
                        <span className="ml-2 break-all text-xs text-gray-400">{tag.stableId}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-600" data-testid={`canonical-tag-zh-${tag.id}`}>
                        {zh ?? <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge tone={tag.active ? "success" : "neutral"}>
                          {tag.active ? "启用" : "停用"}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="block max-w-xs truncate" title={tag.canonicalDefinition}>
                          {tag.canonicalDefinition}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        译名 {tag.translations.length} · 别名 {tag.aliases.length} · keyword{" "}
                        {tag.keywordSummary.active}/{tag.keywordSummary.total}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{formatDateTime(tag.updatedAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : tag.id)}
                          className={buttonClassName("secondary", "px-3 py-1.5 text-xs")}
                          data-testid={`canonical-tag-edit-${tag.id}`}
                        >
                          {expanded ? "收起" : "编辑"}
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={7} className="bg-gray-50 px-4 py-4">
                          <CanonicalTagEditor
                            // Remount on every `updatedAt` change so the
                            // editor's local draft state (status select,
                            // translation/alias rows) resets to the fresh
                            // server values after a successful mutation
                            // triggers `router.refresh()`, instead of quietly
                            // keeping a stale draft next to a new revision.
                            key={`${tag.id}:${tag.updatedAt}`}
                            tag={tag}
                            disabled={busy || !canManage}
                            onSetStatus={(status) =>
                              void run("更新状态", () => setStatus(tag.id, tag.updatedAt, status))
                            }
                            onReplaceTranslations={(translations) =>
                              void run("更新译名", () =>
                                replaceTranslations(tag.id, tag.updatedAt, translations),
                              )
                            }
                            onReplaceAliases={(aliases) =>
                              void run("更新别名", () => replaceAliases(tag.id, tag.updatedAt, aliases))
                            }
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
