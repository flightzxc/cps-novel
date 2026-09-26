"use client";
import { useEffect, useState } from "react";
import type { AdminCapabilityState } from "@/contracts";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { buttonClassName } from "@/components/ui/button";
import type { SitemapAdminState, SitemapRequestResult } from "@/contracts";

const labels: Record<string, string> = {
  pending: "已入队，等待执行", processing: "处理中", completed: "已完成", completed_with_errors: "完成但有错误",
  failed: "失败", paused: "已暂停", cancelled: "已取消", idle: "尚未刷新", running: "处理中", success: "成功",
};
export function SitemapCard({ settingsManage }: { settingsManage: AdminCapabilityState }) {
  const [state, setState] = useState<SitemapAdminState | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const allowed = settingsManage === "granted";
  useEffect(() => {
    if (!allowed) return;
    let mounted = true;
    const refresh = async () => {
      const result = await adminFetch<SitemapAdminState>("/api/admin/sitemap");
      if (!mounted) return;
      if (result.ok) setState(result.data);
      else setNotice("读取 Sitemap 状态失败，请稍后重试。");
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { mounted = false; clearInterval(timer); };
  }, [allowed]);
  async function enqueue() {
    setBusy(true);
    try {
      const result = await adminFetch<SitemapRequestResult>("/api/admin/sitemap", { method: "POST", body: { reason } });
      if (!result.ok) { setNotice("刷新请求失败，请检查权限并重试。"); return; }
      if (result.data.status === "disabled") { setNotice("Sitemap 刷新写闸未开启。"); return; }
      setNotice(result.data.status === "queued" ? "已入队，等待 worker 执行。" : "已合并至现有任务，等待执行结果。");
      const latest = await adminFetch<SitemapAdminState>("/api/admin/sitemap");
      if (latest.ok) setState(latest.data);
    } finally { setBusy(false); }
  }
  return <section className="mt-6 space-y-3 rounded-xl border border-gray-200 bg-white p-5" aria-label="Sitemap">
    <h2 className="text-base font-semibold">Sitemap</h2>
    {!allowed ? <p>需要站点设置管理权限。</p> : <>
      <p>任务状态：{state?.task ? labels[state.task.status] ?? state.task.status : "暂无任务"}</p>
      <p>最近生成结果：{state ? labels[state.lastGeneration.status] ?? state.lastGeneration.status : "读取中…"}{state?.lastGeneration.finishedAt ? `（${state.lastGeneration.finishedAt}）` : ""}</p>
      <p>当前收录数：{state?.published?.urlCount ?? "暂无发布记录"}{state?.published ? `（${state.published.generatedAt}）` : ""}</p>
      <p className="text-sm text-gray-500">刷新任务共用现有 worker；领取任务繁忙时需等待，提交不会立即生成。</p>
      {state && !state.enabled && <p>功能开关或写入许可未开启。</p>}
      <label className="block text-sm">刷新原因<input aria-label="Sitemap 刷新原因" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} className="ml-2 rounded border border-gray-300 p-2" /></label>
      <button type="button" className={buttonClassName("primary")} disabled={busy || !state?.enabled || !reason.trim()} onClick={() => void enqueue()}>{busy ? "提交中…" : "刷新 Sitemap"}</button>
      {notice && <p role="status">{notice}</p>}
    </>}
  </section>;
}
