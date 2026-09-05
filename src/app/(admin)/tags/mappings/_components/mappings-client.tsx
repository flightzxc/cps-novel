"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type {
  AdminCapabilityState,
  AdminSourceLabelMappingView,
  AdminTagMutationResultView,
} from "@/contracts";
import { adminFetch, type AdminFetchResult } from "@/features/admin-ui/admin-fetch";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { CanonicalTagPicker } from "./canonical-tag-picker";
import { RawIdentity } from "./raw-token";
import { MappingsTable } from "./mappings-table";

/**
 * The three shapes `PUT /api/admin/tag-mappings` accepts, each already
 * carrying everything `buildBody` needs to fill in `approve_edge` /
 * `deactivate_edge`'s exact key set.
 *
 * `expectedUpdatedAt` is never a field on this type on purpose: for
 * `reapprove` / `deactivate` it is *derived* from `row.updatedAt` inside
 * `buildBody`, and for `create` it is always `null`. There is no branch
 * anywhere that asks "is this new or existing?" — the three `kind`s already
 * answer that, so the operator is never asked to guess which
 * `expectedUpdatedAt` to send (P2-06.5 acceptance: "the UI must derive which
 * one to send from the row state it already has — never make the operator
 * choose").
 */
type Pending =
  | {
      kind: "create";
      channelAppId: string;
      rawLanguageScope: string;
      rawToken: string;
      canonicalTagId: string;
      mappingVersion: string;
    }
  | { kind: "reapprove"; row: AdminSourceLabelMappingView; mappingVersion: string }
  | { kind: "deactivate"; row: AdminSourceLabelMappingView };

const REFRESHABLE_CODES = new Set([
  "revision_conflict",
  "mapping_identity_conflict",
  "idempotency_conflict",
]);

/**
 * `requestId` is generated once per submission and threaded into both the
 * `x-request-id` header (via `adminFetch`'s `requestId` option) and the JSON
 * body's `requestId` field — the two must be byte-identical or the route
 * rejects with `invalid_tag_request` (`tagging-route.ts:44-48`). Building the
 * body here, not inline at each call site, is what keeps every action's key
 * set exactly matching `sourceLabelMappingMutation`'s `exactKeys` check —
 * one extra or missing key is a 400, not a partial success.
 */
function buildBody(action: Pending, requestId: string): Record<string, unknown> {
  if (action.kind === "create") {
    return {
      action: "approve_edge",
      requestId,
      channelAppId: action.channelAppId,
      rawLanguageScope: action.rawLanguageScope,
      rawToken: action.rawToken,
      canonicalTagId: action.canonicalTagId,
      mappingVersion: action.mappingVersion,
      expectedUpdatedAt: null,
    };
  }
  if (action.kind === "reapprove") {
    return {
      action: "approve_edge",
      requestId,
      channelAppId: action.row.channel.channelAppId,
      rawLanguageScope: action.row.rawLanguageScope,
      rawToken: action.row.rawToken,
      canonicalTagId: action.row.target.id,
      mappingVersion: action.mappingVersion,
      expectedUpdatedAt: action.row.updatedAt,
    };
  }
  return {
    action: "deactivate_edge",
    requestId,
    mappingId: action.row.id,
    expectedUpdatedAt: action.row.updatedAt,
  };
}

function submitPending(action: Pending): Promise<AdminFetchResult<AdminTagMutationResultView>> {
  const requestId = crypto.randomUUID();
  return adminFetch<AdminTagMutationResultView>("/api/admin/tag-mappings", {
    method: "PUT",
    requestId,
    body: buildBody(action, requestId),
  });
}

function labelFor(action: Pending): string {
  if (action.kind === "create") return "新增映射";
  if (action.kind === "reapprove") return action.row.active ? "重新审批" : "重新启用";
  return "停用映射";
}

function dialogTitle(action: Pending): string {
  if (action.kind === "create") return "确认新增该映射？";
  if (action.kind === "reapprove") return action.row.active ? "确认重新审批该映射？" : "确认重新启用该映射？";
  return "确认停用该映射？";
}

/**
 * Deliberately worded differently from every trigger button that can open
 * this dialog (the create form's submit button, and each row's 重新审批 /
 * 重新启用 / 停用 button): the trigger opens the dialog, this button is the
 * one that actually fires the mutation, and giving both the same accessible
 * name would make it impossible for a screen-reader user (or a test) to
 * tell which "重新审批" they are activating.
 */
function confirmButtonLabel(action: Pending): string {
  if (action.kind === "create") return "确认新增";
  if (action.kind === "reapprove") return action.row.active ? "确认重新审批" : "确认重新启用";
  return "确认停用";
}

/**
 * Every action here shares one warning, because every action here touches
 * the same live edge that novel tag resolution reads: creating or
 * re-approving makes an edge start (or keep) applying, deactivating makes it
 * stop. None of the three is a preview — P1-09-style destructive-action
 * confirmation (`ConfirmDialog`) gates all of them, not just deactivate.
 */
function ConfirmBody({
  pending,
  onMappingVersionChange,
}: {
  pending: Pending | null;
  onMappingVersionChange: (value: string) => void;
}) {
  if (!pending) return null;
  const identity =
    pending.kind === "create"
      ? {
          channelAppId: pending.channelAppId,
          scope: pending.rawLanguageScope,
          token: pending.rawToken,
          canonicalTagId: pending.canonicalTagId,
        }
      : {
          channelAppId: pending.row.channel.channelAppId,
          scope: pending.row.rawLanguageScope,
          token: pending.row.rawToken,
          canonicalTagId: pending.row.target.id,
        };

  return (
    <>
      <p className="text-red-700">
        此映射会影响所有匹配该 exact source token 的小说。
        {pending.kind === "deactivate"
          ? "停用后该边立即停止参与自动标签解析——历史记录仍会保留，没有硬删除。"
          : "确认后该边立即生效，参与自动标签解析。"}
      </p>
      <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-2 text-xs">
        <div>
          渠道 channelAppId：<span className="break-all font-mono">{identity.channelAppId}</span>
        </div>
        <RawIdentity scope={identity.scope} token={identity.token} />
        <div>
          目标 canonicalTagId：<span className="break-all font-mono">{identity.canonicalTagId}</span>
        </div>
      </div>
      {pending.kind !== "deactivate" && (
        <label className="block">
          {/*
            Deliberately not the same label text as the create form's own
            `映射版本 mappingVersion` field: both can be mounted at once (this
            dialog overlays the form, it does not replace it), and a second
            control with an identical accessible name would make
            `getByLabelText` — and a screen reader user tabbing through the
            page — unable to tell them apart.
          */}
          <span className="mb-1 block text-xs text-gray-500">映射版本（确认后提交）</span>
          <input
            value={pending.mappingVersion}
            onChange={(event) => onMappingVersionChange(event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
            required
          />
        </label>
      )}
    </>
  );
}

export function MappingsClient({
  items,
  tagManage,
  writeFlagEnabled = true,
  prefillCanonicalTagId,
}: {
  items: readonly AdminSourceLabelMappingView[];
  tagManage: AdminCapabilityState;
  /**
   * PR6 fix (lane F): `FEATURE_P2_06_5_TAG_ADMIN_WRITE`, read by the page
   * (`readTaggingFlagState()`) and passed through as a boolean the same way
   * `canonical-tags-client.tsx` does. Folded into `canManage` alongside the
   * existing RBAC check; the page renders `TaggingWriteDisabledNotice` above
   * this component when it is false. Optional, defaulting to `true`, so
   * every pre-existing caller (in particular
   * `tests/ui/admin-tag-mappings.test.tsx`, which this fix does not touch)
   * keeps its prior behavior unchanged.
   */
  writeFlagEnabled?: boolean;
  prefillCanonicalTagId?: string;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string; code?: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const [createChannelAppId, setCreateChannelAppId] = useState("");
  const [createScope, setCreateScope] = useState("");
  const [createToken, setCreateToken] = useState("");
  const [createCanonicalTagId, setCreateCanonicalTagId] = useState(prefillCanonicalTagId ?? "");
  const [createVersion, setCreateVersion] = useState("");

  const blocked = capabilityBlockReason("tag:manage", tagManage);
  const canManage = blocked === null && writeFlagEnabled;

  async function run(action: Pending) {
    setBusy(true);
    setNotice(null);
    const label = labelFor(action);
    const result = await submitPending(action);
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      // Copy is always the stable-code lookup — the envelope carries no
      // message field by design, so nothing here ever reads `.message`.
      setNotice({
        tone: "error",
        text: `${label}失败：${errorEnvelopeCopy(result.envelope)}`,
        code: result.envelope.code,
      });
      return;
    }
    setNotice({ tone: "ok", text: `${label}成功` });
    if (action.kind === "create") {
      setCreateChannelAppId("");
      setCreateScope("");
      setCreateToken("");
      setCreateCanonicalTagId("");
      setCreateVersion("");
    }
    router.refresh();
  }

  const createReady =
    createChannelAppId !== "" &&
    createScope !== "" &&
    createToken !== "" &&
    createCanonicalTagId !== "" &&
    createVersion !== "";

  return (
    <div className="space-y-5">
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
            revision_conflict / mapping_identity_conflict / idempotency_conflict
            all mean the screen's picture of this edge is stale (someone else
            moved it, or this exact identity already exists in a state this
            submission did not expect). This offers a manual refresh only —
            it never retries the same write automatically, which would risk
            silently overwriting whatever the other operator just committed.
          */}
          {notice.tone === "error" && notice.code && REFRESHABLE_CODES.has(notice.code) && (
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

      {canManage && (
        <form
          className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (!createReady) return;
            setPending({
              kind: "create",
              channelAppId: createChannelAppId,
              rawLanguageScope: createScope,
              rawToken: createToken,
              canonicalTagId: createCanonicalTagId,
              mappingVersion: createVersion,
            });
          }}
          data-testid="mapping-create-form"
        >
          <h2 className="text-sm font-semibold text-gray-900">新增映射</h2>
          <p className="text-xs text-gray-500">
            渠道 channelAppId 可从下方表格的「复制 ID」按钮获取——该字段的搜索选择器待后续 PR 补齐
            （需要一个当前不存在的渠道应用列表读服务）；目标 Canonical Tag 已改为直接搜索选择，无需
            再手动粘贴 ID。语言范围与 Raw Token 请直接粘贴渠道原始值——不要手动增删空格或改变大小写，
            否则不是同一个映射身份。
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              渠道 channelAppId
              <input
                value={createChannelAppId}
                onChange={(event) => setCreateChannelAppId(event.target.value)}
                className="rounded-lg border border-gray-300 px-2 py-1.5 font-mono text-sm"
                required
              />
            </label>
            <CanonicalTagPicker
              value={createCanonicalTagId}
              onChange={setCreateCanonicalTagId}
              testId="mapping-create-canonical-tag"
            />
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              语言范围 rawLanguageScope（精确）
              <textarea
                value={createScope}
                onChange={(event) => setCreateScope(event.target.value)}
                rows={1}
                wrap="off"
                className="resize-none overflow-x-auto rounded-lg border border-gray-300 px-2 py-1.5 font-mono text-sm"
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              Raw Token（精确）
              <textarea
                value={createToken}
                onChange={(event) => setCreateToken(event.target.value)}
                rows={1}
                wrap="off"
                className="resize-none overflow-x-auto rounded-lg border border-gray-300 px-2 py-1.5 font-mono text-sm"
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-500 sm:col-span-2">
              映射版本 mappingVersion
              <input
                value={createVersion}
                onChange={(event) => setCreateVersion(event.target.value)}
                className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                required
              />
            </label>
          </div>
          <button type="submit" disabled={busy || !createReady} className={buttonClassName("primary")}>
            新增映射
          </button>
        </form>
      )}

      <MappingsTable
        items={items}
        canManage={canManage}
        busy={busy}
        onReapprove={(row) => setPending({ kind: "reapprove", row, mappingVersion: row.mappingVersion })}
        onDeactivate={(row) => setPending({ kind: "deactivate", row })}
      />

      <ConfirmDialog
        open={pending !== null}
        pending={busy}
        title={pending ? dialogTitle(pending) : ""}
        confirmLabel={pending ? confirmButtonLabel(pending) : ""}
        confirmVariant={pending?.kind === "deactivate" ? "danger" : "primary"}
        body={
          <ConfirmBody
            pending={pending}
            onMappingVersionChange={(value) =>
              setPending((prev) => (prev && prev.kind !== "deactivate" ? { ...prev, mappingVersion: value } : prev))
            }
          />
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) void run(pending);
        }}
      />
    </div>
  );
}
