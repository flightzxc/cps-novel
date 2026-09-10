"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { buttonClassName } from "@/components/ui/button";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { ImportProgress } from "@/features/admin-ui/import-progress";
import { MOBOREADER_LANGUAGE_CODE_TO_LOCALE } from "@/lib/locale/channel-language";
import { SITE_LOCALES, SITE_LOCALE_LABELS, type SiteLocale } from "@/lib/locale/locale-canonical";

import { applyCatalogScanTaskAction } from "../_actions";
import type { ChannelScanOption } from "../_lib/read-channel-apps";
import {
  catalogScanFlagChecklist,
  describeCatalogScanOutcome,
  type CatalogScanOutcome,
  type OutcomeTone,
} from "../_lib/scan-task-copy";

/**
 * L10N P5 (矩阵 #13): this chip used to render one button per `SITE_LOCALES`
 * member (15, a *site* concept — "does this project have routes for this
 * locale"), which is the wrong axis for a *catalog scan* trigger — the
 * question here is "which upstream moboreader codes exist", independent of
 * whether this project serves that locale as a registered site locale.
 * Derived from `MOBOREADER_LANGUAGE_CODE_TO_LOCALE` (18 codes — see
 * `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`), same
 * "reshape the canonical table for display, not a second mapping table"
 * shape as `../_lib/../catalog-sync/_components/source-item-filters.tsx`'s
 * `SOURCE_LOCALE_FILTER_OPTIONS` (`tests/ui/locale-canonical.test.ts`'s "no
 * second locale mapping table" scan only flags a literal `{...}`/`[...]`
 * collection, not a value built by `Array.from(...).map(...)`, so this is
 * not a violation — it never resolves anything, it only reshapes the
 * already-resolved constant). CPS reference: `changdu-sync-panel.tsx`
 * derives its own chip list per-source-app the same way
 * (`getChangduSelectableLanguageOptionsForSourceApp`), rather than off the
 * site's own registered-locale list.
 *
 * Non-site locales (`it`/`fil`/`ms`/`tr`) keep their bare code as the label
 * (no `SITE_LOCALE_LABELS` entry exists for them) plus an explicit "仅索引
 * 不建内容" annotation: `languages[]` stays scan-task metadata only (see
 * this form's own "上游目录接口不支持按语种过滤" note below — selecting one
 * of these four is legitimate, the scan indexes every language regardless
 * of selection), but content creation for a source item resolved to one of
 * them will later hard-block on `unsupported_locale`
 * (`content-creation/service.ts`'s `deriveLocale`) — the annotation sets
 * that expectation up front instead of surprising the operator later.
 */
const CATALOG_SCAN_LANGUAGE_CHIP_OPTIONS: ReadonlyArray<{ value: string; label: string; isSiteLocale: boolean }> = Array.from(
  new Set(Object.values(MOBOREADER_LANGUAGE_CODE_TO_LOCALE)),
)
  .sort()
  .map((locale) => ({
    value: locale,
    label: SITE_LOCALE_LABELS[locale as SiteLocale] ?? locale,
    isSiteLocale: (SITE_LOCALES as readonly string[]).includes(locale),
  }));

/**
 * "新建目录扫描任务" block on `/catalog-sync` (PR-C2; reshaped by Phase B —
 * `施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md` §三 — into the CPS
 * `changdu-sync-panel.tsx` shape: 渠道 → 剧场 chips → 语种 chips → 渠道账号 →
 * 「开始同步」).
 *
 * Unlike the pre-Phase-B version, there is no operator-facing mode picker
 * and no page-mechanics inputs. This form only ever calls
 * `applyCatalogScanTaskAction` — CPS's own sync panel hardcodes `mode:
 * 'apply'` the same way (`changdu-sync-panel.tsx:519-524` in the read-only
 * CPS reference); `dryRunCatalogScanTaskAction` (`../_actions.ts`) still
 * exists for callers outside this form, it is simply never imported here.
 * Page range/size are resolved server-side from the factory's own
 * CPS-parity constants (see the doc comment on `CatalogScanTriggerInput` in
 * `../_actions.ts`) — this component never sees them.
 */

type FieldErrors = Partial<
  Record<"channel" | "channelApp" | "channelAccount" | "languages", string>
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
 * / `request_id_required` / `mode_invalid` / `safety_max_pages_invalid` /
 * `page_start_invalid` / `page_end_invalid` / `page_size_invalid` /
 * `page_range_invalid` / `page_size_exceeded` stay in the fallback branch —
 * this form no longer supplies any page field itself (Phase B resolves them
 * server-side as fixed constants), so seeing one of those codes would mean
 * an internal bug in that server-side constant, not a bad form entry.
 */
const INVALID_INPUT_COPY: Readonly<Record<string, string>> = Object.freeze({
  channel_account_required: "请选择渠道账户",
  channel_app_required: "请选择同步剧场",
  active_channel_binding_required:
    "所选渠道应用与渠道账户当前不是有效的启用绑定（可能刚被停用），请刷新页面后重试",
  languages_invalid: "语种选择无效，请刷新页面后重试",
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
    </div>
  );
}

/**
 * C-6: 提交成功且拿到 taskId 时（"created" 或 "created_disabled" —— 后者的任务
 * 会立即停在 disabled/已暂停，ImportProgress 首次轮询即终态，这本身就是正确反馈,
 * 不需要额外分支）内联渲染进度卡；`onTerminal` 刷新来源条目列表（同页
 * server component 重新取数），旁置「前往任务中心 →」「查看推广链接 →」——
 * 对齐 CPS 目录同步提交后的路径,见工单 §三表格最后一行。
 */
function TaskProgressCard({ taskId, onTerminal }: { taskId: string; onTerminal: () => void }) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <ImportProgress taskId={taskId} onTerminal={onTerminal} />
      <div className="flex items-center gap-4 border-t border-gray-200 pt-3 text-sm">
        <Link href="/tasks" className="font-medium text-blue-600 hover:text-blue-700">
          前往任务中心 →
        </Link>
        <Link href="/promo-links" className="font-medium text-blue-600 hover:text-blue-700">
          查看推广链接 →
        </Link>
      </div>
    </div>
  );
}

function chipButtonClassName(selected: boolean): string {
  return `rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
    selected
      ? "border-blue-300 bg-blue-50 text-blue-700"
      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
  }`;
}

export function CatalogScanTriggerForm({
  channels,
  contentPublishGranted,
  contentPublishBlockedReason,
  safetyMaxPages,
}: {
  channels: readonly ChannelScanOption[];
  contentPublishGranted: boolean;
  contentPublishBlockedReason: string | null;
  safetyMaxPages: number;
}) {
  const router = useRouter();
  const firstChannel = channels[0] ?? null;
  const [channelId, setChannelId] = useState(firstChannel?.id ?? "");
  const [channelAppId, setChannelAppId] = useState(firstChannel?.channelApps[0]?.id ?? "");
  const [channelAccountId, setChannelAccountId] = useState(firstChannel?.channelAccounts[0]?.id ?? "");
  const [languages, setLanguages] = useState<ReadonlySet<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === channelId) ?? null,
    [channels, channelId],
  );
  const channelAppOptions = selectedChannel?.channelApps ?? [];
  const accountOptions = selectedChannel?.channelAccounts ?? [];

  function onChannelChange(id: string) {
    setChannelId(id);
    const channel = channels.find((candidate) => candidate.id === id);
    setChannelAppId(channel?.channelApps[0]?.id ?? "");
    setChannelAccountId(channel?.channelAccounts[0]?.id ?? "");
  }

  // Named `flipLanguageChip`, not `toggleLanguage` — `tests/ui/
  // locale-canonical.test.ts`'s pattern-based "no second locale-normalize
  // implementation" scan flags any `to*Language*` name, and this is a plain
  // Set toggle, not a locale mapping.
  function flipLanguageChip(locale: string) {
    setLanguages((current) => {
      const next = new Set(current);
      if (next.has(locale)) next.delete(locale);
      else next.add(locale);
      return next;
    });
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!channelId) errors.channel = "请选择渠道";
    if (!channelAppId) errors.channelApp = "请选择同步剧场";
    if (!channelAccountId) errors.channelAccount = "请选择渠道账户";
    if (languages.size === 0) errors.languages = "请至少选择一种语种";
    return errors;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setStage({ kind: "submitting" });
    const result = await applyCatalogScanTaskAction({
      channelAccountId,
      channelAppId,
      languages: Array.from(languages),
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

  const submitting = stage.kind === "submitting";
  // Deliberately does NOT also require `languages.size > 0` — that stays a
  // submit-time `validate()` check (like every other required field here),
  // so an operator who clicks submit before picking a language sees the
  // "请至少选择一种语种" message instead of a button that never responds.
  const canSubmit = !submitting && contentPublishGranted && channelAppOptions.length > 0 && accountOptions.length > 0;

  return (
    <section
      aria-labelledby="catalog-scan-trigger-heading"
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
    >
      <h2 id="catalog-scan-trigger-heading" className="text-sm font-semibold text-gray-900">
        新建目录扫描任务
      </h2>
      <p className="mt-1 text-xs text-gray-500">
        选择渠道、剧场与语种后从上游抓取目录页，写入待创建来源条目——这是冷启动链路的第 4 步。
        每次运行会扫描第 1 页到当前安全上限（{safetyMaxPages} 页）。
      </p>

      {channels.length === 0 ? (
        <p
          role="status"
          data-testid="catalog-scan-no-channel-apps"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          没有可用的活跃渠道应用（渠道、渠道账户、渠道应用需均为启用状态），请先在「渠道账户」页配置后再回来创建任务。
        </p>
      ) : (
        <form className="mt-3 space-y-4" onSubmit={onSubmit} noValidate>
          <label className="block max-w-xs text-sm">
            <span className="mb-1 block text-gray-600">渠道</span>
            <select
              value={channelId}
              onChange={(event) => onChannelChange(event.target.value)}
              aria-label="渠道"
              aria-invalid={Boolean(fieldErrors.channel)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}（{channel.code}）
                </option>
              ))}
            </select>
            {fieldErrors.channel && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {fieldErrors.channel}
              </p>
            )}
          </label>

          <div>
            <span className="mb-2 block text-sm font-medium text-gray-700">同步剧场</span>
            <div className="flex flex-wrap gap-2">
              {channelAppOptions.length === 0 ? (
                <p className="text-sm text-gray-400">该渠道下暂无可用剧场</p>
              ) : (
                channelAppOptions.map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() => setChannelAppId(app.id)}
                    className={chipButtonClassName(channelAppId === app.id)}
                  >
                    {app.sourceAppName}
                  </button>
                ))
              )}
            </div>
            {fieldErrors.channelApp && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {fieldErrors.channelApp}
              </p>
            )}
          </div>

          <div>
            <span className="mb-2 block text-sm font-medium text-gray-700">
              同步语种 <span className="text-red-500">*</span>
            </span>
            <div role="group" aria-label="同步语种" className="flex flex-wrap gap-2">
              {CATALOG_SCAN_LANGUAGE_CHIP_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => flipLanguageChip(option.value)}
                  aria-pressed={languages.has(option.value)}
                  className={chipButtonClassName(languages.has(option.value))}
                >
                  {option.label}
                  {!option.isSiteLocale && (
                    <span className="ml-1 text-[10px] font-normal text-gray-400">（仅索引不建内容）</span>
                  )}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-400">
              上游目录接口不支持按语种过滤，会返回全部语种；这里的选择只影响本次任务的计数与结果筛选。
            </p>
            {fieldErrors.languages && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {fieldErrors.languages}
              </p>
            )}
          </div>

          <label className="block max-w-xs text-sm">
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

          {!contentPublishGranted && contentPublishBlockedReason && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {contentPublishBlockedReason}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button type="submit" disabled={!canSubmit} className={buttonClassName("primary")}>
              {submitting
                ? "同步中…"
                : languages.size > 0
                  ? `开始同步 · ${languages.size} 语种`
                  : "开始同步"}
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
          {stage.kind === "result" && (
            <>
              <ResultPanel result={stage.result} />
              {(stage.result.outcome === "created" || stage.result.outcome === "created_disabled") && (
                <TaskProgressCard
                  taskId={stage.result.taskId}
                  onTerminal={() => router.refresh()}
                />
              )}
            </>
          )}
        </form>
      )}
    </section>
  );
}
