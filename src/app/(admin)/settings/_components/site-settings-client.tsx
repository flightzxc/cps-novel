"use client";

import { useState, type FormEvent } from "react";

import type { AdminCapabilityState } from "@/contracts";
import { buttonClassName } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusBadge } from "@/components/ui/status-badge";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import type { AdminSiteSettingView, SiteSettingMutationResult } from "../_lib/site-setting-types";

const SITE_SETTINGS_PATH = "/api/admin/site-settings";

type SiteSettingView = AdminSiteSettingView;

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

type Notice = { readonly tone: "ok" | "info" | "error"; readonly text: string };

/**
 * Site settings screen (PR-C4). Two independent sections — OG fallback image
 * and IndexNow delivery config — each with its own reason input and its own
 * submit, because the PATCH contract in
 * `@/server/site-settings/service.ts#normalizedPatch` is field-level: a
 * request only carries the keys `Object.prototype.hasOwnProperty` finds on
 * the body, and untouched fields are merged in server-side from the row that
 * was actually read. Sending every field on every submit — even unchanged
 * ones — would still be correct by that contract, but would make "什么改了"
 * unrecoverable from the audit trail's `beforeSnapshot`/`afterSnapshot`
 * diff, so this component tracks dirtiness per field and only includes keys
 * that differ from `current`.
 */
export function SiteSettingsClient({
  setting,
  settingsManage,
  expectedIndexNowHost,
  expectedIndexNowKeyLocation,
}: {
  setting: SiteSettingView | null;
  settingsManage: AdminCapabilityState;
  expectedIndexNowHost: string | null;
  expectedIndexNowKeyLocation: string | null;
}) {
  const blocked = capabilityBlockReason("settings:manage", settingsManage);

  const [current, setCurrent] = useState<SiteSettingView | null>(setting);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ogBusy, setOgBusy] = useState(false);
  const [indexNowBusy, setIndexNowBusy] = useState(false);
  const [ogImage, setOgImage] = useState(setting?.defaultOgImage ?? "");
  const [ogImageBroken, setOgImageBroken] = useState(false);
  const [ogReason, setOgReason] = useState("");
  const [indexNowHost, setIndexNowHost] = useState(setting?.indexNowHost ?? "");
  const [indexNowKey, setIndexNowKey] = useState(setting?.indexNowKey ?? "");
  const [indexNowKeyLocation, setIndexNowKeyLocation] = useState(setting?.indexNowKeyLocation ?? "");
  const [indexNowReason, setIndexNowReason] = useState("");

  // `settingsManage !== "granted"` and `setting === null` travel together —
  // the page never reads the row unless the capability is granted (see
  // `page.tsx`) — so this single guard covers both the blocked-capability
  // state and the defensive "page passed nothing" case, before any of the
  // hooks above are treated as holding real data.
  if (blocked || !current) {
    return (
      <div
        role="status"
        data-testid="settings-capability-denied"
        className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-10 text-center"
      >
        <p className="text-sm font-medium text-amber-900">
          {blocked ?? "站点设置读取失败，请刷新页面重试"}
        </p>
      </div>
    );
  }

  function applyServerSetting(next: SiteSettingView, section: "og" | "indexNow" | "all") {
    setCurrent(next);
    // Success only resets the section that was submitted, so an uncommitted
    // draft in the other section survives. A 409 refetch uses `"all"` because
    // the whole row is stale.
    if (section === "og" || section === "all") {
      setOgImage(next.defaultOgImage);
      setOgImageBroken(false);
    }
    if (section === "indexNow" || section === "all") {
      setIndexNowHost(next.indexNowHost);
      setIndexNowKey(next.indexNowKey);
      setIndexNowKeyLocation(next.indexNowKeyLocation);
    }
  }

  /** Re-reads the row after a 409 so the operator's next attempt starts from a fresh `expectedUpdatedAt`, not the stale one that just lost the race. */
  async function refetchAfterConflict() {
    const result = await adminFetch<SiteSettingView>(SITE_SETTINGS_PATH);
    if (result.ok) applyServerSetting(result.data, "all");
  }

  async function submitPatch(
    fields: Record<string, string>,
    reasonValue: string,
    expectedUpdatedAt: string,
    setBusy: (value: boolean) => void,
    clearReason: () => void,
    section: "og" | "indexNow",
  ) {
    setBusy(true);
    setNotice(null);
    const result = await adminFetch<SiteSettingMutationResult>(SITE_SETTINGS_PATH, {
      method: "PATCH",
      body: { expectedUpdatedAt, reason: reasonValue.trim(), ...fields },
    });
    setBusy(false);

    if (!result.ok) {
      setNotice({ tone: "error", text: errorEnvelopeCopy(result.envelope) });
      // `site_setting_conflict` covers both the plain optimistic-lock loss
      // and the (practically unreachable, since every submit mints a fresh
      // request id) idempotency-binding mismatch — either way the row the
      // form is holding is stale, so both refresh automatically rather than
      // making the operator guess that a manual reload is needed.
      if (result.envelope.code === "site_setting_conflict") await refetchAfterConflict();
      return;
    }

    applyServerSetting(result.data.setting, section);
    clearReason();
    setNotice(
      result.data.replayed
        ? { tone: "info", text: "该请求此前已生效，未重复写入" }
        : { tone: "ok", text: "已保存" },
    );
  }

  const ogTrimmed = ogImage.trim();
  const ogDirty = ogTrimmed !== current.defaultOgImage;
  const ogEmpty = current.defaultOgImage.trim().length === 0;
  const ogReasonFilled = ogReason.trim().length > 0;

  const hostTrimmed = indexNowHost.trim();
  const keyTrimmed = indexNowKey.trim();
  const keyLocationTrimmed = indexNowKeyLocation.trim();
  const indexNowDirty =
    hostTrimmed !== current.indexNowHost
    || keyTrimmed !== current.indexNowKey
    || keyLocationTrimmed !== current.indexNowKeyLocation;
  const indexNowReasonFilled = indexNowReason.trim().length > 0;
  const indexNowConfigured =
    current.indexNowHost.length > 0
    && current.indexNowKey.length > 0
    && current.indexNowKeyLocation.length > 0;

  async function handleOgSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current || !ogDirty || !ogReasonFilled) return;
    await submitPatch(
      { defaultOgImage: ogTrimmed },
      ogReason,
      current.updatedAt,
      setOgBusy,
      () => setOgReason(""),
      "og",
    );
  }

  async function handleIndexNowSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current || !indexNowDirty || !indexNowReasonFilled) return;
    const fields: Record<string, string> = {};
    if (hostTrimmed !== current.indexNowHost) fields.indexNowHost = hostTrimmed;
    if (keyTrimmed !== current.indexNowKey) fields.indexNowKey = keyTrimmed;
    if (keyLocationTrimmed !== current.indexNowKeyLocation) fields.indexNowKeyLocation = keyLocationTrimmed;
    await submitPatch(
      fields,
      indexNowReason,
      current.updatedAt,
      setIndexNowBusy,
      () => setIndexNowReason(""),
      "indexNow",
    );
  }

  function applyRecommendedIndexNowValues() {
    if (expectedIndexNowHost) setIndexNowHost(expectedIndexNowHost);
    if (expectedIndexNowKeyLocation) setIndexNowKeyLocation(expectedIndexNowKeyLocation);
  }

  return (
    <div className="space-y-6">
      {notice && (
        <p
          role="status"
          className={`rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : notice.tone === "info"
                ? "border-blue-200 bg-blue-50 text-blue-800"
                : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {notice.text}
        </p>
      )}

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-6">
        <div>
          <h2 className="text-base font-semibold text-gray-900">OG 兜底图</h2>
          <p className="mt-1 text-sm text-gray-500">
            首页与浏览页渲染 Open Graph 元信息时使用的默认封面图。
          </p>
        </div>

        {ogEmpty && (
          <p
            role="alert"
            data-testid="og-empty-warning"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            当前未配置 OG 兜底图：未配置将导致首页 / 浏览页无法访问（渲染时缺省失败，不是可选装饰项），请尽快填写。
          </p>
        )}

        <form onSubmit={handleOgSubmit} className="space-y-3" aria-label="保存 OG 兜底图">
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">图片地址</span>
            <input
              value={ogImage}
              onChange={(event) => {
                setOgImage(event.target.value);
                setOgImageBroken(false);
              }}
              placeholder="https://.../default-og.jpg"
              required
              className="w-full max-w-lg rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          {ogTrimmed && !ogImageBroken && (
            // 预览的是运营任意填写的外部图片地址，不是本仓库内的静态资源，
            // 不在 next/image 允许的 remote pattern 名单里，用原生 img 即可
            // （与 src/components/CoverImage.tsx 的先例一致）。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ogTrimmed}
              alt="OG 兜底图预览"
              onError={() => setOgImageBroken(true)}
              className="h-32 w-auto rounded-lg border border-gray-200 object-cover"
            />
          )}
          {ogTrimmed && ogImageBroken && (
            <p className="text-xs text-amber-700">图片加载失败，请确认地址可公网访问。</p>
          )}

          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">修改原因（必填，写入审计）</span>
            <input
              value={ogReason}
              onChange={(event) => setOgReason(event.target.value)}
              placeholder="例如：补齐首页兜底封面"
              required
              className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          <button
            type="submit"
            disabled={ogBusy || !ogDirty || !ogReasonFilled}
            className={buttonClassName("primary")}
          >
            保存 OG 兜底图
          </button>
        </form>
      </section>

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">IndexNow 推送配置</h2>
            <p className="mt-1 text-sm text-gray-500">
              这三个字段是启用 IndexNow 推送（部署开闸顺序第 7 步）的前置条件。
            </p>
          </div>
          <StatusBadge tone={indexNowConfigured ? "success" : "neutral"}>
            {indexNowConfigured ? "已配置" : "未配置"}
          </StatusBadge>
        </div>

        <ul className="list-disc space-y-1 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
          <li>
            host 必须与本部署 SITE_URL 的 host 完全一致
            {expectedIndexNowHost ? `（当前应为 ${expectedIndexNowHost}）` : "（当前部署未配置 SITE_URL，暂无法给出比对值）"}
            。
          </li>
          <li>
            keyLocation 必须指向本部署的 /indexnow-key.txt
            {expectedIndexNowKeyLocation ? `（即 ${expectedIndexNowKeyLocation}）` : ""}。
          </li>
          <li>三个字段必须同时留空（未配置）或同时填写，不能只填一部分。</li>
          <li>
            <span className="font-medium">填了这三个字段 ≠ 开启 IndexNow 推送</span>
            ——推送功能是否实际运行，由部署 env 的 Feature Flag 单独控制。
          </li>
        </ul>

        <form onSubmit={handleIndexNowSubmit} className="space-y-3" aria-label="保存 IndexNow 配置">
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">indexNowHost</span>
            <input
              value={indexNowHost}
              onChange={(event) => setIndexNowHost(event.target.value)}
              placeholder="example.com"
              className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">indexNowKey</span>
            <div className="flex max-w-md items-center gap-2">
              <input
                value={indexNowKey}
                onChange={(event) => setIndexNowKey(event.target.value)}
                placeholder="用于 IndexNow 验证的 key"
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
              />
              {current.indexNowKey && <CopyButton value={current.indexNowKey} />}
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">indexNowKeyLocation</span>
            <input
              value={indexNowKeyLocation}
              onChange={(event) => setIndexNowKeyLocation(event.target.value)}
              placeholder="https://example.com/indexnow-key.txt"
              className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          {(expectedIndexNowHost || expectedIndexNowKeyLocation) && (
            <button
              type="button"
              onClick={applyRecommendedIndexNowValues}
              className={buttonClassName("ghost", "px-2 py-1 text-xs")}
            >
              填入推荐值
            </button>
          )}

          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">修改原因（必填，写入审计）</span>
            <input
              value={indexNowReason}
              onChange={(event) => setIndexNowReason(event.target.value)}
              placeholder="例如：开通 IndexNow 推送前置配置"
              required
              className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          <button
            type="submit"
            disabled={indexNowBusy || !indexNowDirty || !indexNowReasonFilled}
            className={buttonClassName("primary")}
          >
            保存 IndexNow 配置
          </button>
        </form>
      </section>

      <p className="text-xs text-gray-400">最近更新：{formatTime(current.updatedAt)}</p>
    </div>
  );
}
