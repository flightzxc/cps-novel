"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type {
  AdminCanonicalTagView,
  AdminCapabilityState,
  AdminErrorCode,
  AdminNovelTagMutationResultView,
  AdminNovelTagsView,
  AdminResolvedTagView,
} from "@/contracts";
import { adminFetch, type AdminFetchResult } from "@/features/admin-ui/admin-fetch";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

/**
 * Duplicated from `novel-tags-panel.tsx` rather than imported: that module has
 * no `"use client"` directive and pulls in `@/server/tagging/admin-service`
 * (Prisma, Node crypto). Importing anything from it here would drag that
 * server-only chain into the client bundle. Same discipline as
 * `tags/_components/tag-badges.tsx:15` — copy the small presentational piece,
 * don't cross the Server/Client boundary.
 */
const PROVENANCE_LABEL: Readonly<Record<AdminResolvedTagView["provenance"][number], string>> =
  Object.freeze({
    manual: "人工",
    mapped: "映射",
    auto: "自动",
  });

function ReferenceChip({ tag }: { tag: AdminResolvedTagView }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
      <span className="break-all">{tag.displayName}</span>
      <span className="shrink-0 text-gray-400">
        （{tag.provenance.map((entry) => PROVENANCE_LABEL[entry]).join("·")}）
      </span>
    </span>
  );
}

/**
 * 409s where a retry (auto or manual-overwrite) would be the wrong move: the
 * data moved under the operator, so the only safe next step is to look again.
 * The notice offers a refresh button for these rather than letting the
 * operator resubmit blind.
 */
const REFRESH_SUGGESTED_CODES: ReadonlySet<AdminErrorCode> = new Set<AdminErrorCode>([
  "revision_conflict",
  "manual_mode_conflict",
  "idempotency_conflict",
  "inactive_canonical_tag",
]);

type Notice = Readonly<{ tone: "ok" | "error"; text: string; code?: AdminErrorCode }>;

function TakeoverBody({
  canonicalTags,
  selected,
  onToggle,
  onClear,
  referenceLabel,
  referenceTags,
}: {
  canonicalTags: readonly AdminCanonicalTagView[];
  selected: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  onClear: () => void;
  referenceLabel: string;
  referenceTags: readonly AdminResolvedTagView[];
}) {
  return (
    <div className="space-y-3">
      {/* ADR-mandated wording, verbatim — this is a full-replacement decision,
          never described as "adding" or "appending" tags. */}
      <p>
        手动接管后，你当前选择的标签集合将成为这本小说的完整最终标签集合。
        自动标签和渠道映射不会继续叠加到最终结果。
      </p>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gray-500" data-testid="takeover-selected-count">
          已选 {selected.size} 个
        </span>
        <button
          type="button"
          className={buttonClassName("ghost", "px-2 py-1 text-xs")}
          onClick={onClear}
        >
          清空已选标签
        </button>
      </div>

      <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 p-2">
        {canonicalTags.length === 0 ? (
          <p className="px-1 py-2 text-xs text-gray-400">没有可选的 Canonical Tag</p>
        ) : (
          <ul className="space-y-1">
            {canonicalTags.map((tag) => (
              <li key={tag.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50">
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0"
                    checked={selected.has(tag.id)}
                    onChange={(event) => onToggle(tag.id, event.target.checked)}
                  />
                  <span className="min-w-0 break-all text-gray-900">
                    {tag.canonicalDefinition}
                    <span className="ml-1 text-xs text-gray-400">/{tag.slug}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Read-only reference, never a source to copy from — there is no
          "use current tags" control anywhere in this dialog by design. See
          ADR §67 / owner review §159,§195: prefill-and-edit is a deferred,
          separate feature, not something to sneak in here for convenience. */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-500">{referenceLabel}</p>
        {referenceTags.length === 0 ? (
          <p className="text-xs text-gray-400">无</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {referenceTags.map((tag) => (
              <ReferenceChip key={tag.canonicalTagId} tag={tag} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function NovelTagsEditor({
  novelId,
  tagsView,
  canonicalTags,
  capability,
  writeFlagEnabled = true,
}: {
  novelId: string;
  tagsView: AdminNovelTagsView;
  canonicalTags: readonly AdminCanonicalTagView[];
  capability: AdminCapabilityState;
  /**
   * PR6 fix (lane F): `FEATURE_P2_06_5_TAG_ADMIN_WRITE`, read by
   * `NovelTagsPanel` (`readTaggingFlagState()`) and passed through as a plain
   * boolean the same way `canonical-tags-client.tsx` /
   * `mappings-client.tsx` do. Folded into `canManage` alongside the existing
   * RBAC check; the panel renders `TaggingWriteDisabledNotice` above this
   * editor when it is false. Optional, defaulting to `true`, so every
   * pre-existing caller (in particular `tests/ui/admin-novel-tags.test.tsx`,
   * which this fix does not touch) keeps its prior behavior unchanged.
   */
  writeFlagEnabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const blocked = capabilityBlockReason("tag:manage", capability);
  const canManage = blocked === null && writeFlagEnabled;

  async function run(
    label: string,
    call: () => Promise<AdminFetchResult<AdminNovelTagMutationResultView>>,
  ): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setNotice({
        tone: "error",
        code: result.envelope.code,
        text: `${label}失败：${errorEnvelopeCopy(result.envelope)}`,
      });
      return false;
    }
    setNotice({ tone: "ok", text: `${label}成功` });
    router.refresh();
    return true;
  }

  function openTakeover() {
    // Zero-prefill, always — this is the owner-signed decision the ADR
    // freezes: the selector opens with nothing checked, never the current
    // effective/manual set.
    setSelected(new Set());
    setNotice(null);
    setTakeoverOpen(true);
  }

  function toggle(id: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function submitReplaceManual(canonicalTagIds: readonly string[]) {
    const requestId = crypto.randomUUID();
    const ok = await run("保存人工标签", () =>
      adminFetch<AdminNovelTagMutationResultView>("/api/admin/novels/tags", {
        method: "PUT",
        requestId,
        body: {
          action: "replace_manual",
          requestId,
          novelId,
          expectedRevision: tagsView.revision,
          canonicalTagIds,
        },
      }),
    );
    if (ok) {
      setTakeoverOpen(false);
      setEmptyConfirmOpen(false);
    }
  }

  function handleTakeoverConfirm() {
    if (busy) return;
    const ids = [...selected];
    if (ids.length === 0) {
      // Second, explicit confirmation before a 0-tag snapshot — this is not
      // the same click as picking some tags and saving.
      setTakeoverOpen(false);
      setEmptyConfirmOpen(true);
      return;
    }
    void submitReplaceManual(ids);
  }

  async function handleExitConfirm() {
    const requestId = crypto.randomUUID();
    const ok = await run("恢复自动标签", () =>
      adminFetch<AdminNovelTagMutationResultView>("/api/admin/novels/tags", {
        method: "PUT",
        requestId,
        body: {
          action: "exit_manual",
          requestId,
          novelId,
          expectedRevision: tagsView.revision,
        },
      }),
    );
    if (ok) setExitOpen(false);
  }

  const referenceLabel =
    tagsView.mode === "manual"
      ? "当前人工标签集合（本次操作将整体替换，仅供参考，不会预填）"
      : "当前自动结果（渠道映射∪自动分类，仅供参考，不会预填）";
  const referenceTags = tagsView.mode === "manual" ? tagsView.manual : tagsView.effective;

  return (
    <div className="space-y-3 border-t border-gray-100 pt-3">
      {blocked && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {blocked}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          <span>{notice.text}</span>
          {notice.tone === "error" && notice.code && REFRESH_SUGGESTED_CODES.has(notice.code) && (
            <button
              type="button"
              className={buttonClassName("secondary", "px-2 py-1 text-xs")}
              onClick={() => router.refresh()}
            >
              刷新
            </button>
          )}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !canManage}
          className={buttonClassName("primary", "px-3 py-1.5 text-xs")}
          onClick={openTakeover}
        >
          手动接管标签
        </button>
        {tagsView.mode === "manual" && (
          <button
            type="button"
            disabled={busy || !canManage}
            className={buttonClassName("secondary", "px-3 py-1.5 text-xs")}
            onClick={() => setExitOpen(true)}
          >
            恢复自动标签
          </button>
        )}
      </div>

      <ConfirmDialog
        open={takeoverOpen}
        pending={busy}
        title="手动接管标签"
        confirmLabel="确认接管并保存"
        body={
          <TakeoverBody
            canonicalTags={canonicalTags}
            selected={selected}
            onToggle={toggle}
            onClear={() => setSelected(new Set())}
            referenceLabel={referenceLabel}
            referenceTags={referenceTags}
          />
        }
        onCancel={() => setTakeoverOpen(false)}
        onConfirm={handleTakeoverConfirm}
      />

      <ConfirmDialog
        open={emptyConfirmOpen}
        pending={busy}
        title="确认设为 0 个标签？"
        confirmLabel="确认设为 0 个"
        body={<p>你正在把最终标签设为 0 个。该小说将不带任何题材标签。</p>}
        onCancel={() => {
          // Back to the selector, not a full close — the operator's (empty)
          // selection is still there to change their mind about.
          setEmptyConfirmOpen(false);
          setTakeoverOpen(true);
        }}
        onConfirm={() => void submitReplaceManual([])}
      />

      <ConfirmDialog
        open={exitOpen}
        pending={busy}
        title="确认恢复自动标签？"
        confirmLabel="确认恢复"
        body={
          <p>
            恢复后将删除当前人工标签集合——界面无法撤回，只有审计记录留存原值；且不会重新触发自动分类：恢复得到的是渠道映射与自动分类
            <span className="font-medium">现有</span>的结果，不会重新计算。
          </p>
        }
        onCancel={() => setExitOpen(false)}
        onConfirm={() => void handleExitConfirm()}
      />
    </div>
  );
}
