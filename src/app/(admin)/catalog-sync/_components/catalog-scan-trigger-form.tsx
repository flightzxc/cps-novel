"use client";

import { useMemo, useState, type FormEvent } from "react";

import { buttonClassName } from "@/components/ui/button";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { applyCatalogScanTaskAction, dryRunCatalogScanTaskAction } from "../_actions";
import type { ChannelAppScanOption } from "../_lib/read-channel-apps";
import {
  catalogScanFlagChecklist,
  catalogScanStatusQuery,
  describeCatalogScanOutcome,
  CATALOG_SCAN_NEXT_STEPS_NOTE,
  type CatalogScanOutcome,
  type OutcomeTone,
} from "../_lib/scan-task-copy";

/**
 * "新建目录扫描任务" block on `/catalog-sync` (PR-C2).
 *
 * This is the missing trigger for `createMoboreaderCatalogScanTask`
 * (`@/lib/tasks/moboreader`) — cold-start step 4. Unlike
 * `CreateContentDialog` above it, there is no dry-run-then-apply two-stage
 * flow inside one submission: `mode` here is a form field the operator picks
 * up front (default `dry_run`), and which Server Action gets called depends
 * on it — `dryRunCatalogScanTaskAction` or `applyCatalogScanTaskAction`, see
 * `../_actions.ts`. Both write a task row; `apply` is the one that, once
 * `NOVEL_CATALOG_SYNC_ALLOW_WRITE` is also on, actually lets the worker
 * persist upstream data.
 */

const DEFAULT_PAGE_SIZE = 20;

type FieldErrors = Partial<
  Record<"channelApp" | "channelAccount" | "pageStart" | "pageEnd" | "pageSize", string>
>;

type Stage =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "result"; readonly result: CatalogScanOutcome }
  | { readonly kind: "invalid_input"; readonly code: string }
  | { readonly kind: "access_denied"; readonly message: string };

const TONE_STYLE: Readonly<Record<OutcomeTone, string>> = Object.freeze({
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  info: "border-blue-200 bg-blue-50 text-blue-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-900",
});

/**
 * Codes `MoboreaderTaskInputError` (`@/lib/tasks/moboreader`) can throw that
 * this form can actually trigger. `request_token_required` / `actor_required`
 * / `request_id_required` / `mode_invalid` / `safety_max_pages_invalid` stay
 * in the fallback branch — this form never supplies those fields itself (the
 * action fills them server-side), so seeing one would mean an internal bug,
 * not a bad form entry.
 */
const INVALID_INPUT_COPY: Readonly<Record<string, string>> = Object.freeze({
  channel_account_required: "请选择渠道账户",
  channel_app_required: "请选择渠道应用",
  active_channel_binding_required:
    "所选渠道应用与渠道账户当前不是有效的启用绑定（可能刚被停用），请刷新页面后重试",
  page_start_invalid: "起始页码无效，请输入大于 0 的整数",
  page_end_invalid: "结束页码无效，请输入大于 0 的整数",
  page_size_invalid: "每页条数无效，请输入大于 0 的整数",
  page_range_invalid: "结束页码不能小于起始页码",
  page_size_exceeded: "每页条数超过上限",
});

function inputInvalidMessage(code: string): string {
  return INVALID_INPUT_COPY[code] ?? `输入无效（${code}），请刷新页面后重试`;
}

function FlagChecklist({ flags }: { flags: Extract<CatalogScanOutcome, { outcome: "created_disabled" }>["flags"] }) {
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {catalogScanFlagChecklist(flags).map((row) => (
        <li key={row.envName} data-testid={`flag-row-${row.envName}`} className="flex items-start gap-1.5">
          <span
            className={`mt-0.5 inline-flex shrink-0 rounded px-1.5 py-0.5 font-mono font-medium ${
              row.on ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
            }`}
          >
            {row.on ? "已开启" : "未开启"}
          </span>
          <span>
            <code>{row.envName}</code> — {row.note}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NextStepsNote({ taskId }: { taskId: string }) {
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
      <p>{CATALOG_SCAN_NEXT_STEPS_NOTE}</p>
      <pre className="mt-1.5 overflow-x-auto rounded bg-gray-900 px-2 py-1.5 text-[11px] text-gray-100">
        {catalogScanStatusQuery(taskId)}
      </pre>
    </div>
  );
}

function ResultPanel({ result }: { result: CatalogScanOutcome }) {
  const copy = describeCatalogScanOutcome(result);
  return (
    <div
      role={copy.tone === "danger" ? "alert" : "status"}
      data-testid={`scan-outcome-${result.outcome}`}
      className={`mt-3 rounded-lg border px-3 py-2 text-sm ${TONE_STYLE[copy.tone]}`}
    >
      <p className="font-medium">{copy.title}</p>
      <p className="mt-1">{copy.body}</p>
      {result.outcome === "created_disabled" && <FlagChecklist flags={result.flags} />}
      <NextStepsNote taskId={result.taskId} />
    </div>
  );
}

export function CatalogScanTriggerForm({
  channelApps,
  contentPublishGranted,
  contentPublishBlockedReason,
  maxPageSize,
  safetyMaxPages,
}: {
  channelApps: readonly ChannelAppScanOption[];
  contentPublishGranted: boolean;
  contentPublishBlockedReason: string | null;
  maxPageSize: number;
  safetyMaxPages: number;
}) {
  const firstApp = channelApps[0] ?? null;
  const [channelAppId, setChannelAppId] = useState(firstApp?.id ?? "");
  const [channelAccountId, setChannelAccountId] = useState(firstApp?.channelAccounts[0]?.id ?? "");
  const [pageStart, setPageStart] = useState("1");
  const [pageEnd, setPageEnd] = useState("1");
  const [pageSize, setPageSize] = useState(String(DEFAULT_PAGE_SIZE));
  const [mode, setMode] = useState<"dry_run" | "apply">("dry_run");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  const selectedApp = useMemo(
    () => channelApps.find((app) => app.id === channelAppId) ?? null,
    [channelApps, channelAppId],
  );
  const accountOptions = selectedApp?.channelAccounts ?? [];

  function onChannelAppChange(id: string) {
    setChannelAppId(id);
    const app = channelApps.find((candidate) => candidate.id === id);
    setChannelAccountId(app?.channelAccounts[0]?.id ?? "");
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!channelAppId) errors.channelApp = "请选择渠道应用";
    if (!channelAccountId) errors.channelAccount = "请选择渠道账户";

    const start = Number.parseInt(pageStart, 10);
    const end = Number.parseInt(pageEnd, 10);
    const size = Number.parseInt(pageSize, 10);

    if (!Number.isInteger(start) || start < 1) {
      errors.pageStart = "起始页码必须是大于 0 的整数";
    }
    if (!Number.isInteger(end) || end < 1) {
      errors.pageEnd = "结束页码必须是大于 0 的整数";
    }
    if (!errors.pageStart && !errors.pageEnd && end < start) {
      errors.pageEnd = "结束页码不能小于起始页码";
    }
    if (!Number.isInteger(size) || size < 1) {
      errors.pageSize = "每页条数必须是大于 0 的整数";
    } else if (size > maxPageSize) {
      errors.pageSize = `每页条数不能超过 ${maxPageSize}`;
    }
    return errors;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setStage({ kind: "submitting" });
    const action = mode === "apply" ? applyCatalogScanTaskAction : dryRunCatalogScanTaskAction;
    const result = await action({
      channelAccountId,
      channelAppId,
      pageStart: Number.parseInt(pageStart, 10),
      pageEnd: Number.parseInt(pageEnd, 10),
      pageSize: Number.parseInt(pageSize, 10),
      requestId: crypto.randomUUID(),
    });

    if (!result.ok) {
      setStage(
        result.kind === "invalid_input"
          ? { kind: "invalid_input", code: result.code }
          : { kind: "access_denied", message: errorEnvelopeCopy(result.envelope) },
      );
      return;
    }
    setStage({ kind: "result", result: result.data });
  }

  const applyBlocked = mode === "apply" && !contentPublishGranted;
  const submitting = stage.kind === "submitting";

  return (
    <section
      aria-labelledby="catalog-scan-trigger-heading"
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
    >
      <h2 id="catalog-scan-trigger-heading" className="text-sm font-semibold text-gray-900">
        新建目录扫描任务
      </h2>
      <p className="mt-1 text-xs text-gray-500">
        从渠道应用抓取上游目录页，写入待创建来源条目——这是冷启动链路的第 4 步。当前安全页数上限为{" "}
        {safetyMaxPages} 页，若请求页数超过该值，后台会自动截断到该范围内。
      </p>

      {channelApps.length === 0 ? (
        <p
          role="status"
          data-testid="catalog-scan-no-channel-apps"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          没有可用的活跃渠道应用（渠道、渠道账户、渠道应用需均为启用状态），请先在「渠道账户」页配置后再回来创建任务。
        </p>
      ) : (
        <form className="mt-3 space-y-3" onSubmit={onSubmit} noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">渠道应用</span>
              <select
                value={channelAppId}
                onChange={(event) => onChannelAppChange(event.target.value)}
                aria-label="渠道应用"
                aria-invalid={Boolean(fieldErrors.channelApp)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              >
                {channelApps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.channelName}（{app.channelCode}） · {app.sourceAppName}
                  </option>
                ))}
              </select>
              {fieldErrors.channelApp && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {fieldErrors.channelApp}
                </p>
              )}
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">渠道账户</span>
              <select
                value={channelAccountId}
                onChange={(event) => setChannelAccountId(event.target.value)}
                aria-label="渠道账户"
                aria-invalid={Boolean(fieldErrors.channelAccount)}
                disabled={accountOptions.length === 0}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
              >
                {accountOptions.length === 0 && <option value="">（该渠道下没有启用中的账户）</option>}
                {accountOptions.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.accountName}（{account.businessId}）
                  </option>
                ))}
              </select>
              {fieldErrors.channelAccount && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {fieldErrors.channelAccount}
                </p>
              )}
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">起始页</span>
              <input
                type="number"
                min={1}
                value={pageStart}
                onChange={(event) => setPageStart(event.target.value)}
                aria-label="起始页"
                aria-invalid={Boolean(fieldErrors.pageStart)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              {fieldErrors.pageStart && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {fieldErrors.pageStart}
                </p>
              )}
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">结束页</span>
              <input
                type="number"
                min={1}
                value={pageEnd}
                onChange={(event) => setPageEnd(event.target.value)}
                aria-label="结束页"
                aria-invalid={Boolean(fieldErrors.pageEnd)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              {fieldErrors.pageEnd && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {fieldErrors.pageEnd}
                </p>
              )}
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">每页条数</span>
              <input
                type="number"
                min={1}
                max={maxPageSize}
                value={pageSize}
                onChange={(event) => setPageSize(event.target.value)}
                aria-label="每页条数"
                aria-invalid={Boolean(fieldErrors.pageSize)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              {fieldErrors.pageSize && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {fieldErrors.pageSize}
                </p>
              )}
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">模式</span>
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as "dry_run" | "apply")}
                aria-label="模式"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              >
                <option value="dry_run">dry_run（试运行，不落地正式目录）</option>
                <option value="apply">apply（正式写入，需要 content:publish）</option>
              </select>
            </label>
          </div>

          {applyBlocked && contentPublishBlockedReason && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {contentPublishBlockedReason}
              <span className="ml-1 text-amber-700">仍可创建 dry_run 任务。</span>
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={submitting || applyBlocked}
              className={buttonClassName("primary")}
            >
              {submitting
                ? "创建中…"
                : mode === "apply"
                  ? "创建扫描任务（apply）"
                  : "创建扫描任务（dry_run）"}
            </button>
          </div>

          {stage.kind === "invalid_input" && (
            <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
              {inputInvalidMessage(stage.code)}
            </p>
          )}
          {stage.kind === "access_denied" && (
            <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
              {stage.message}
            </p>
          )}
          {stage.kind === "result" && <ResultPanel result={stage.result} />}
        </form>
      )}
    </section>
  );
}
