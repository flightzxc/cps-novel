"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import type {
  AdminCapabilityState,
  AdminHomepageNavCandidateView,
  AdminHomepageNavMutationResultView,
  AdminHomepageNavView,
} from "@/contracts";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { TagAuditLog } from "../../_components/tag-audit-log";

/**
 * v0.5.15 首页题材导航勾选面板（`/categories` 顶部）。
 *
 * 运营在这里一次勾选"哪些分类出现在前台首页的题材导航里"，点一次保存，整份名单（全站 15 个语种共用）
 * 一次替换。前台首页最终显示 = 这里勾选的 且 该语种有书的分类，顺序仍按分类自身排序号。
 *
 * 显示 / 可编辑的两个条件刻意分开：
 *   - 显示：页面已确认 `content:view` 且分类读开关开启（`granted && readEnabled`），**不看**分类写开关
 *     `FEATURE_P2_06_5_TAG_ADMIN_WRITE`——生产里它是关的，首页勾选不受它约束（方案决定 3）；
 *   - 可编辑：当前会话具备 `tag:manage`（含两步验证）。不具备时勾选框与按钮 disabled，并显示原因。
 *
 * 保存请求体：`visibleCanonicalTagIds`（保存后要勾的）+ `expectedVisibleCanonicalTagIds`（页面加载时看到的名单），
 * 服务端比对库里现值，不一致返回 409，不会悄悄覆盖别人刚改的名单。`requestId` 每次提交新生成，
 * header（`adminFetch` 的 `requestId` 选项）与 body 里的必须相同。
 */

const HOMEPAGE_NAV_PATH = "/api/admin/canonical-tags/homepage-nav";

function itemLabel(item: AdminHomepageNavCandidateView): string {
  const name = item.zhName ?? item.enName ?? item.slug;
  return `${name} · ${item.slug} · 英语 ${item.enBookCount} 本 · ${item.localeCount} 个语种有书`;
}

function visibleIdsOf(items: readonly AdminHomepageNavCandidateView[]): string[] {
  return items.filter((item) => item.isHomepageVisible).map((item) => item.id);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

export function HomepageNavPanel({
  data,
  tagManage,
}: {
  data: AdminHomepageNavView;
  tagManage: AdminCapabilityState;
}) {
  const router = useRouter();
  const serverVisible = visibleIdsOf(data.items);
  const serverKey = serverVisible.join("|");

  // `baseline` = 页面加载时看到的名单（保存时作为 expected 交给服务端）；`selected` = 当前勾选。
  const [baseline, setBaseline] = useState<ReadonlySet<string>>(() => new Set(serverVisible));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(serverVisible));
  const [syncedKey, setSyncedKey] = useState(serverKey);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string; code?: string } | null>(null);

  // 服务端数据变了（保存后的 router.refresh、手动刷新）→ 以服务端为准重置勾选与基线。
  // 用"渲染期调整 state"的写法，不用 effect，避免多一轮渲染闪烁。
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setBaseline(new Set(serverVisible));
    setSelected(new Set(serverVisible));
  }

  const blocked = capabilityBlockReason("tag:manage", tagManage);
  const editable = blocked === null;
  const dirty = !sameSet(selected, baseline);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    // 按面板里的显示顺序取，保证请求体稳定。
    const visibleCanonicalTagIds = data.items.filter((item) => selected.has(item.id)).map((item) => item.id);
    const expectedVisibleCanonicalTagIds = data.items.filter((item) => baseline.has(item.id)).map((item) => item.id);
    const requestId = crypto.randomUUID();
    setBusy(true);
    setNotice(null);
    const result = await adminFetch<AdminHomepageNavMutationResultView>(HOMEPAGE_NAV_PATH, {
      method: "PUT",
      requestId,
      body: { requestId, visibleCanonicalTagIds, expectedVisibleCanonicalTagIds },
    });
    setBusy(false);
    if (!result.ok) {
      // 文案只按稳定错误码查，不读服务端字符串（信封里本来就没有）。
      setNotice({ tone: "error", text: `保存失败：${errorEnvelopeCopy(result.envelope)}`, code: result.envelope.code });
      return;
    }
    setBaseline(new Set(visibleCanonicalTagIds));
    setNotice({ tone: "ok", text: "保存成功" });
    router.refresh();
  }

  return (
    <section
      className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
      data-testid="homepage-nav-panel"
      aria-labelledby="homepage-nav-title"
    >
      <div>
        <h2 id="homepage-nav-title" className="text-sm font-semibold text-gray-900">首页题材导航</h2>
        <p className="mt-1 text-sm text-gray-600" data-testid="homepage-nav-help">
          勾选的分类会出现在前台首页的题材导航里（各语种只显示其中有书的）；不影响分类页、页脚和站点地图。保存后刷新首页立即生效。
        </p>
      </div>

      {blocked && (
        <p
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="homepage-nav-blocked"
        >
          {blocked}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-700" data-testid="homepage-nav-count">
          已勾选 {selected.size} / 共 {data.items.length}
        </span>
        <button
          type="button"
          className={buttonClassName("secondary", "px-2 py-1 text-xs")}
          disabled={!editable || busy}
          onClick={() => setSelected(new Set(data.items.map((item) => item.id)))}
          data-testid="homepage-nav-select-all"
        >
          全选
        </button>
        <button
          type="button"
          className={buttonClassName("secondary", "px-2 py-1 text-xs")}
          disabled={!editable || busy}
          onClick={() => setSelected(new Set())}
          data-testid="homepage-nav-select-none"
        >
          全不选
        </button>
        <button
          type="button"
          className={buttonClassName("primary", "px-3 py-1 text-xs")}
          disabled={!editable || busy || !dirty}
          onClick={() => void save()}
          data-testid="homepage-nav-save"
        >
          {busy ? "保存中…" : "保存"}
        </button>
      </div>

      {notice && (
        <div
          role="status"
          data-testid="homepage-nav-notice"
          className={`rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          <p>{notice.text}</p>
          {/* 名单已被别人改过：只提供手动刷新，绝不自动重试同一份写入（会悄悄覆盖对方刚改的名单）。 */}
          {notice.tone === "error" && notice.code === "homepage_nav_conflict" && (
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

      {data.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-400" data-testid="homepage-nav-empty">没有启用中的分类</p>
      ) : (
        <ul className="grid max-h-96 gap-x-4 gap-y-1 overflow-y-auto rounded-lg border border-gray-100 p-2 sm:grid-cols-2">
          {data.items.map((item) => {
            const inputId = `homepage-nav-${item.id}`;
            return (
              <li key={item.id} className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  id={inputId}
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(item.id)}
                  disabled={!editable || busy}
                  onChange={() => toggle(item.id)}
                  data-testid={inputId}
                />
                <label htmlFor={inputId} className="break-words">{itemLabel(item)}</label>
              </li>
            );
          })}
        </ul>
      )}

      <details className="text-sm text-gray-600">
        <summary className="cursor-pointer select-none">最近保存记录</summary>
        <div className="mt-2">
          <TagAuditLog entries={data.audit} testId="homepage-nav-audit" emptyLabel="暂无保存记录" />
        </div>
      </details>
    </section>
  );
}
